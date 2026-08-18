/**
 * 状态折叠的验收测试：状态映射、blank 位、blocked 优先级、
 * 投影 higher-seq-wins、rpcId 去重（重放幂等）、generation 失效。
 * 全部用 FakeClient 喂帧，不连真 host。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createState, type DshrState } from '@dshr/state'
import {
  assistantMessage,
  FakeClient,
  listItem,
  ok,
  rid,
  settle,
  sid,
  textDelta,
  eventFrame,
  userMessage,
} from './fake-client.ts'

async function readyState(client: FakeClient): Promise<DshrState> {
  client.stubBaseline()
  const state = createState({ client })
  client.setReady(1)
  await settle()
  return state
}

test('状态映射：idle / working / error，全部来自 host 权威事件', async () => {
  const client = new FakeClient()
  const state = await readyState(client)
  const s1 = sid('s1')

  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true, cwd: '/tmp/x' })
  let summary = state.sessions.get(s1)
  assert.ok(summary)
  assert.equal(summary.status, 'idle')
  assert.equal(summary.cwd, '/tmp/x')

  client.emitHost({ type: 'host/session-status', sessionId: s1, running: true })
  summary = state.sessions.get(s1)
  assert.ok(summary)
  assert.equal(summary.status, 'working')

  client.emitHost({ type: 'host/session-status', sessionId: s1, running: false })
  summary = state.sessions.get(s1)
  assert.ok(summary)
  assert.equal(summary.status, 'idle')

  client.emitHost({ type: 'host/agent-error', sessionId: s1, message: 'provider exploded' })
  summary = state.sessions.get(s1)
  assert.ok(summary)
  assert.equal(summary.status, 'error')
  assert.equal(summary.error, 'provider exploded')

  // 下一条权威运行状态帧取代粘住的 error
  client.emitHost({ type: 'host/session-status', sessionId: s1, running: false })
  summary = state.sessions.get(s1)
  assert.ok(summary)
  assert.equal(summary.status, 'idle')
  assert.equal(summary.error, undefined)

  await state.dispose()
})

test('blocked 压过 working：在跑又在等审批时显示在等人', async () => {
  const client = new FakeClient()
  const state = await readyState(client)
  const s1 = sid('s1')

  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true })
  client.emitHost({ type: 'host/session-status', sessionId: s1, running: true })
  assert.equal(state.sessions.get(s1)?.status, 'working')

  client.emitMux(
    { type: 'approval/requested', sessionId: s1, approvalId: 'a1' as never, toolName: 'bash', reason: 'writes files' },
    rid('rpc-a1'),
  )
  let summary = state.sessions.get(s1)
  assert.ok(summary)
  assert.equal(summary.status, 'blocked')
  assert.deepEqual(summary.pending, {
    kind: 'approval',
    rpcId: rid('rpc-a1'),
    approvalId: 'a1',
    toolName: 'bash',
    reason: 'writes files',
  })

  client.emitMux(
    { type: 'approval/resolved', sessionId: s1, approvalId: 'a1' as never, outcome: 'allowed-once' },
    rid('push-resolved'),
  )
  summary = state.sessions.get(s1)
  assert.ok(summary)
  assert.equal(summary.status, 'working')
  assert.equal(summary.pending, undefined)

  // question 同样挡人
  client.emitMux(
    { type: 'question/requested', sessionId: s1, questions: [{ id: 'q1', question: '继续吗？' }] },
    rid('rpc-q1'),
  )
  assert.equal(state.sessions.get(s1)?.status, 'blocked')
  client.emitMux(
    { type: 'question/resolved', sessionId: s1, questionRpcId: rid('rpc-q1'), outcome: 'answered' },
    rid('push-resolved-2'),
  )
  assert.equal(state.sessions.get(s1)?.status, 'working')

  await state.dispose()
})

test('blank 位：session-added 恒 true，第一次 running:true 翻掉', async () => {
  const client = new FakeClient()
  const state = await readyState(client)
  const s1 = sid('s1')

  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true })
  assert.equal(state.sessions.get(s1)?.blank, true)

  // running:false 不翻——blank 的会话从没跑过
  client.emitHost({ type: 'host/session-status', sessionId: s1, running: false })
  assert.equal(state.sessions.get(s1)?.blank, true)

  client.emitHost({ type: 'host/session-status', sessionId: s1, running: true })
  assert.equal(state.sessions.get(s1)?.blank, false)

  await state.dispose()
})

test('blank 位：重连后以 session.list 的 summary.blank 为准', async () => {
  const client = new FakeClient()
  const state = await readyState(client)
  const s1 = sid('s1')
  const s2 = sid('s2')

  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true })
  client.emitHost({ type: 'host/session-status', sessionId: s1, running: true })
  assert.equal(state.sessions.get(s1)?.blank, false)

  // 连接重建（generation 2）：list 基线是权威
  client.stubBaseline([
    listItem(s1, { blank: false, running: false }),
    listItem(s2, { blank: true }),
  ])
  client.setReady(2)
  await settle()

  assert.equal(state.sessions.get(s1)?.blank, false)
  assert.equal(state.sessions.get(s2)?.blank, true)
  assert.equal(state.sessions.get(s2)?.status, 'idle')

  await state.dispose()
})

test('投影 higher-seq-wins：乱序到达时旧 seq（含相等）不能覆盖新 seq', async () => {
  const client = new FakeClient()
  const state = await readyState(client)
  const s1 = sid('s1')

  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true })

  // history 尾页的 projections 块播种：整块一个 asOfSeq，逐 key 打上初始水位
  client.onCall('session.history', () =>
    ok({ events: [], hasMore: false, projections: { asOfSeq: 5, values: { title: 'Seed' } } }),
  )
  state.conversation(s1)
  await settle()
  assert.equal(state.sessions.get(s1)?.title, 'Seed')
  assert.equal(state.projections(s1).get('title'), 'Seed')

  // 推送更新
  client.emitMux({ type: 'session/projection', sessionId: s1, key: 'title', value: 'New', seq: 7 }, rid('p1'))
  assert.equal(state.sessions.get(s1)?.title, 'New')

  // 乱序旧值：不许覆盖
  client.emitMux({ type: 'session/projection', sessionId: s1, key: 'title', value: 'Old', seq: 6 }, rid('p2'))
  assert.equal(state.sessions.get(s1)?.title, 'New')

  // 相等 seq：也不许覆盖（list 基线可能和推送水位相同）
  client.emitMux({ type: 'session/projection', sessionId: s1, key: 'title', value: 'Same', seq: 7 }, rid('p3'))
  assert.equal(state.sessions.get(s1)?.title, 'New')

  // 非 title 键也进泛型值表（状态行的上下文用量数据源）
  client.emitMux(
    { type: 'session/projection', sessionId: s1, key: 'contextPressure', value: { contextWindow: 131072 }, seq: 8 },
    rid('p4'),
  )
  assert.deepEqual(state.projections(s1).get('contextPressure'), { contextWindow: 131072 })

  // 重连：list 基线（asOfSeq 6）比推送（seq 7）旧，不许覆盖
  client.stubBaseline([listItem(s1, { blank: false, projections: { asOfSeq: 6, values: { title: 'Stale' } } })])
  client.setReady(2)
  await settle()
  assert.equal(state.sessions.get(s1)?.title, 'New')

  await state.dispose()
})

test('未决交互：重放的 requested 帧（同一 rpcId）不产生重复未决项', async () => {
  const client = new FakeClient()
  const state = await readyState(client)
  const s1 = sid('s1')

  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true })
  client.emitHost({ type: 'host/session-status', sessionId: s1, running: true })

  const requested = {
    type: 'question/requested',
    sessionId: s1,
    questions: [{ id: 'q1', question: '选一个' }],
  } as const
  // host 开流时重放未决帧，rpcId 逐字复用——同一帧来两遍
  client.emitMux(requested, rid('rpc-q1'))
  client.emitMux(requested, rid('rpc-q1'))
  assert.equal(state.sessions.get(s1)?.status, 'blocked')

  // 若实现里铸了新 id 存了两份，一次 resolved 清不掉，状态会卡在 blocked
  client.emitMux(
    { type: 'question/resolved', sessionId: s1, questionRpcId: rid('rpc-q1'), outcome: 'answered' },
    rid('push-r'),
  )
  assert.equal(state.sessions.get(s1)?.status, 'working')

  // approval 同理
  const approval = { type: 'approval/requested', sessionId: s1, approvalId: 'a9' as never, toolName: 'edit' } as const
  client.emitMux(approval, rid('rpc-a9'))
  client.emitMux(approval, rid('rpc-a9'))
  assert.equal(state.sessions.get(s1)?.status, 'blocked')
  client.emitMux(
    { type: 'approval/resolved', sessionId: s1, approvalId: 'a9' as never, outcome: 'rejected' },
    rid('push-r2'),
  )
  assert.equal(state.sessions.get(s1)?.status, 'working')

  await state.dispose()
})

test('应答回显未决帧的 rpcId，不新铸', async () => {
  const client = new FakeClient()
  const state = await readyState(client)
  const s1 = sid('s1')

  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true })
  client.emitMux(
    { type: 'approval/requested', sessionId: s1, approvalId: 'a1' as never, toolName: 'bash' },
    rid('rpc-approval-1'),
  )
  await state.answerApproval(s1, 'rejected')
  assert.equal(client.responses.length, 1)
  assert.equal(client.responses[0]?.rpcId, rid('rpc-approval-1'))
  assert.deepEqual(client.responses[0]?.result, {
    ok: true,
    value: { sessionId: s1, approvalId: 'a1', outcome: 'rejected' },
  })
  // 回执 accepted：未决项就地清掉（resolved 帧再来也是幂等的）
  assert.equal(state.sessions.get(s1)?.status, 'idle')

  client.emitMux(
    { type: 'question/requested', sessionId: s1, questions: [{ id: 'q1', question: '？' }] },
    rid('rpc-question-1'),
  )
  const answer = { answers: [{ id: 'q1', selected: ['好'] }] }
  await state.answerQuestion(s1, answer)
  assert.equal(client.responses.length, 2)
  assert.equal(client.responses[1]?.rpcId, rid('rpc-question-1'))
  assert.deepEqual(client.responses[1]?.result, { ok: true, value: { sessionId: s1, answer } })
  assert.equal(state.sessions.get(s1)?.status, 'idle')

  await state.dispose()
})

test('generation 变化：per-session 对话缓存作废重取，脏的流式拼接状态不残留', async () => {
  const client = new FakeClient()
  const state = await readyState(client)
  const s1 = sid('s1')

  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true })

  // 第一代连接：history 尾页 + 一条流式增量（in-flight partial）
  client.onCall('session.history', () =>
    ok({ events: [{ event: userMessage(0, '你好') }], hasMore: false, projections: { asOfSeq: 0, values: {} } }),
  )
  const conversation = state.conversation(s1)
  await settle()
  assert.equal(conversation.items.length, 1)

  client.emitMux(eventFrame(s1, textDelta(1, '半截回答')), rid('push-c1'))
  assert.equal(conversation.items.length, 2)
  const partial = conversation.items[1]
  assert.ok(partial && partial.kind === 'assistant' && partial.streaming)

  // 连接重建：host 会重放，但本地流式拼接状态是脏的，必须整段重取
  client.onCall('session.history', () =>
    ok({
      events: [{ event: userMessage(0, '你好') }, { event: assistantMessage(1, [{ type: 'text', text: '完整回答' }]) }],
      hasMore: false,
      projections: { asOfSeq: 1, values: {} },
    }),
  )
  client.setReady(2)
  await settle()

  assert.equal(conversation.items.length, 2)
  const [first, second] = conversation.items
  assert.ok(first && first.kind === 'user' && first.text === '你好')
  assert.ok(second && second.kind === 'assistant')
  assert.equal(second.text, '完整回答')
  assert.equal(second.streaming, false)
  // 脏的半截文本一个字都不许留
  assert.ok(!conversation.items.some((item) => 'text' in item && typeof item.text === 'string' && item.text.includes('半截')))

  await state.dispose()
})

test('createWorkspace 幂等：命中已有路径不 rename（否则会撞别处的同名工作区）', async () => {
  const client = new FakeClient()
  const state = await readyState(client)

  // host 的契约：对同一路径重复 create 返回已有工作区、**不改标题**，created=false。
  const existing = { workspaceId: 'ws-1', path: '/repo', title: 'repo', sessionIds: [] }
  client.onCall('workspace.create', () => ok({ workspace: existing, created: false }))
  client.onCall('workspace.rename', () => {
    throw new Error('不该走到 rename')
  })

  const id = await state.createWorkspace('/repo', '一个别处已经占用的名字')
  assert.equal(String(id), 'ws-1')
  assert.equal(
    client.calls.filter((c) => c.method === 'workspace.rename').length,
    0,
    '命中已有工作区时不应发 workspace.rename',
  )

  await state.dispose()
})

test('createWorkspace 只在新建且标题不同时才 rename', async () => {
  const client = new FakeClient()
  const state = await readyState(client)

  const fresh = { workspaceId: 'ws-2', path: '/new', title: 'new', sessionIds: [] }
  client.onCall('workspace.create', () => ok({ workspace: fresh, created: true }))
  client.onCall('workspace.rename', () => ok({ workspace: { ...fresh, title: '我要的标题' } }))

  await state.createWorkspace('/new', '我要的标题')
  assert.equal(client.calls.filter((c) => c.method === 'workspace.rename').length, 1)

  client.calls.length = 0
  await state.createWorkspace('/new', 'new')
  assert.equal(
    client.calls.filter((c) => c.method === 'workspace.rename').length,
    0,
    '标题已经一致时不应 rename',
  )

  await state.dispose()
})

test('host/remote-event 原样转给 onRemoteEvent 订阅者（commands/change 就是这条路）', async () => {
  const client = new FakeClient()
  const state = await readyState(client)

  const seen: { event: string; args: readonly unknown[] }[] = []
  const unsub = state.onRemoteEvent((event, args) => seen.push({ event, args }))

  client.emitHost({ type: 'host/remote-event', event: 'commands/change', args: [] })
  assert.deepEqual(seen, [{ event: 'commands/change', args: [] }])

  client.emitHost({ type: 'host/remote-event', event: 'skills/change', args: ['x'] })
  assert.equal(seen.length, 2, '别的 remote 事件也转发，不过滤——过滤是订阅者的事')

  unsub()
  client.emitHost({ type: 'host/remote-event', event: 'commands/change', args: [] })
  assert.equal(seen.length, 2, '退订后不再收')

  await state.dispose()
})
