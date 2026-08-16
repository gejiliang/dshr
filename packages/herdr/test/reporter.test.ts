/**
 * 上报逻辑的验收：只在 herdr 里才报、状态翻转才报、blocked 带原因、退出要交还。
 * 不真的调 `herdr`——注入一个假 exec 记录命令行。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentStatus, DshrState, SessionId } from '@dshr/state'
import { startReporter, toHerdrState } from '../lib/index.js'

const SID = 'session-1' as SessionId

/** 最小的假 state：只提供 sessions 与 subscribe，reporter 只用这两样。 */
function fakeState(initial: AgentStatus) {
  const listeners = new Set<() => void>()
  let summary: Record<string, unknown> = { sessionId: SID, status: initial, blank: false }
  const state = {
    get sessions() {
      return new Map([[SID, summary]]) as unknown as DshrState['sessions']
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as DshrState
  return {
    state,
    set(next: Record<string, unknown>) {
      summary = { sessionId: SID, blank: false, ...next }
      for (const l of listeners) l()
    },
  }
}

function recorder() {
  const calls: string[][] = []
  return { calls, exec: (args: readonly string[]) => (calls.push([...args]), Promise.resolve(true)) }
}

test('不在 herdr 里跑（没有 HERDR_PANE_ID）就什么都不报', async () => {
  // ⚠️ 必须显式清掉这个变量：**这套测试本身很可能就跑在 herdr 的 pane 里**
  // （开发时就是），那样 `currentPaneId()` 会真的读到值，这条断言就测不到它想测的东西。
  // 第一版没清，在开发机上直接红——环境相关的测试要自己把环境钉死。
  const saved = process.env['HERDR_PANE_ID']
  delete process.env['HERDR_PANE_ID']
  try {
    const { state } = fakeState('idle')
    const rec = recorder()
    const reporter = startReporter({ state, sessionId: SID, exec: rec.exec })
    await reporter.dispose()
    assert.deepEqual(rec.calls, [], 'dshr 必须能脱离 herdr 单独用')
  } finally {
    if (saved !== undefined) process.env['HERDR_PANE_ID'] = saved
  }
})

test('启动先报会话身份，再报当前状态', async () => {
  const { state } = fakeState('idle')
  const rec = recorder()
  const reporter = startReporter({ state, sessionId: SID, paneId: 'w1:p1', exec: rec.exec })
  const kinds = rec.calls.map((c) => c[1])
  assert.deepEqual(kinds, ['report-agent-session', 'report-agent'])
  assert.ok(rec.calls[0]?.includes('--agent-session-id'))
  assert.ok(rec.calls[0]?.includes(String(SID)))
  assert.deepEqual(rec.calls[1]?.slice(-2), ['--state', 'idle'])
  await reporter.dispose()
})

test('只在状态真的变了时才报（同一状态重复通知不刷屏）', async () => {
  const f = fakeState('idle')
  const rec = recorder()
  const reporter = startReporter({ state: f.state, sessionId: SID, paneId: 'w1:p1', exec: rec.exec })
  const before = rec.calls.length
  f.set({ status: 'idle' })
  f.set({ status: 'idle' })
  assert.equal(rec.calls.length, before, '状态没变就不该再报')
  f.set({ status: 'working' })
  assert.deepEqual(rec.calls.at(-1)?.slice(-2), ['--state', 'working'])
  await reporter.dispose()
})

test('blocked 要带上「在等什么」，侧栏才知道该去处理哪个', async () => {
  const f = fakeState('idle')
  const rec = recorder()
  const reporter = startReporter({ state: f.state, sessionId: SID, paneId: 'w1:p1', exec: rec.exec })
  f.set({ status: 'blocked', pending: { kind: 'approval', rpcId: 'r1', approvalId: 'a1', toolName: 'bash' } })
  const call = rec.calls.at(-1) ?? []
  assert.ok(call.includes('--state') && call.includes('blocked'))
  assert.ok(call.includes('--message'))
  assert.ok(call.some((a) => a.includes('bash')), '消息里要写清楚是哪个工具在等审批')
  await reporter.dispose()
})

test('error 落到 unknown（herdr 没有 error 这一档）并带上消息', async () => {
  assert.equal(toHerdrState('error'), 'unknown')
  assert.equal(toHerdrState('working'), 'working')
  const f = fakeState('idle')
  const rec = recorder()
  const reporter = startReporter({ state: f.state, sessionId: SID, paneId: 'w1:p1', exec: rec.exec })
  f.set({ status: 'error', error: '模型炸了' })
  const call = rec.calls.at(-1) ?? []
  assert.ok(call.includes('unknown'))
  assert.ok(call.includes('模型炸了'))
  await reporter.dispose()
})

test('dispose 要 release-agent，否则侧栏留一个永远 idle 的幽灵', async () => {
  const f = fakeState('working')
  const rec = recorder()
  const reporter = startReporter({ state: f.state, sessionId: SID, paneId: 'w1:p1', exec: rec.exec })
  await reporter.dispose()
  assert.equal(rec.calls.at(-1)?.[1], 'release-agent')
  // dispose 之后不再上报
  const after = rec.calls.length
  f.set({ status: 'idle' })
  assert.equal(rec.calls.length, after)
})
