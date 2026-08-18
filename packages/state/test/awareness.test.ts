/**
 * A 批感知类事件的折叠验收：llm/retry 配对、todo/write last-write-wins、
 * command/run↔done 配对、compaction/* 只认 type 折一条横线、
 * plan/mode 只落一个比特、session/queue 帧进 summary。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createState, type ConversationView, type DshrState } from '@dshr/state'
import {
  assistantMessage,
  commandDone,
  commandRun,
  entry,
  eventFrame,
  extensionEvent,
  FakeClient,
  llmRetry,
  llmRetryStarted,
  ok,
  queueFrame,
  rid,
  settle,
  sid,
  todoWrite,
  type SessionEvent,
} from './fake-client.ts'

async function openConversation(
  client: FakeClient,
  tailEvents: SessionEvent[],
): Promise<{ state: DshrState; conversation: ConversationView }> {
  client.stubBaseline()
  client.onCall('session.history', () => ok({ events: tailEvents.map((event) => entry(event)), hasMore: false }))
  const state = createState({ client })
  client.setReady(1)
  await settle()
  const s1 = sid('s1')
  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true })
  const conversation = state.conversation(s1)
  await settle()
  return { state, conversation }
}

test('llm/retry 立行：attempt/maxRetries/code 照抄载荷；retry-started 按 retryId 配对置 started', async () => {
  const client = new FakeClient()
  const { state, conversation } = await openConversation(client, [])
  const s1 = sid('s1')

  client.emitMux(eventFrame(s1, llmRetry(1, 'r-1', 1, 2, 'RATE_LIMIT')), rid('c1'))
  let item = conversation.items[0]
  assert.ok(item && item.kind === 'retry')
  assert.equal(item.retryId, 'r-1')
  assert.equal(item.attempt, 1)
  assert.equal(item.maxRetries, 2)
  assert.equal(item.code, 'RATE_LIMIT')
  assert.equal(item.started, false)

  client.emitMux(eventFrame(s1, llmRetryStarted(2, 'r-1', 1)), rid('c2'))
  assert.equal(conversation.items.length, 1, '配对后是同一项，不是两条')
  const next = conversation.items[0]
  assert.ok(next && next.kind === 'retry')
  assert.equal(next.started, true)
  assert.notEqual(next, item, '换新对象，不原地改（memo 的行组件靠它重渲染）')
  assert.equal(next.code, 'RATE_LIMIT')

  // 第二次重试是另一对
  client.emitMux(eventFrame(s1, llmRetry(3, 'r-2', 2, 2, 'SERVER')), rid('c3'))
  client.emitMux(eventFrame(s1, llmRetryStarted(4, 'r-2', 2)), rid('c4'))
  assert.equal(conversation.items.length, 2)
  item = conversation.items[1]
  assert.ok(item && item.kind === 'retry' && item.attempt === 2 && item.code === 'SERVER' && item.started)

  await state.dispose()
})

test('孤儿 llm/retry-started（页边界外没见过它的 retry）：补一条已开打项，code/maxRetries 缺省', async () => {
  const client = new FakeClient()
  const { state, conversation } = await openConversation(client, [])
  client.emitMux(eventFrame(sid('s1'), llmRetryStarted(1, 'r-x', 1)), rid('c1'))
  const item = conversation.items[0]
  assert.ok(item && item.kind === 'retry')
  assert.equal(item.started, true)
  assert.equal(item.code, undefined)
  assert.equal(item.maxRetries, undefined)
  await state.dispose()
})

test('todo/write：整表快照 last-write-wins，原地换新对象，视图里只有一份', async () => {
  const client = new FakeClient()
  const { state, conversation } = await openConversation(client, [])
  const s1 = sid('s1')

  client.emitMux(
    eventFrame(s1, todoWrite(1, [{ content: '读契约', status: 'in_progress' }, { content: '实现', status: 'pending' }])),
    rid('c1'),
  )
  const first = conversation.items[0]
  assert.ok(first && first.kind === 'todo')
  assert.equal(first.todos.length, 2)

  client.emitMux(
    eventFrame(
      s1,
      todoWrite(2, [{ content: '读契约', status: 'completed' }, { content: '实现', status: 'in_progress' }]),
    ),
    rid('c2'),
  )
  assert.equal(conversation.items.length, 1, '覆盖而不是追加')
  const second = conversation.items[0]
  assert.ok(second && second.kind === 'todo')
  assert.equal(second.id, first.id, '同一份表的位置不动')
  assert.notEqual(second, first, '换新对象')
  assert.deepEqual(
    second.todos.map((t) => t.status),
    ['completed', 'in_progress'],
  )

  await state.dispose()
})

test('command/run ↔ command/done 按 commandId 配对；kind=error 置 error 并带 text', async () => {
  const client = new FakeClient()
  const { state, conversation } = await openConversation(client, [])
  const s1 = sid('s1')

  client.emitMux(eventFrame(s1, commandRun(1, 'cmd-1', 'compact', '--force')), rid('c1'))
  let item = conversation.items[0]
  assert.ok(item && item.kind === 'command')
  assert.equal(item.name, 'compact')
  assert.equal(item.args, '--force')
  assert.equal(item.status, 'running')

  client.emitMux(eventFrame(s1, commandDone(2, 'cmd-1', 'success', 'compacted')), rid('c2'))
  assert.equal(conversation.items.length, 1)
  item = conversation.items[0]
  assert.ok(item && item.kind === 'command')
  assert.equal(item.status, 'ok')
  assert.equal(item.text, 'compacted')

  client.emitMux(eventFrame(s1, commandRun(3, 'cmd-2', 'model')), rid('c3'))
  client.emitMux(eventFrame(s1, commandDone(4, 'cmd-2', 'error', 'no such model')), rid('c4'))
  const failed = conversation.items[1]
  assert.ok(failed && failed.kind === 'command')
  assert.equal(failed.status, 'error')
  assert.equal(failed.text, 'no such model')

  // 孤儿 done：补一条已完结项
  client.emitMux(eventFrame(s1, commandDone(5, 'cmd-x', 'success')), rid('c5'))
  const orphan = conversation.items[2]
  assert.ok(orphan && orphan.kind === 'command' && orphan.status === 'ok' && orphan.name === '')

  await state.dispose()
})

test('compaction/*：一段连续事件只折一条 Compaction 横线；只认 type 不碰 data', async () => {
  const client = new FakeClient()
  const { state, conversation } = await openConversation(client, [])
  const s1 = sid('s1')

  for (const [i, type] of ['compaction/start', 'compaction/summary', 'compaction/prune', 'compaction/end'].entries()) {
    client.emitMux(eventFrame(s1, extensionEvent(i + 1, type)), rid(`c${i}`))
  }
  assert.equal(conversation.items.length, 1, '连续一段只出一条')
  const divider = conversation.items[0]
  assert.ok(divider && divider.kind === 'divider' && divider.label === 'Compaction')

  // 中间隔了别的项之后再来一段，是新的线
  client.emitMux(eventFrame(s1, assistantMessage(5, [{ type: 'text', text: '答' }])), rid('c5'))
  client.emitMux(eventFrame(s1, extensionEvent(6, 'compaction/start')), rid('c6'))
  assert.equal(conversation.items.length, 3)
  assert.ok(conversation.items[2]?.kind === 'divider')

  await state.dispose()
})

test('plan/mode：只落「发生过」一个比特到 summary，不产生会话视图项', async () => {
  const client = new FakeClient()
  const { state, conversation } = await openConversation(client, [])
  const s1 = sid('s1')
  assert.equal(state.sessions.get(s1)?.planModeSeen, undefined)

  client.emitMux(eventFrame(s1, extensionEvent(1, 'plan/mode')), rid('c1'))
  assert.equal(conversation.items.length, 0)
  assert.equal(state.sessions.get(s1)?.planModeSeen, true)

  await state.dispose()
})

test('session/queue 帧：排队文本进 summary；空快照清掉', async () => {
  const client = new FakeClient()
  const { state } = await openConversation(client, [])
  const s1 = sid('s1')
  assert.equal(state.sessions.get(s1)?.queue, undefined)

  client.emitMux(queueFrame(s1, ['说一句话', '再来一句']), rid('q1'))
  let queue = state.sessions.get(s1)?.queue
  assert.ok(queue)
  assert.deepEqual(
    queue.map((q) => q.text),
    ['说一句话', '再来一句'],
  )

  client.emitMux(queueFrame(s1, []), rid('q2'))
  queue = state.sessions.get(s1)?.queue
  assert.equal(queue, undefined, '空了就不设（exactOptionalPropertyTypes）')

  await state.dispose()
})

test('历史页里的 A 批事件与实时帧走同一个 fold', async () => {
  const client = new FakeClient()
  const { state, conversation } = await openConversation(client, [
    llmRetry(1, 'r-1', 1, 2, 'TIMEOUT'),
    todoWrite(2, [{ content: '旧事', status: 'completed' }]),
    extensionEvent(3, 'compaction/start'),
    extensionEvent(4, 'plan/mode'),
  ])
  assert.deepEqual(
    conversation.items.map((item) => item.kind),
    ['retry', 'todo', 'divider'],
  )
  assert.equal(state.sessions.get(sid('s1'))?.planModeSeen, true)
  await state.dispose()
})
