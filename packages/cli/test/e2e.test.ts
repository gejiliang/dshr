/**
 * 端到端：渲染**完整的 Shell**（真 client + 真 state + 真 tui 组件）打一台真 dsh host，
 * 提交一句话，断言流式回答落进渲染帧里。
 *
 * 这是唯一一条同时穿过 protocol → state → tui → shell → cli 五个包的测试。
 * 单测证明各包自洽，只有这条证明它们**装在一起是通的**。
 *
 * 需要一台 host（零凭据起法见 docs/profile.md）：
 *   node tools/mock-llm.mjs --port 8100 --text "…"
 *   MOCK_API_KEY=mock-key DSH_HOME=/tmp/dshhome npx @deepseek-ai/dsh@0.1.0-rc.6 web --port 39081
 *
 * host 不可达时整条 skip——别人在别的机器上跑测试不该红。
 */
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import test from 'node:test'
import { createElement as h } from 'react'
import { render } from 'ink-testing-library'
import { createDshrClient } from '@dshr/protocol'
import { createState, type DshrState, type SessionId } from '@dshr/state'
import { Shell } from '@dshr/shell'
import { buildShellComponents } from '../lib/assemble.js'

const BASE_URL = process.env.DSHR_TEST_HOST ?? 'http://127.0.0.1:39081'

async function hostReachable(): Promise<boolean> {
  try {
    const response = await fetch(new URL('/api/host.describe', BASE_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'probe',
        method: 'host.describe',
        payload: {},
      }),
      signal: AbortSignal.timeout(2000),
    })
    return response.ok
  } catch {
    return false
  }
}

/** 轮询渲染帧直到断言成立或超时。Ink 是异步渲染的，不能读一次就断言。 */
async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let seen = ''
  while (Date.now() < deadline) {
    seen = lastFrame() ?? ''
    if (predicate(seen)) return seen
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`frame never satisfied predicate within ${timeoutMs}ms; last frame:\n${seen}`)
}

test('端到端：Shell 连真 host，提交一句话，流式回答出现在渲染帧里', async (t) => {
  if (!(await hostReachable())) {
    t.skip(`no dsh host at ${BASE_URL} — see docs/profile.md for a keyless one`)
    return
  }

  // ⚠️ 清理必须在**任何可能抛错的语句之前**注册。
  // 否则中途一抛，client 的 socket 和 ink 的 render 都还开着，进程退不出，
  // node:test 于是永远打不出失败详情——看起来像卡死，实际是错误被藏住了。踩过。
  const client = createDshrClient({ baseUrl: BASE_URL })
  let app: ReturnType<typeof render> | undefined
  let state: ReturnType<typeof createState> | undefined
  t.after(async () => {
    app?.unmount()
    await state?.dispose()
    await client.close()
  })

  await client.connect()
  state = createState({ client })
  const st = state

  // 工作区要先存在——Shell 把新会话挂到它下面。
  // 标题按路径派生：`createWorkspace` 对已有路径是幂等的（不改标题），
  // 但**新建**时标题在 host 上是全局唯一的，写死一个名字会跟别处的工作区撞。
  const cwd = process.cwd()
  const workspaceId = await st.createWorkspace(cwd, `dshr-e2e ${basename(cwd)}`)

  // ⚠️ 必须盯住 **Shell 自己创建的那个会话**。
  // host 上可能已经有别的会话（开发机上通常有一堆），拿 `sessions.keys()[0]`
  // 会抓到无关的旧会话——而它的标题恰好也会出现在侧栏里，于是「帧里有回答」
  // 这条断言会被侧栏标题满足，测试假绿。踩过。
  // `state` 是类实例，原型方法不在自身可枚举属性上——**不能用 `{...state}` 做代理**
  // （那样 `state.conversation is not a function`）。逐个显式委托。
  const created: SessionId[] = []
  const spied: DshrState = {
    get sessions() {
      return st.sessions
    },
    get workspaces() {
      return st.workspaces
    },
    subscribe: (listener) => st.subscribe(listener),
    conversation: (id) => st.conversation(id),
    projections: (id) => st.projections(id),
    createWorkspace: (path, title) => st.createWorkspace(path, title),
    createSession: async (input) => {
      const id = await st.createSession(input)
      created.push(id)
      return id
    },
    prompt: (id, text) => st.prompt(id, text),
    cancel: (id) => st.cancel(id),
    answerApproval: (id, outcome) => st.answerApproval(id, outcome),
    answerQuestion: (id, answers) => st.answerQuestion(id, answers),
    dispose: () => st.dispose(),
  }

  const components = buildShellComponents({ state: spied, client })
  app = render(
    h(Shell, { state: spied, components, initialWorkspaceId: String(workspaceId), cwd }),
  )
  const ui = app

  // 1) 侧栏先出现工作区。用工作区的**实际标题**（可能是已有工作区的旧标题），
  //    不要用我们请求的那个——`createWorkspace` 命中已有路径时不会改标题。
  const workspaceTitle =
    st.workspaces.find((w) => String(w.workspaceId) === String(workspaceId))?.title ??
    basename(cwd)
  await waitForFrame(ui.lastFrame, (f) => f.includes(workspaceTitle), 30_000)

  // 2) Shell 启动会给第一个 pane 开一个会话——那是一次 RPC，要等它回来。
  await waitForFrame(
    () => String(created.length),
    (n) => Number(n) > 0,
    30_000,
  )
  assert.equal(created.length, 1, 'Shell 启动应恰好开一个会话')
  const sessionId = created[0]!

  // 3) 先把会话视图打开——TUI 里 pane 本来就是开着的，流式增量要有人在听。
  const conversation = st.conversation(sessionId)
  const assistantText = () =>
    conversation.items
      .filter((item) => item.kind === 'assistant')
      .map((item) => (item.kind === 'assistant' ? item.text : ''))
      .join('')

  // 4) 提交一句话。走 state.prompt——与 Composer 的 onSubmit 是同一条路径。
  await st.prompt(sessionId, 'Reply with exactly one short sentence.')

  // 5) 会话应该先转成 working。
  await waitForFrame(
    () => st.sessions.get(sessionId)?.status ?? '',
    (s) => s === 'working',
    30_000,
  )

  // 6) 回答要被折进会话视图。
  //    断言用 mock 的 --text 里一个**不会与界面其它文字撞车**的词：
  //    单用 "mock" 会匹配到状态行里的模型名 `mock-model`，那是假阳性。
  await waitForFrame(assistantText, (t) => /backoff/i.test(t), 30_000)

  // 7) 而且要真的出现在**渲染帧**里，不只是 state 里。
  const frame = await waitForFrame(ui.lastFrame, (f) => /backoff/i.test(f), 30_000)
  assert.match(frame, /backoff/i)

  // 8) 一轮结束后回到 idle。
  await waitForFrame(
    () => st.sessions.get(sessionId)?.status ?? '',
    (s) => s === 'idle',
    30_000,
  )

  assert.ok(assistantText().length > 0, '助手消息应该有内容')
})
