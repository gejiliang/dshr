/**
 * Shell 集成测试：假 tui 组件替身 + 假 DshrState，
 * 验证「新建 tab/pane 默认开会话」「前缀键被消费、普通键透传到输入框」、
 * herdr 化的画面规则（单 pane 无框 / 多 pane 方角框、提示栏、zoom、序号切 tab）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.FORCE_COLOR = '1'

const { render } = await import('ink-testing-library')
const { useInput, Text } = await import('ink')
const { createElement: h } = await import('react')
const { Shell } = await import('../lib/Shell.js')
const { PaneView } = await import('../lib/PaneView.js')
const { PREFIX_HINT, KEYBIND_ROWS, hintLine } = await import('../lib/hint.js')
const { DEFAULT_KEY_TABLE } = await import('../lib/keys.js')

/** 打字后等一拍让 Promise / setState 落定。 */
const tick = () => new Promise((r) => setTimeout(r, 30))

/**
 * 等到条件成立为止，**不要用固定 sleep 去等渲染**。
 *
 * ⚠️ 踩过：断言前只 `await tick()`（固定 30ms），单独跑这个文件时 72/72 全绿，
 * 但 `node --test packages/*/test/*.test.ts` 并行跑整个仓库时，ink 的异步渲染
 * 被别的测试进程挤到 30ms 之后，断言先跑 → 偶发失败。
 * 而 README 让人跑的正是全量那条命令，所以「单独跑是绿的」不算数。
 */
async function waitFor(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`等不到：${what}（${timeoutMs}ms）`)
}

interface Probe {
  createSessionCalls: number
  /** [sessionId, 输入] -- 按 pane 分清是谁收到的。 */
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
  // 假 Composer 必须**和真 Composer 同样按 acceptsKey 在按键时刻判活**，
  // 否则测的是一个比真实现更宽松的东西（`isActive: focused` 用的是上一次渲染的值，会漏键）。
  const Composer = ({
    sessionId,
    focused,
    acceptsKey,
    onSubmit,
  }: {
    sessionId: string
    focused: boolean
    acceptsKey?: () => boolean
    onSubmit: (t: string) => void
  }) => {
    useInput(
      (input, key) => {
        if (acceptsKey !== undefined && !acceptsKey()) return
        if (key.ctrl) return // 契约：Ctrl 组合键是 shell 前缀层的领域
        probe.composerInput.push([sessionId, input])
        if (input === '\r') onSubmit(input)
      },
      { isActive: acceptsKey !== undefined ? true : focused },
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
    h(Shell as never, { state: makeFakeState(probe), components: makeComponents(probe), initialWorkspaceId: 'ws-1' }),
  )
}

/** Ctrl-B <key>：前缀与后续键分两拍（见 components.ts 的键位分层契约）。 */
async function prefix(stdin: { write: (s: string) => void }, key: string): Promise<void> {
  stdin.write('\x02')
  await tick()
  stdin.write(key)
}

test('启动即开第一个 tab 并自动开第一个会话', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { lastFrame } = setup(probe)
  await tick()
  assert.equal(probe.createSessionCalls, 1, '新 tab 默认开新会话')
  const frame = lastFrame() ?? ''
  assert.ok(frame.includes('spaces'), 'herdr 侧栏标题')
  assert.ok(frame.includes('● dshr'), 'space 列表条目（活动工作区 ● 标出）')
  assert.ok(frame.includes('│'), '侧栏与内容区之间有竖线')
})

test('Ctrl-B c：前缀被消费（不进输入框），新 tab 连带新会话', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin, lastFrame } = setup(probe)
  await tick()
  assert.equal(probe.createSessionCalls, 1)

  stdin.write('\x02') // Ctrl-B
  await tick()
  assert.ok((lastFrame() ?? '').includes('PREFIX'), '前缀按下时底部出现提示栏')
  assert.ok((lastFrame() ?? '').includes('new tab'), '提示栏里有键位说明')
  stdin.write('c')
  await tick()
  assert.equal(probe.createSessionCalls, 2, '新 tab 自动开会话')
  assert.ok((lastFrame() ?? '').includes('tabs=2'))
  assert.ok((lastFrame() ?? '').includes('+'), 'tab 栏有 + 新建入口')
  assert.deepEqual(probe.composerInput, [], '前缀序列一个键都没漏进输入框')
})

