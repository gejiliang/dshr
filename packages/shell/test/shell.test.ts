/**
 * Shell 集成测试：假 tui 组件替身 + 假 DshrState，
 * 验证「新建 tab/pane 默认开会话」与「前缀键被消费、普通键透传到输入框」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.FORCE_COLOR = '1'

const { render } = await import('ink-testing-library')
const { useInput, Text } = await import('ink')
const { createElement: h, useState } = await import('react')
const { Shell } = await import('../lib/Shell.js')

/** 打字后等一拍让 Promise / setState 落定。 */
const tick = () => new Promise((r) => setTimeout(r, 30))

interface Probe {
  createSessionCalls: number
  /** [sessionId, 输入] —— 按 pane 分清是谁收到的。 */
  composerInput: Array<[string, string]>
  prompts: Array<[string, string]>
}

function makeFakeState(probe: Probe) {
  const sessions = new Map<string, { sessionId: string; status: string; blank: boolean }>()
  return {
    sessions,
    workspaces: [{ workspaceId: 'ws-1', title: 'dshr', path: '/tmp/dshr', sessionIds: [] }],
    subscribe: () => () => {},
    conversation: () => ({ items: [], status: 'idle', hasOlder: false, loadOlder: async () => {}, subscribe: () => () => {} }),
    createSession: async () => {
      probe.createSessionCalls += 1
      const id = `sess-${probe.createSessionCalls}`
      sessions.set(id, { sessionId: id, status: 'idle', blank: true })
      return id
    },
    prompt: async (sid: string, text: string) => {
      probe.prompts.push([sid, text])
    },
  }
}

function makeComponents(probe: Probe) {
  const Conversation = () => h(Text, null, 'CONV')
  const Composer = ({ sessionId, focused, onSubmit }: { sessionId: string; focused: boolean; onSubmit: (t: string) => void }) => {
    useInput(
      (input, key) => {
        if (key.ctrl) return // 契约：Ctrl 组合键是 shell 前缀层的领域
        probe.composerInput.push([sessionId, input])
        if (input === '\r') onSubmit(input)
      },
      { isActive: focused },
    )
    return h(Text, null, focused ? 'COMPOSER*' : 'composer')
  }
  const StatusLine = ({ prefixPending, tabCount }: { prefixPending: boolean; tabCount: number }) =>
    h(Text, null, `tabs=${tabCount}${prefixPending ? ' PREFIX' : ''}`)
  const PendingPrompt = () => h(Text, null, 'PENDING')
  return { Conversation, Composer, StatusLine, PendingPrompt }
}

test('启动即开第一个 tab 并自动开第一个会话', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  render(h(Shell as never, { state: makeFakeState(probe), components: makeComponents(probe), initialWorkspaceId: 'ws-1' }))
  await tick()
  assert.equal(probe.createSessionCalls, 1, '新 tab 默认开新会话')
})

test('Ctrl-B c：前缀被消费（不进输入框），新 tab 连带新会话', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin, lastFrame } = render(
    h(Shell as never, { state: makeFakeState(probe), components: makeComponents(probe), initialWorkspaceId: 'ws-1' }),
  )
  await tick()
  assert.equal(probe.createSessionCalls, 1)

  stdin.write('\x02') // Ctrl-B
  await tick()
  assert.ok((lastFrame() ?? '').includes('PREFIX'), '状态行提示前缀已按下')
  stdin.write('c')
  await tick()
  assert.equal(probe.createSessionCalls, 2, '新 tab 自动开会话')
  assert.ok((lastFrame() ?? '').includes('tabs=2'))
  assert.deepEqual(probe.composerInput, [], '前缀序列一个键都没漏进输入框')
})

test('Ctrl-B % / "：分割出新 pane 并各自开会话', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin } = render(
    h(Shell as never, { state: makeFakeState(probe), components: makeComponents(probe), initialWorkspaceId: 'ws-1' }),
  )
  await tick()
  stdin.write('\x02')
  stdin.write('%')
  await tick()
  stdin.write('\x02')
  stdin.write('"')
  await tick()
  assert.equal(probe.createSessionCalls, 3, '初始 1 + 两次分割各 1')
})

test('非前缀按键透传给聚焦 pane 的输入框，回车触发 prompt', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin } = render(
    h(Shell as never, { state: makeFakeState(probe), components: makeComponents(probe), initialWorkspaceId: 'ws-1' }),
  )
  await tick()
  stdin.write('hi')
  await tick()
  assert.equal(probe.composerInput.map(([, i]) => i).join(''), 'hi')
  stdin.write('\r')
  await tick()
  assert.equal(probe.prompts.length, 1)
  assert.equal(probe.prompts[0]?.[0], 'sess-1')
})

test('Ctrl-B s 开关侧栏', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin, lastFrame } = render(
    h(Shell as never, { state: makeFakeState(probe), components: makeComponents(probe), initialWorkspaceId: 'ws-1' }),
  )
  await tick()
  assert.ok((lastFrame() ?? '').includes('工作区'), '侧栏默认开')
  stdin.write('\x02')
  stdin.write('s')
  await tick()
  assert.ok(!(lastFrame() ?? '').includes('工作区'), '侧栏已关')
  stdin.write('\x02')
  stdin.write('s')
  await tick()
  assert.ok((lastFrame() ?? '').includes('工作区'), '侧栏再开')
})

test('两个 pane 同时挂载：打字只落进焦点 pane 的 Composer', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin } = render(
    h(Shell as never, { state: makeFakeState(probe), components: makeComponents(probe), initialWorkspaceId: 'ws-1' }),
  )
  await tick()
  stdin.write('\x02')
  stdin.write('%') // 竖分；焦点移到新 pane（sess-2）
  await tick()
  assert.equal(probe.createSessionCalls, 2)
  probe.composerInput.length = 0
  stdin.write('k')
  await tick()
  assert.deepEqual(probe.composerInput, [['sess-2', 'k']], '只有焦点 pane 收到键')
})
