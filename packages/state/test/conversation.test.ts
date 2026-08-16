/**
 * 会话视图折叠的验收测试：assistant/chunk 流式拼接（BlockAssembler 路径）、
 * 工具调用按 callId 折叠、view 原样保留、loadOlder 翻页。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createState, type ConversationView, type DshrState } from '@dshr/state'
import {
  assistantMessage,
  blockEnd,
  entry,
  eventFrame,
  FakeClient,
  ok,
  reasoningDelta,
  rid,
  settle,
  sid,
  textDelta,
  toolCall,
  toolResult,
  userMessage,
  type SessionEvent,
  type ToolEventView,
} from './fake-client.ts'

async function openConversation(
  client: FakeClient,
  tailEvents: SessionEvent[],
  options: { hasMore?: boolean; projections?: { asOfSeq: number; values: Record<string, unknown> } } = {},
): Promise<{ state: DshrState; conversation: ConversationView }> {
  client.stubBaseline()
  client.onCall('session.history', () =>
    ok({
      events: tailEvents.map((event) => entry(event)),
      hasMore: options.hasMore ?? false,
      ...(options.projections ? { projections: options.projections } : {}),
    }),
  )
  const state = createState({ client })
  client.setReady(1)
  await settle()
  const s1 = sid('s1')
  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true })
  const conversation = state.conversation(s1)
  await settle()
  return { state, conversation }
}

test('流式拼接：text-delta 追加、block-end 收尾、streaming 位如实', async () => {
  const client = new FakeClient()
  const { state, conversation } = await openConversation(client, [])
  const s1 = sid('s1')

  client.emitMux(eventFrame(s1, textDelta(1, 'Hel')), rid('c1'))
  let item = conversation.items[0]
  assert.ok(item && item.kind === 'assistant')
  assert.equal(item.text, 'Hel')
  assert.equal(item.streaming, true)

  client.emitMux(eventFrame(s1, textDelta(2, 'lo')), rid('c2'))
  assert.equal(conversation.items.length, 1)
  item = conversation.items[0]
  assert.ok(item && item.kind === 'assistant')
  assert.equal(item.text, 'Hello')
  assert.equal(item.streaming, true)

  // reasoning 走另一条流，立独立的项
  client.emitMux(eventFrame(s1, reasoningDelta(3, '想一下')), rid('c3'))
  assert.equal(conversation.items.length, 2)
  const reasoning = conversation.items[1]
  assert.ok(reasoning && reasoning.kind === 'reasoning')
  assert.equal(reasoning.text, '想一下')
  assert.equal(reasoning.streaming, true)

  // block-end 携带组装好的整块，是权威终态
  client.emitMux(eventFrame(s1, blockEnd(4, 0, { type: 'text', text: 'Hello world' })), rid('c4'))
  item = conversation.items[0]
  assert.ok(item && item.kind === 'assistant')
  assert.equal(item.text, 'Hello world')
  assert.equal(item.streaming, false)
  // reasoning 还没收尾
  assert.ok(conversation.items[1]?.kind === 'reasoning' && conversation.items[1].streaming === true)

  client.emitMux(eventFrame(s1, blockEnd(5, 1, { type: 'reasoning', text: '想一下！' })), rid('c5'))
  assert.ok(conversation.items[1]?.kind === 'reasoning' && conversation.items[1].streaming === false)

  // assistant/message 是这一步的终态：收尾，不重复建项
  client.emitMux(
    eventFrame(s1, assistantMessage(6, [{ type: 'text', text: 'Hello world' }, { type: 'reasoning', text: '想一下！' }])),
    rid('c6'),
  )
  assert.equal(conversation.items.length, 2)
  assert.ok(conversation.items.every((i) => !('streaming' in i) || !i.streaming))

  await state.dispose()
})

test('历史页里的 in-flight partial 保持 streaming，后续实时帧接着拼', async () => {
  const client = new FakeClient()
  const { state, conversation } = await openConversation(client, [
    userMessage(0, '问'),
    textDelta(1, '半截'),
  ])
  const s1 = sid('s1')

  assert.equal(conversation.items.length, 2)
  const partial = conversation.items[1]
  assert.ok(partial && partial.kind === 'assistant' && partial.streaming && partial.text === '半截')

  // 实时帧接续同一个块（seq 高于水位才放行）
  client.emitMux(eventFrame(s1, textDelta(1, '重复的旧帧')), rid('dup')) // seq 1 ≤ 水位，丢弃
  client.emitMux(eventFrame(s1, textDelta(2, '接上了')), rid('c2'))
  const item = conversation.items[1]
  assert.ok(item && item.kind === 'assistant')
  assert.equal(item.text, '半截接上了')

  await state.dispose()
})

test('工具调用折叠：call/result 按 callId 配成一项，view 原样保留', async () => {
  const client = new FakeClient()
  const { state, conversation } = await openConversation(client, [])
  const s1 = sid('s1')

  const callView = { for: 'call', view: { kind: 'call-card', command: 'ls' } } as unknown as ToolEventView
  client.emitMux(eventFrame(s1, toolCall(1, 'call-1', 'bash', '{"cmd":"ls"}'), callView), rid('c1'))
  let item = conversation.items[0]
  assert.ok(item && item.kind === 'tool')
  assert.equal(item.callId, 'call-1')
  assert.equal(item.name, 'bash')
  assert.equal(item.status, 'running')
  assert.equal(item.args, '{"cmd":"ls"}')
  assert.equal(item.view, callView) // host 算好的渲染意图，原样保留

  const resultView = { for: 'result', view: { kind: 'result-card', lines: 3 } } as unknown as ToolEventView
  client.emitMux(eventFrame(s1, toolResult(2, 'call-1', 'file.txt'), resultView), rid('c2'))
  assert.equal(conversation.items.length, 1) // 配成一项，不是两条
  item = conversation.items[0]
  assert.ok(item && item.kind === 'tool')
  assert.equal(item.status, 'ok')
  assert.deepEqual(item.result, [{ type: 'text', text: 'file.txt' }])
  assert.equal(item.view, resultView) // result 的渲染意图取代 call 的

  // 失败的工具：data.error 或 isError 都算 error
  client.emitMux(eventFrame(s1, toolCall(3, 'call-2', 'bash', '{"cmd":"rm -rf /"}')), rid('c3'))
  client.emitMux(eventFrame(s1, toolResult(4, 'call-2', 'denied', true)), rid('c4'))
  const failed = conversation.items[1]
  assert.ok(failed && failed.kind === 'tool')
  assert.equal(failed.status, 'error')

  await state.dispose()
})

test('loadOlder：往前翻页、prepend、页不带 projections 块所以不动投影', async () => {
  const client = new FakeClient()
  const { state, conversation } = await openConversation(
    client,
    [userMessage(10, '第二个问题'), assistantMessage(11, [{ type: 'text', text: '第二个回答' }])],
    { hasMore: true, projections: { asOfSeq: 11, values: { title: '标题' } } },
  )
  assert.equal(conversation.hasOlder, true)
  assert.equal(state.sessions.get(sid('s1'))?.title, '标题')

  client.onCall('session.history', (payload) => {
    assert.equal(payload.beforeSeq, 10) // 以最旧已见 seq 为锚
    return ok({
      events: [entry(userMessage(3, '第一个问题')), entry(assistantMessage(4, [{ type: 'text', text: '第一个回答' }]))],
      hasMore: false,
      // 注意：loadOlder 的页没有 projections 块
    })
  })
  await conversation.loadOlder()

  assert.deepEqual(
    conversation.items.map((item) => ('text' in item ? item.text : '')),
    ['第一个问题', '第一个回答', '第二个问题', '第二个回答'],
  )
  assert.equal(conversation.hasOlder, false)
  assert.equal(state.sessions.get(sid('s1'))?.title, '标题') // 投影没被动过

  await state.dispose()
})

test('流式更新换的是新对象，不是原地改（memo 的行组件靠它才会重渲染）', async () => {
  const client = new FakeClient()
  const { state, conversation } = await openConversation(client, [])
  const s1 = sid('s1')

  client.emitMux(eventFrame(s1, textDelta(1, 'Hel')), rid('c1'))
  const first = conversation.items[0]
  assert.ok(first && first.kind === 'assistant')

  client.emitMux(eventFrame(s1, textDelta(2, 'lo')), rid('c2'))
  const second = conversation.items[0]
  assert.ok(second && second.kind === 'assistant')
  assert.equal(second.text, 'Hello')

  // ⚠️ 这是本条测试的全部意义：UI 的行组件用 React.memo 按 item 做浅比较。
  // 原地改字段时引用不变，memo 跳过重渲染，助手消息就只剩一个光标、一个字都不出来。
  assert.notEqual(second, first, '流式更新必须产生新的 item 对象')
  assert.equal(first.text, 'Hel', '旧对象不该被改动')

  await state.dispose()
})

test('history 读取失败：错误进会话视图，不静默吞掉', async () => {
  const client = new FakeClient()
  client.stubBaseline()
  client.onCall('session.history', () =>
    ({ ok: false, error: { code: 'session-not-found', message: 'no such session', details: { sessionId: sid('s1') } } }) as never,
  )
  const state = createState({ client })
  client.setReady(1)
  await settle()
  const conversation = state.conversation(sid('s1'))
  await settle()
  const item = conversation.items[0]
  assert.ok(item && item.kind === 'error')
  assert.match(item.message, /session-not-found/)
  await state.dispose()
})
