/**
 * 工作区管理集成测试：假 state + 假 tui 组件替身，ink-testing-library 驱动。
 * 覆盖：Ctrl-B w 选择器（切换 / 取消 / 切回 tab 保留）、Ctrl-B W 新建（含失败反馈）、
 * 新 tab/pane 的会话挂到当前活动工作区。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.FORCE_COLOR = '1'

const { render } = await import('ink-testing-library')
const { useInput, Text } = await import('ink')
const { createElement: h } = await import('react')
const { Shell } = await import('../lib/Shell.js')
const { Sidebar } = await import('../lib/Sidebar.js')

/** 打字后等一拍让 Promise / setState 落定。 */
const tick = () => new Promise((r) => setTimeout(r, 30))

interface Probe {
  createSessionCalls: Array<{ cwd: string; workspaceId?: string }>
  createWorkspaceCalls: string[]
  prompts: Array<[string, string]>
  composerInput: Array<[string, string]>
}

function makeState(probe: Probe) {
  const sessions = new Map<string, { sessionId: string; status: string; blank: boolean }>()
  const workspaces = [
    { workspaceId: 'ws-1', title: 'alpha', path: '/tmp/alpha', sessionIds: [] as string[] },
    { workspaceId: 'ws-2', title: 'beta', path: '/tmp/beta', sessionIds: [] as string[] },
  ]
  return {
    sessions,
    workspaces,
    subscribe: () => () => {},
    conversation: () => ({ items: [], status: 'idle', hasOlder: false, loadOlder: async () => {}, subscribe: () => () => {} }),
    createSession: async (input: { cwd: string; workspaceId?: string }) => {
      probe.createSessionCalls.push({
        cwd: input.cwd,
        ...(input.workspaceId !== undefined ? { workspaceId: String(input.workspaceId) } : {}),
      })
      const id = `sess-${probe.createSessionCalls.length}`
      sessions.set(id, { sessionId: id, status: 'idle', blank: true })
      const ws = workspaces.find((w) => input.workspaceId !== undefined && w.workspaceId === String(input.workspaceId))
      if (ws) ws.sessionIds.push(id)
      return id
    },
    createWorkspace: async (path: string) => {
      probe.createWorkspaceCalls.push(path)
      if (path === '/bad') {
        throw new Error('workspace.create failed: workspace-invalid-path: 路径不存在')
      }
      const id = `ws-${workspaces.length + 1}`
      workspaces.push({ workspaceId: id, title: path, path, sessionIds: [] })
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

function setup(probe: Probe) {
  return render(
    h(Shell as never, {
      state: makeState(probe),
      components: makeComponents(probe),
      initialWorkspaceId: 'ws-1',
    }),
  )
}

/** Ctrl-B <key>：前缀与后续键分两拍（见 components.ts 的键位分层契约）。 */
async function prefix(stdin: { write: (s: string) => void }, key: string): Promise<void> {
  stdin.write('\x02')
  await tick()
  stdin.write(key)
}

test('Ctrl-B w 打开选择器；esc 取消，活动工作区不变', async () => {
  const probe: Probe = { createSessionCalls: [], createWorkspaceCalls: [], prompts: [], composerInput: [] }
  const { stdin, lastFrame } = setup(probe)
  await tick()

  await prefix(stdin, 'w')
  await tick()
  const frameOpen = lastFrame() ?? ''
  assert.ok(frameOpen.includes('选择工作区'), '选择器已打开')
  assert.ok(frameOpen.includes('alpha') && frameOpen.includes('beta'), '两个工作区都列出来')

  stdin.write('\x1b') // esc
  await tick()
  assert.ok(!(lastFrame() ?? '').includes('选择工作区'), 'esc 关掉选择器')
  assert.ok((lastFrame() ?? '').includes('● alpha'), '仍在 ws-1（侧栏标记没变）')
})

test('选择器：数字键 + enter 切换活动工作区，侧栏标记跟着走', async () => {
  const probe: Probe = { createSessionCalls: [], createWorkspaceCalls: [], prompts: [], composerInput: [] }
  const { stdin, lastFrame } = setup(probe)
  await tick()

  await prefix(stdin, 'w')
  await tick()
  stdin.write('2') // 高亮 beta
  stdin.write('\r') // 确认
  await tick()
  const frame = lastFrame() ?? ''
  assert.ok(frame.includes('● beta'), '活动工作区切到 ws-2')
  assert.ok(!frame.includes('● alpha'), 'ws-1 不再是活动工作区')
  assert.ok(!frame.includes('选择工作区'), '选择器已关')
})

test('切走再切回：原工作区的 tab（含 pane 焦点）原封不动', async () => {
  const probe: Probe = { createSessionCalls: [], createWorkspaceCalls: [], prompts: [], composerInput: [] }
  const { stdin, lastFrame } = setup(probe)
  await tick()
  assert.ok((lastFrame() ?? '').includes('tabs=1'), 'ws-1 启动即 1 个 tab')

  await prefix(stdin, 'c') // ws-1 第二个 tab
  await tick()
  assert.ok((lastFrame() ?? '').includes('tabs=2'))

  // 切到 ws-2：没有 tab，开一个
  await prefix(stdin, 'w')
  await tick()
  stdin.write('2')
  stdin.write('\r')
  await tick()
  assert.ok((lastFrame() ?? '').includes('tabs=0'), 'ws-2 视角下没有 tab')
  await prefix(stdin, 'c')
  await tick()
  assert.ok((lastFrame() ?? '').includes('tabs=1'), 'ws-2 开了 1 个 tab')

  // 切回 ws-1：原来的两个 tab 都在
  await prefix(stdin, 'w')
  await tick()
  stdin.write('1')
  stdin.write('\r')
  await tick()
  assert.ok((lastFrame() ?? '').includes('tabs=2'), '切回来 tab 全在')

  // 更厚一层：活跃 tab（tab-2）与其 pane 焦点也被记住了——
  // 打字落进它的 composer，prompt 发给 sess-2（ws-1 第二个会话）
  probe.composerInput.length = 0
  stdin.write('x')
  stdin.write('\r')
  await tick()
  assert.deepEqual(probe.composerInput, [['sess-2', 'x'], ['sess-2', '\r']])
  assert.equal(probe.prompts.length, 1, '只有焦点 pane 的输入框提交')
  assert.equal(probe.prompts[0]?.[0], 'sess-2', 'prompt 发给切回前那个活跃 tab 的会话')
})

test('新建 tab / pane 的会话都挂到当前活动工作区', async () => {
  const probe: Probe = { createSessionCalls: [], createWorkspaceCalls: [], prompts: [], composerInput: [] }
  const { stdin } = setup(probe)
  await tick()

  await prefix(stdin, 'c') // ws-1 第二个 tab
  await tick()
  await prefix(stdin, 'v') // ws-1 分割 pane（herdr 键位）
  await tick()

  await prefix(stdin, 'w')
  await tick()
  stdin.write('2')
  stdin.write('\r')
  await tick()
  await prefix(stdin, 'c') // ws-2 新 tab
  await tick()
  await prefix(stdin, '-') // ws-2 分割 pane（herdr 键位）
  await tick()

  assert.deepEqual(
    probe.createSessionCalls.map((c) => c.workspaceId),
    ['ws-1', 'ws-1', 'ws-1', 'ws-2', 'ws-2'],
    '每个会话都挂在当时活动的工作区下',
  )
})

test('Ctrl-B N：失败的业务错误亮在覆盖层里，不静默', async () => {
  const probe: Probe = { createSessionCalls: [], createWorkspaceCalls: [], prompts: [], composerInput: [] }
  const { stdin, lastFrame } = setup(probe)
  await tick()

  await prefix(stdin, 'N')
  await tick()
  assert.ok((lastFrame() ?? '').includes('新建工作区'), '输入框已打开')

  stdin.write('/bad')
  await tick()
  assert.deepEqual(probe.composerInput, [], '覆盖层开着时键不漏进 pane 的输入框')
  stdin.write('\r')
  await tick()
  const frame = lastFrame() ?? ''
  assert.ok(frame.includes('⚠'), '错误有可见标记')
  assert.ok(frame.includes('workspace-invalid-path'), 'host 的业务错误码原样可见')
  assert.ok(frame.includes('新建工作区'), '覆盖层还在，可以改了再试')
  assert.deepEqual(probe.createWorkspaceCalls, ['/bad'])

  stdin.write('\x1b') // esc 收掉
  await tick()
  assert.ok(!(lastFrame() ?? '').includes('新建工作区'))
})

test('Ctrl-B N：成功后切过去并自动开新会话', async () => {
  const probe: Probe = { createSessionCalls: [], createWorkspaceCalls: [], prompts: [], composerInput: [] }
  const { stdin, lastFrame } = setup(probe)
  await tick()

  await prefix(stdin, 'N')
  await tick()
  stdin.write('/tmp/gamma')
  stdin.write('\r')
  await tick()

  assert.deepEqual(probe.createWorkspaceCalls, ['/tmp/gamma'])
  const frame = lastFrame() ?? ''
  assert.ok(frame.includes('● /tmp/gamma'), '新工作区已切为活动（fake 里 title=path）')
  assert.ok(frame.includes('tabs=1'), '新工作区自动开了 1 个 tab')
  const last = probe.createSessionCalls[probe.createSessionCalls.length - 1]
  assert.ok(last !== undefined && last.workspaceId === 'ws-3', '新会话挂在新工作区下')
})

test('空路径不提交 createWorkspace', async () => {
  const probe: Probe = { createSessionCalls: [], createWorkspaceCalls: [], prompts: [], composerInput: [] }
  const { stdin, lastFrame } = setup(probe)
  await tick()
  await prefix(stdin, 'N')
  await tick()
  stdin.write('\r')
  await tick()
  assert.deepEqual(probe.createWorkspaceCalls, [])
  assert.ok((lastFrame() ?? '').includes('新建工作区'), '覆盖层保持打开')
})

test('侧栏直接渲染时标出活动工作区（ink-testing-library 断言）', async () => {
  const state = {
    sessions: new Map(),
    workspaces: [
      { workspaceId: 'ws-1', title: 'alpha', path: '/a', sessionIds: [] },
      { workspaceId: 'ws-2', title: 'beta', path: '/b', sessionIds: [] },
    ],
  }
  const { lastFrame } = render(
    h(Sidebar as never, { state, activeSessionId: null, width: 30, activeWorkspaceId: 'ws-2', view: 'spaces' }),
  )
  const frame = lastFrame() ?? ''
  assert.ok(frame.includes('● beta'), '活动工作区有 ● 标记')
  assert.ok(!frame.includes('● alpha'), '非活动工作区没有标记')
  // 不传 activeWorkspaceId 也不炸（可选 prop）
  const plain = render(h(Sidebar as never, { state, activeSessionId: null, width: 30, view: 'spaces' }))
  assert.ok(!((plain.lastFrame() ?? '').includes('●')), '不传则不标')
})
