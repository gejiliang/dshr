#!/usr/bin/env node
/**
 * 把 dshr 连上一台**真的** dsh host，发一句话，然后把渲染出来的那一帧打到 stdout。
 *
 * 和 `tools/preview.mjs` 的区别：preview 用假数据，这个是真的——真 client、真 state、
 * 真会话、真流式回答。用来肉眼确认「装在一起之后长什么样」。
 *
 *   node tools/mock-llm.mjs --port 8100 --text "…"
 *   MOCK_API_KEY=mock-key DSH_HOME=/tmp/dshhome npx @deepseek-ai/dsh@0.1.0-rc.6 web --port 39081
 *   node tools/demo-live.mjs [baseUrl]
 */
import { createElement as h } from 'react'
import { render } from 'ink-testing-library'
import { createDshrClient } from '@dshr/protocol'
import { createState } from '@dshr/state'
import { Shell } from '@dshr/shell'
import { buildShellComponents } from 'dshr'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:39081'
const cwd = process.cwd()

const client = createDshrClient({ baseUrl })
await client.connect()
const state = createState({ client })

const workspaceId = await state.createWorkspace(cwd, 'dshr')

// 盯住 Shell **自己**创建的那个会话。host 上通常还有别的会话，
// 拿 sessions.keys()[0] 会抓到无关的旧会话（它的标题还会出现在侧栏里，看着像成功了）。
// state 是类实例，别用 {...state} 代理——原型方法拷不过来。
const created = []
const spied = {
  get sessions() {
    return state.sessions
  },
  get workspaces() {
    return state.workspaces
  },
  subscribe: (l) => state.subscribe(l),
  conversation: (id) => state.conversation(id),
  projections: (id) => state.projections(id),
  createWorkspace: (p, t) => state.createWorkspace(p, t),
  createSession: async (input) => {
    const id = await state.createSession(input)
    created.push(id)
    return id
  },
  prompt: (id, text) => state.prompt(id, text),
  cancel: (id) => state.cancel(id),
  answerApproval: (id, o) => state.answerApproval(id, o),
  answerQuestion: (id, a) => state.answerQuestion(id, a),
  dispose: () => state.dispose(),
}

const components = buildShellComponents({ state: spied, client })
const app = render(h(Shell, { state: spied, components, workspaceId: String(workspaceId), cwd }))

const until = async (predicate, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

await until(() => created.length > 0)
const sessionId = created[0]
const conversation = state.conversation(sessionId)

await state.prompt(sessionId, '把 protocol 包的重连逻辑改成指数退避，上界 10 秒。')
await until(() => state.sessions.get(sessionId)?.status === 'idle', 60_000)
// 让 ink 把最后一帧画完
await new Promise((r) => setTimeout(r, 300))

console.log('\n'.repeat(2))
console.log(app.lastFrame())
const prompt = '把 protocol 包的重连逻辑改成指数退避，上界 10 秒。'
const inLast = (app.lastFrame() ?? '').includes(prompt)
const inAny = app.frames.some((f) => f.includes(prompt))
console.log('\n── 观测 ──')
console.log(`用户提示出现在 lastFrame : ${inLast}`)
console.log(`用户提示出现在任一帧      : ${inAny}   (frames: ${app.frames.length})`)
console.log('注：tui 的 Conversation 把已完成消息放进 ink <Static>，')
console.log('    而 ink-testing-library 的 lastFrame() 不含 Static 输出——真终端里是打印的。')

console.log('\n── state ──')
console.log(`sessions   : ${state.sessions.size}`)
console.log(`workspaces : ${state.workspaces.map((w) => w.title).join(', ')}`)
console.log(`status     : ${state.sessions.get(sessionId)?.status}`)
console.log(`items      : ${conversation.items.map((i) => i.kind).join(', ')}`)

app.unmount()
await state.dispose()
await client.close()
process.exit(0)