test('前缀松开后底部回到会话状态行（不与提示栏同时占两行）', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin, lastFrame } = setup(probe)
  await tick()
  stdin.write('\x02')
  await tick()
  assert.ok((lastFrame() ?? '').includes('new tab'), '前缀态：提示栏')
  stdin.write('y') // 不认识的键：消费，回 idle
  await tick()
  const frame = lastFrame() ?? ''
  assert.ok(frame.includes('tabs=1'), '非前缀态：状态行')
  assert.ok(!frame.includes('new tab'), '提示栏已让位')
})

test('Ctrl-B v / - ：分割出新 pane 并各自开会话', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin } = setup(probe)
  await tick()
  stdin.write('\x02')
  stdin.write('v')
  await tick()
  stdin.write('\x02')
  stdin.write('-')
  await tick()
  assert.equal(probe.createSessionCalls, 3, '初始 1 + 两次分割各 1')
})

test('单 pane 无边框；分割后画方角框；zoom 回到无框单画面', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin, lastFrame } = setup(probe)
  await tick()
  let frame = lastFrame() ?? ''
  assert.ok(!frame.includes('┌'), '单 pane 没有边框')
  assert.ok(!frame.includes('╭'), '也没有圆角框')

  await prefix(stdin, 'v')
  await tick()
  frame = lastFrame() ?? ''
  assert.ok(frame.includes('┌') && frame.includes('┐'), '多 pane 画方角框')
  assert.ok(!frame.includes('╭'), '不是圆角')

  await prefix(stdin, 'z') // zoom：当前 pane 全屏
  await tick()
  frame = lastFrame() ?? ''
  assert.ok(!frame.includes('┌'), 'zoom 时无框')
  assert.equal((frame.match(/CONV/g) ?? []).length, 1, '只看到一片 pane')

  await prefix(stdin, 'z') // 再按还原
  await tick()
  frame = lastFrame() ?? ''
  assert.ok(frame.includes('┌'), '还原后边框回来了')
  assert.equal((frame.match(/CONV/g) ?? []).length, 2, '两片 pane 都在')
})

test('prefix+1..9 按序号切 tab', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin } = setup(probe)
  await tick()
  await prefix(stdin, 'c')
  await tick()
  await prefix(stdin, 'c')
  await tick()
  assert.equal(probe.createSessionCalls, 3)
  probe.composerInput.length = 0
  await prefix(stdin, '2') // 切到第 2 个 tab（sess-2）
  await tick()
  stdin.write('k')
  stdin.write('\r')
  await tick()
  assert.equal(probe.prompts[0]?.[0], 'sess-2', 'prompt 发给第 2 个 tab 的会话')
})

test('prefix+hjkl 移动焦点（vim 方向，方向键之外的新增绑定）', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin } = setup(probe)
  await tick()
  await prefix(stdin, 'v') // 竖分；焦点在新 pane（sess-2）
  await waitFor(() => probe.createSessionCalls === 2, '第二个 pane 的会话建好')
  probe.composerInput.length = 0
  await prefix(stdin, 'h') // 回左边（sess-1）
  await tick()
  stdin.write('q')
  await waitFor(() => probe.composerInput.length > 0, 'h 之后的按键落进某个 composer')
  assert.deepEqual(probe.composerInput, [['sess-1', 'q']], 'h 把焦点移回左 pane')
  probe.composerInput.length = 0
  await prefix(stdin, 'l') // 再去右边
  await tick()
  stdin.write('w')
  await waitFor(() => probe.composerInput.length > 0, 'l 之后的按键落进某个 composer')
  assert.deepEqual(probe.composerInput, [['sess-2', 'w']], 'l 把焦点移回右 pane')
})

test('Ctrl-B b 开关侧栏', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin, lastFrame } = setup(probe)
  await tick()
  assert.ok((lastFrame() ?? '').includes('spaces'), '侧栏默认开')
  await prefix(stdin, 'b')
  await tick()
  const closed = lastFrame() ?? ''
  assert.ok(!closed.includes('spaces'), '侧栏已关')
  assert.ok(!closed.includes('«'), '折叠指示随侧栏消失')
  await prefix(stdin, 'b')
  await tick()
  assert.ok((lastFrame() ?? '').includes('spaces'), '侧栏再开')
})

test('Ctrl-B a：侧栏切到 agents 视图，再切回 spaces', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin, lastFrame } = setup(probe)
  await tick()
  await prefix(stdin, 'a')
  await tick()
  let frame = lastFrame() ?? ''
  assert.ok(frame.includes('agents'), '标题换成 agents')
  assert.ok(frame.includes('(新会话)'), '会话列表出现')
  await prefix(stdin, 'a')
  await tick()
  frame = lastFrame() ?? ''
  assert.ok(frame.includes('spaces'), '切回 spaces')
  assert.ok(!frame.includes('(新会话)'), '会话列表不在 spaces 视图里')
})

