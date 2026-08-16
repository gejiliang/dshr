/**
 * 侧栏渲染测试：herdr 结构（docs/herdr-reference.md 第一节）--
 * 标题 `spaces`、space 列表（活动 ● / 其余 ·）、底部 2×2 入口块、`«` 折叠指示，
 * 以及 agents 视图（全量会话 + 状态点）。
 *
 * 写法约束：
 * - 测试文件是 .ts（node --test 的 glob 只收 *.test.ts），用 createElement 不用 JSX；
 * - 颜色断言需要 chalk 上色，chalk 的颜色等级在**模块加载时**定死，
 *   所以先设 FORCE_COLOR，再动态 import 被测组件（静态 import 会抢跑）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.FORCE_COLOR = '3'

const { render } = await import('ink-testing-library')
const { createElement: h } = await import('react')
const { Sidebar, STATUS_MARKS } = await import('../lib/Sidebar.js')

type AgentStatus = 'idle' | 'working' | 'blocked' | 'error'

interface FakeSession {
  sessionId: string
  status: AgentStatus
  blank: boolean
  title?: string
}

function session(sessionId: string, status: AgentStatus, title?: string): FakeSession {
  return { sessionId, status, blank: false, ...(title !== undefined ? { title } : {}) }
}

function fakeState(sessions: FakeSession[], sessionIds: string[]) {
  return {
    sessions: new Map(sessions.map((s) => [s.sessionId, s])),
    workspaces: [
      { workspaceId: 'ws-1', title: 'dshr', path: '/tmp/dshr', sessionIds },
      { workspaceId: 'ws-2', title: 'herdr', path: '/tmp/herdr', sessionIds: [] },
    ],
  }
}

const ALL_IDS = ['s-idle', 's-working', 's-blocked', 's-error']

function renderSidebar(state: unknown, props: Record<string, unknown> = {}): string {
  const { lastFrame } = render(
    h(Sidebar as never, { state, activeSessionId: null, width: 25, view: 'spaces', ...props }),
  )
  return lastFrame() ?? ''
}

/* ------------------------------ spaces 视图 ------------------------------ */

test('spaces 视图：标题 spaces，条目 · 开头，活动工作区 ● 标出', () => {
  const frame = renderSidebar(fakeState([], ALL_IDS), { activeWorkspaceId: 'ws-2' })
  assert.ok(frame.includes('spaces'), '标题是 spaces')
  assert.ok(frame.includes('● herdr'), '活动工作区用 ● 标出')
  assert.ok(frame.includes('· dshr'), '非活动工作区是 ·')
  assert.ok(!frame.includes('● dshr'), '非活动工作区不是 ●')
})

test('底部 2×2 入口块：new/menu 一行、横分隔线、agents 一行、第四格留空、右下 «', () => {
  const frame = renderSidebar(fakeState([], []))
  // 去掉 ANSI 颜色码再比对行内容（chalk 在模块加载时定死颜色等级）
  const lines = frame.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
  const newMenu = lines.find((l) => l.includes('new') && l.includes('menu'))
  assert.ok(newMenu !== undefined, 'new 与 menu 同一行')
  assert.ok((newMenu ?? '').indexOf('menu') > (newMenu ?? '').indexOf('new'), 'menu 在行右端')
  assert.ok(lines.some((l) => /^─+$/.test(l.trim())), '有一条横分隔线')
  const agentsLine = lines.find((l) => l.trim().startsWith('agents'))
  assert.ok(agentsLine !== undefined, 'agents 一格存在')
  assert.ok(!frame.includes('priority'), '第四格不发明概念，留空')
  const collapse = lines.find((l) => l.trim() === '«')
  assert.ok(collapse !== undefined, '右下角有 « 折叠指示')
  assert.ok((collapse ?? '').endsWith('«'), '« 靠右')
})

test('agents 视图：标题换 agents，列出全部会话与四态符号', () => {
  const frame = renderSidebar(
    fakeState(
      [
        session('s-idle', 'idle', '甲'),
        session('s-working', 'working', '乙'),
        session('s-blocked', 'blocked', '丙'),
        session('s-error', 'error', '丁'),
      ],
      ALL_IDS,
    ),
    { view: 'agents' },
  )
  assert.ok(frame.includes('agents'), '标题是 agents')
  for (const t of ['甲', '乙', '丙', '丁']) assert.ok(frame.includes(t), `会话标题 ${t}`)
  assert.ok(frame.includes('○'), 'idle 符号')
  assert.ok(frame.includes('●'), 'working 符号')
  assert.ok(frame.includes('◆'), 'blocked 符号')
  assert.ok(frame.includes('✖'), 'error 符号')
})

test('四种状态各有可区分的符号，blocked 反显', () => {
  const marks = STATUS_MARKS as Readonly<Record<AgentStatus, { symbol: string; color?: string; inverse?: boolean }>>
  const symbols = Object.values(marks).map((m) => m.symbol)
  assert.equal(new Set(symbols).size, 4, '四个符号互不相同')
  assert.equal(marks.blocked.inverse, true, 'blocked 必须反显--那是唯一需要人介入的状态')
  assert.ok(marks.blocked.color !== marks.idle.color)
  assert.ok(marks.blocked.color !== marks.working.color)
  assert.ok(marks.blocked.color !== marks.error.color)
})

test('agents 视图：blocked 的 ◆ 落在 ANSI 反显段里，其余状态各有颜色码', () => {
  const frame = renderSidebar(
    fakeState(
      [session('s-idle', 'idle'), session('s-working', 'working'), session('s-blocked', 'blocked'), session('s-error', 'error')],
      ALL_IDS,
    ),
    { view: 'agents' },
  )
  // ANSI: 反显 [7m … [27m；绿 [32m；红 [31m；灰 [90m
  assert.match(frame, /\x1b\[7m(\x1b\[[0-9;]*m)*◆/, 'blocked 反显段内是 ◆')
  assert.match(frame, /\x1b\[32m●/, 'working 绿')
  assert.match(frame, /\x1b\[31m✖/, 'error 红')
  assert.match(frame, /\x1b\[90m○/, 'idle 灰')
})

test('agents 视图：活跃会话高亮（bold）', () => {
  const frame = renderSidebar(fakeState([session('s-1', 'working', '目标')], ['s-1']), {
    view: 'agents',
    activeSessionId: 's-1',
  })
  assert.match(frame, /\x1b\[1m[^[]*目标/, '活跃会话 bold')
})

test('agents 视图：高亮的 agents 格', () => {
  const frame = renderSidebar(fakeState([], []), { view: 'agents' })
  assert.match(frame, /\x1b\[1m[^]*?agents/, 'agents 格在 agents 视图下加粗')
})

test('空态：无工作区 / 无会话各有占位，不炸', () => {
  const noWs = renderSidebar({ sessions: new Map(), workspaces: [] })
  assert.ok(noWs.includes('(无工作区)'))
  const noSessions = renderSidebar({ sessions: new Map(), workspaces: [] }, { view: 'agents' })
  assert.ok(noSessions.includes('(无会话)'))
})

test('不传 activeWorkspaceId 也不炸（可选 prop），且没有 ● 标记', () => {
  const frame = renderSidebar(fakeState([], []))
  assert.ok(!frame.includes('● dshr'), '不传则不标活动')
})
