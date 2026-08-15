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

  const client = createDshrClient({ baseUrl: BASE_URL })
  await client.connect()
  const state = createState({ client })

  // 工作区要先存在——Shell 把新会话挂到它下面。
  const cwd = process.cwd()
  const workspaceId = await state.createWorkspace(cwd, 'dshr-e2e')

  // ⚠️ 必须盯住 **Shell 自己创建的那个会话**。
  // host 上可能已经有别的会话（开发机上通常有一堆），拿 `sessions.keys()[0]`
  // 会抓到无关的旧会话——而它的标题恰好也会出现在侧栏里，于是「帧里有回答」
  // 这条断言会被侧栏标题满足，测试假绿。踩过。
  // `state` 是类实例，原型方法不在自身可枚举属性上——**不能用 `{...state}` 做代理**
  // （那样 `state.conversation is not a function`）。逐个显式委托。
  const created: SessionId[] = []
  const spied: DshrState = {
    get sessions() {
      return state.sessions
    },
    get workspaces() {
      return state.workspaces
    },
    subscribe: (listener) => state.subscribe(listener),
    conversation: (id) => state.conversation(id),
    projections: (id) => state.projections(id),
    createWorkspace: (path, title) => state.createWorkspace(path, title),
    createSession: async (input) => {
      const id = await state.createSession(input)
      created.push(id)
      return id
    },
    prompt: (id, text) => state.prompt(id, text),
    cancel: (id) => state.cancel(id),
    answerApproval: (id, outcome) => state.answerApproval(id, outcome),
    answerQuestion: (id, answers) => state.answerQuestion(id, answers),
    dispose: () => state.dispose(),
  }

  const components = buildShellComponents({ state: spied, client })
  const app = render(
    h(Shell, { state: spied, components, workspaceId: String(workspaceId), cwd }),
  )

  t.after(async () => {
    app.unmount()
    await state.dispose()
    await client.close()
  })

  // 1) 侧栏先出现工作区。
  await waitForFrame(app.lastFrame, (f) => f.includes('dshr-e2e'))

  // 2) Shell 启动会给第一个 pane 开一个会话——那是一次 RPC，要等它回来。
  await waitForFrame(
    () => String(created.length),
    (n) => Number(n) > 0,
    30_000,
  )
  assert.equal(created.length, 1, 'Shell 启动应恰好开一个会话')
  const sessionId = created[0]!

  // 3) 先把会话视图打开——TUI 里 pane 本来就是开着的，流式增量要有人在听。
  const conversation = state.conversation(sessionId)
  const assistantText = () =>
    conversation.items
      .filter((item) => item.kind === 'assistant')
      .map((item) => (item.kind === 'assistant' ? item.text : ''))
      .join('')

  // 4) 提交一句话。走 state.prompt——与 Composer 的 onSubmit 是同一条路径。
  await state.prompt(sessionId, 'Reply with exactly one short sentence.')

  // 5) 会话应该先转成 working。
  await waitForFrame(
    () => state.sessions.get(sessionId)?.status ?? '',
    (s) => s === 'working',
    30_000,
  )

  // 6) 回答要被折进会话视图。
  //    断言用 mock 的 --text 里一个**不会与界面其它文字撞车**的词：
  //    单用 "mock" 会匹配到状态行里的模型名 `mock-model`，那是假阳性。
  await waitForFrame(assistantText, (t) => /backoff/i.test(t), 30_000)

  // 7) 而且要真的出现在**渲染帧**里，不只是 state 里。
  const frame = await waitForFrame(app.lastFrame, (f) => /backoff/i.test(f), 30_000)
  assert.match(frame, /backoff/i)

  // 8) 一轮结束后回到 idle。
  await waitForFrame(
    () => state.sessions.get(sessionId)?.status ?? '',
    (s) => s === 'idle',
    30_000,
  )

  assert.ok(assistantText().length > 0, '助手消息应该有内容')
})
