/**
 * 侧栏渲染测试：四种 AgentStatus 的符号 / 颜色，用 ink-testing-library 断言。
 *
 * 两个写法约束：
 * - 测试文件是 .ts（node --test 的 glob 只收 *.test.ts），用 createElement 不用 JSX；
 * - 颜色断言需要 chalk 上色，chalk 的颜色等级在**模块加载时**定死，
 *   所以先设 FORCE_COLOR，再动态 import 被测组件（静态 import 会抢跑）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.FORCE_COLOR = '3'

const { render } = await import('ink-testing-library')
const { createElement: h } = await import('react')
const { Sidebar } = await import('../lib/Sidebar.js')
const { STATUS_MARKS } = await import('../lib/Sidebar.js')

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
    workspaces: [{ workspaceId: 'ws-1', title: 'dshr', path: '/tmp/dshr', sessionIds }],
  }
}

const ALL_IDS = ['s-idle', 's-working', 's-blocked', 's-error']

function renderSidebar(state: unknown, activeSessionId: string | null = null): string {
  const { lastFrame } = render(h(Sidebar as never, { state, activeSessionId, width: 30 }))
  return lastFrame() ?? ''
}

test('四种状态各有可区分的符号', () => {
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
  )
  assert.ok(frame.includes('dshr'), '工作区标题')
  for (const t of ['甲', '乙', '丙', '丁']) assert.ok(frame.includes(t), `会话标题 ${t}`)
  assert.ok(frame.includes('○'), 'idle 符号')
  assert.ok(frame.includes('●'), 'working 符号')
  assert.ok(frame.includes('◆'), 'blocked 符号')
  assert.ok(frame.includes('✖'), 'error 符号')
})

test('符号两两不同，blocked 反显且四态颜色不撞车', () => {
  const marks = STATUS_MARKS as Readonly<Record<AgentStatus, { symbol: string; color?: string; inverse?: boolean }>>
  const symbols = Object.values(marks).map((m) => m.symbol)
  assert.equal(new Set(symbols).size, 4, '四个符号互不相同')
  assert.equal(marks.blocked.inverse, true, 'blocked 必须反显——那是唯一需要人介入的状态')
  assert.ok(marks.blocked.color !== marks.idle.color)
  assert.ok(marks.blocked.color !== marks.working.color)
  assert.ok(marks.blocked.color !== marks.error.color)
})

test('blocked 的 ◆ 落在 ANSI 反显段里，其余状态各有颜色码', () => {
  const frame = renderSidebar(
    fakeState(
      [session('s-idle', 'idle'), session('s-working', 'working'), session('s-blocked', 'blocked'), session('s-error', 'error')],
      ALL_IDS,
    ),
  )
  // ANSI: 反显 [7m … [27m；绿 [32m；红 [31m；灰 [90m
  assert.match(frame, /\x1b\[7m(\x1b\[[0-9;]*m)*◆/, 'blocked 反显段内是 ◆')
  assert.match(frame, /\x1b\[32m●/, 'working 绿')
  assert.match(frame, /\x1b\[31m✖/, 'error 红')
  assert.match(frame, /\x1b\[90m○/, 'idle 灰')
})

test('活跃会话高亮（bold）', () => {
  const frame = renderSidebar(fakeState([session('s-1', 'working', '目标')], ['s-1']), 's-1')
  assert.match(frame, /\x1b\[1m[^[]*目标/, '活跃会话 bold')
})

test('无工作区时显示占位，不炸', () => {
  const { lastFrame } = render(
    h(Sidebar as never, { state: { sessions: new Map(), workspaces: [] }, activeSessionId: null, width: 30 }),
  )
  assert.ok((lastFrame() ?? '').includes('(无工作区)'))
})

test('工作区里有但 sessions map 里还没有的会话被跳过', () => {
  const frame = renderSidebar(fakeState([], ALL_IDS))
  assert.ok(frame.includes('dshr'))
  assert.ok(!frame.includes('●'))
})