test('Ctrl-B ? 打开键位帮助，esc 关闭', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin, lastFrame } = setup(probe)
  await tick()
  await prefix(stdin, '?')
  await tick()
  let frame = lastFrame() ?? ''
  assert.ok(frame.includes('keybinds'), '帮助覆盖层出现')
  assert.ok(frame.includes('new tab'), '列出了键位')
  stdin.write('\x1b') // esc
  await tick()
  frame = lastFrame() ?? ''
  assert.ok(!frame.includes('reserved'), '帮助已关')
})

test('非前缀按键透传给聚焦 pane 的输入框，回车触发 prompt', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin } = setup(probe)
  await tick()
  stdin.write('hi')
  await tick()
  assert.equal(probe.composerInput.map(([, i]) => i).join(''), 'hi')
  stdin.write('\r')
  await tick()
  assert.equal(probe.prompts.length, 1)
  assert.equal(probe.prompts[0]?.[0], 'sess-1')
})

test('两个 pane 同时挂载：打字只落进焦点 pane 的 Composer', async () => {
  const probe: Probe = { createSessionCalls: 0, composerInput: [], prompts: [] }
  const { stdin, lastFrame } = setup(probe)
  await tick()
  await prefix(stdin, 'v') // 竖分；焦点移到新 pane（sess-2）
  await waitFor(() => probe.createSessionCalls === 2, '第二个 pane 的会话建好')
  // ⚠️ 必须等**新 pane 的输入框真的挂上**再打字。
  // 分屏之后到新组件挂载之间有一个窗口，那时它还不存在，键当然进不去——
  // 这不是可以靠「判活」修掉的东西，是组件还没生出来。真人分屏后再打字
  // 天然隔着几十毫秒，不会踩到；但测试若不等，就是在测一个无法满足的期望。
  await waitFor(
    () => ((lastFrame() ?? '').match(/composer/gi) ?? []).length >= 2,
    '两个 pane 的输入框都挂上了',
  )
  probe.composerInput.length = 0
  stdin.write('k')
  await waitFor(() => probe.composerInput.length > 0, '按键落进某个 composer')
  assert.deepEqual(probe.composerInput, [['sess-2', 'k']], '只有焦点 pane 收到键')
})

/* ------------------------------ 纯数据层 ------------------------------ */

test('PaneView 直渲染：framed=false 无框无标题条，framed=true 方角框', async () => {
  const state = { sessions: new Map() }
  const components = {
    Conversation: () => h(Text, null, 'CONV'),
    Composer: () => h(Text, null, 'composer'),
    PendingPrompt: () => h(Text, null, 'PENDING'),
    StatusLine: () => h(Text, null, ''),
  }
  const pane = { kind: 'pane' as const, paneId: 'pane-1', sessionId: null }
  const bare = render(
    h(PaneView as never, { pane, state, components, focused: true, framed: false, prefixPending: false, onSubmit: () => {} }),
  )
  const bareFrame = bare.lastFrame() ?? ''
  assert.ok(!bareFrame.includes('┌') && !bareFrame.includes('╭'), '单 pane 无框')
  const framed = render(
    h(PaneView as never, { pane, state, components, focused: true, framed: true, prefixPending: false, onSubmit: () => {} }),
  )
  const framedFrame = framed.lastFrame() ?? ''
  assert.ok(framedFrame.includes('┌') && framedFrame.includes('┐'), '多 pane 方角框')
  assert.ok(!framedFrame.includes('╭'), '不是圆角')
})

test('提示行与 herdr 的 NAVIGATE 行同形', () => {
  const line = hintLine('PREFIX', PREFIX_HINT)
  assert.ok(line.startsWith('PREFIX  '), '模式词打头')
  assert.ok(line.includes('c new tab'), '键 + 说明')
  assert.ok(line.includes('- split─'), '横分的 ─ 记号（herdr 同款）')
})

test('帮助表与默认键表不漂移：每个绑定都有行，没有幽灵行', () => {
  const documented = new Set(KEYBIND_ROWS.flatMap((r) => r.tableKeys ?? []))
  const bound = new Set(Object.keys(DEFAULT_KEY_TABLE.bindings))
  for (const k of bound) assert.ok(documented.has(k), `绑定 ${k} 没有出现在帮助里`)
  for (const k of documented) assert.ok(bound.has(k), `帮助里的 ${k} 不在默认表里`)
})
