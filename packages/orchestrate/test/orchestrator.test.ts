/**
 * `@dshr/orchestrate` 的动词测试：全部用 FakeDshrClient 喂帧，不碰网络。
 *
 * 运行前提是 `tsc --build packages/orchestrate` 已跑过（测试 import 的是
 * 编译产物 ../lib/index.js——Node 不做 .js→.ts 回退，这是刻意选择：
 * 测的就是发布出去的那份代码）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ABSOLUTE_MAX_WORKERS,
  DEFAULT_MAX_WORKERS,
  OrchestratorCallError,
  WorkerLimitError,
  createOrchestrator,
} from '../lib/index.js'
import type { Orchestrator, SessionId, SettledWorker, WorkerHandle } from '../lib/index.js'
import type { HostFrame, MuxFrame } from '@dshr/protocol'
import { FakeDshrClient, fakeRpcId } from './fake-client.ts'

const sid = (s: string): SessionId => s as SessionId

function running(sessionId: string, isRunning: boolean): HostFrame {
  return { type: 'host/session-status', sessionId: sid(sessionId), running: isRunning }
}

/** 断言 p 在当前事件循环回合内没有 settle（wait 确实在阻塞，不是轮询也不是立即返回）。 */
async function assertPending<T>(p: Promise<T>): Promise<void> {
  const raced = await Promise.race([
    p.then(() => 'settled'),
    new Promise<string>((r) => setTimeout(() => r('pending'), 25)),
  ])
  assert.equal(raced, 'pending')
}

async function spawnOne(
  orch: Orchestrator,
  task = 'do the thing',
): Promise<{ handle: WorkerHandle; sessionId: string }> {
  const handle = await orch.spawn({ task, cwd: '/repo' })
  return { handle, sessionId: handle.sessionId }
}

test('spawn: 一个 worker = session.create + session.prompt，输入原样透传', async () => {
  const client = new FakeDshrClient()
  const orch = createOrchestrator({ client })

  const handle = await orch.spawn({
    task: 'fix the tests',
    cwd: '/repo',
    title: 't1',
    purpose: '评审用的，不透明', // 本包不许读它，但必须原样保留
    agentPreset: 'reviewer',
  })

  const creates = client.callsOf('session.create')
  assert.equal(creates.length, 1)
  assert.deepEqual(creates[0]?.payload, { cwd: '/repo', agentPreset: 'reviewer' })

  const prompts = client.callsOf('session.prompt')
  assert.equal(prompts.length, 1)
  assert.deepEqual(prompts[0]?.payload, {
    sessionId: handle.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: 'fix the tests' }],
  })

  assert.equal(handle.workerId, handle.sessionId)
  assert.equal(handle.purpose, '评审用的，不透明')
  assert.equal(handle.title, 't1')
  assert.equal(handle.agentPreset, 'reviewer')
  assert.equal(handle.status, 'working')
  assert.equal(orch.list().length, 1)
})

test('spawn 超过上限直接拒绝（WorkerLimitError），不排队', async () => {
  const client = new FakeDshrClient()
  const orch = createOrchestrator({ client, maxWorkers: 2 })

  await spawnOne(orch, 'a')
  await spawnOne(orch, 'b')
  assert.equal(client.callsOf('session.create').length, 2)

  await assert.rejects(orch.spawn({ task: 'c', cwd: '/repo' }), (err: unknown) => {
    assert.ok(err instanceof WorkerLimitError)
    assert.equal(err.limit, 2)
    return true
  })
  // 没有第三个 session.create：被拒绝的 spawn 什么都没发生
  assert.equal(client.callsOf('session.create').length, 2)
  assert.equal(orch.list().length, 2)

  // 绝对上界钉死在 50
  assert.equal(ABSOLUTE_MAX_WORKERS, 50)
  assert.throws(() => createOrchestrator({ client, maxWorkers: 51 }), RangeError)
})

test('setLimit：「人设过」与「默认值」是两个可区分的概念', async () => {
  const client = new FakeDshrClient()
  const orch = createOrchestrator({ client })

  // 从没设过：有效值是默认值，explicitLimit 是 null（持久化层此时不该写盘）
  assert.equal(orch.limit, DEFAULT_MAX_WORKERS)
  assert.equal(orch.explicitLimit, null)

  orch.setLimit(5)
  assert.equal(orch.limit, 5)
  assert.equal(orch.explicitLimit, 5)

  assert.throws(() => orch.setLimit(0), RangeError)
  assert.throws(() => orch.setLimit(ABSOLUTE_MAX_WORKERS + 1), RangeError)
  assert.throws(() => orch.setLimit(2.5), RangeError)
  // 抛错不改状态
  assert.equal(orch.limit, 5)

  // 构造参数也算「人设的」
  const orch2 = createOrchestrator({ client: new FakeDshrClient(), maxWorkers: 3 })
  assert.equal(orch2.limit, 3)
  assert.equal(orch2.explicitLimit, 3)

  // 调小后立即生效：额度被占满时 spawn 被拒
  orch.setLimit(1)
  await spawnOne(orch)
  await assert.rejects(orch.spawn({ task: 'x', cwd: '/repo' }), WorkerLimitError)
})

test('wait：host/session-status{running:false} 到达时以 done 返回（事件驱动，非轮询）', async () => {
  const client = new FakeDshrClient()
  const orch = createOrchestrator({ client })
  const { handle, sessionId } = await spawnOne(orch)

  const p = orch.wait()
  await assertPending(p) // 没有帧，wait 一直阻塞

  client.emitHost(running(sessionId, false))
  const settled = await p
  assert.equal(settled.length, 1)
  assert.equal(settled[0]?.workerId, handle.workerId)
  assert.equal(settled[0]?.outcome, 'done') // 首个 task 轮次跑完 → done
  assert.equal(settled[0]?.error, undefined)
  assert.equal(handle.status, 'idle')

  // settle 被收走后，没有新帧时 wait 继续阻塞
  const p2 = orch.wait()
  await assertPending(p2)
  client.emitHost(running(sessionId, true))
  client.emitHost(running(sessionId, false))
  const settled2 = await p2
  assert.equal(settled2[0]?.outcome, 'idle') // 后续轮次 → idle
})

test('wait：send 之后旧 settle 作废，下一轮跑完才再 settle', async () => {
  const client = new FakeDshrClient()
  const orch = createOrchestrator({ client })
  const { sessionId } = await spawnOne(orch)

  client.emitHost(running(sessionId, false))
  const first = await orch.wait()
  assert.equal(first[0]?.outcome, 'done')

  const res = await orch.send(sessionId, '再改一处')
  assert.deepEqual(res, { submitted: true })
  assert.equal(client.callsOf('session.prompt').length, 2)

  client.emitHost(running(sessionId, true))
  const p = orch.wait()
  await assertPending(p)
  client.emitHost(running(sessionId, false))
  const second = await p
  assert.equal(second[0]?.outcome, 'idle')
})

test('wait：approval/requested 到达时以 blocked 返回，blocked 是 settle 不是错误', async () => {
  const client = new FakeDshrClient()
  const orch = createOrchestrator({ client })
  const { handle, sessionId } = await spawnOne(orch)

  const approvalRpcId = fakeRpcId('approval')
  client.emitMux(
    {
      type: 'approval/requested',
      sessionId: sid(sessionId),
      approvalId: sid('appr-1'),
      toolName: 'bash',
      reason: 'rm -rf dist',
    } as MuxFrame,
    approvalRpcId,
  )

  const settled = await orch.wait() // 立刻返回，不需要等 running:false
  assert.equal(settled.length, 1)
  assert.equal(settled[0]?.outcome, 'blocked')
  assert.equal(settled[0]?.error, undefined) // blocked 不是错误
  assert.equal(handle.status, 'blocked')

  const pending = settled[0]?.pending
  assert.equal(pending?.length, 1)
  assert.equal(pending?.[0]?.kind, 'approval')
  assert.equal(pending?.[0]?.rpcId, approvalRpcId) // 调用者拿它去 client.respond
  if (pending?.[0]?.kind === 'approval') {
    assert.equal(pending[0].toolName, 'bash')
    assert.equal(pending[0].reason, 'rm -rf dist')
  }

  // 审批被（调用者经由 client.respond）解决后，worker 复活；轮次真正结束时再 settle
  client.emitMux({
    type: 'approval/resolved',
    sessionId: sid(sessionId),
    approvalId: sid('appr-1'),
    outcome: 'approved-once',
  } as MuxFrame)
  assert.equal(handle.status, 'working')
  assert.equal(handle.settled, false)

  const p = orch.wait()
  await assertPending(p)
  client.emitHost(running(sessionId, false))
  const after = await p
  assert.equal(after[0]?.outcome, 'done')
})

test('wait：question/requested 也算 blocked，按 questionRpcId 解除', async () => {
  const client = new FakeDshrClient()
  const orch = createOrchestrator({ client })
  const { sessionId } = await spawnOne(orch)

  const questionRpcId = fakeRpcId('question')
  client.emitMux(
    {
      type: 'question/requested',
      sessionId: sid(sessionId),
      questions: [{ question: 'which file?', options: [] }],
    } as MuxFrame,
    questionRpcId,
  )

  const settled = await orch.wait()
  assert.equal(settled[0]?.outcome, 'blocked')
  assert.equal(settled[0]?.pending[0]?.kind, 'question')
  assert.equal(settled[0]?.pending[0]?.rpcId, questionRpcId)

  client.emitMux({
    type: 'question/resolved',
    sessionId: sid(sessionId),
    questionRpcId,
    outcome: 'answered',
  } as MuxFrame)
  client.emitHost(running(sessionId, false))
  const after = await orch.wait()
  assert.equal(after[0]?.outcome, 'done')
})

test('cancel：interrupt 只中止当前轮（还占额度、还能 send）；terminate 除名并释放额度', async () => {
  const client = new FakeDshrClient()
  const orch = createOrchestrator({ client, maxWorkers: 1 })

  // interrupt：worker 还在编排里
  const { sessionId } = await spawnOne(orch)
  await orch.cancel(sessionId, 'interrupt')
  assert.equal(client.callsOf('session.cancel').length, 1)
  assert.deepEqual(client.callsOf('session.cancel')[0]?.payload, { sessionId })
  assert.equal(orch.list().length, 1) // 没除名

  const sent = await orch.send(sessionId, 'continue')
  assert.deepEqual(sent, { submitted: true }) // 还能 send

  // interrupt 后还占额度：上限 1，第二个 spawn 被拒
  await assert.rejects(orch.spawn({ task: 'b', cwd: '/repo' }), WorkerLimitError)

  // terminate：除名、释放额度；会话本身不删（没有 delete 类调用）
  await orch.cancel(sessionId, 'terminate')
  assert.equal(client.callsOf('session.cancel').length, 2)
  assert.equal(orch.list().length, 0)

  const gone = await orch.send(sessionId, 'anyone there?')
  assert.deepEqual(gone, { submitted: false })

  // 额度已释放：可以 spawn 新的
  const replacement = await spawnOne(orch, 'b')
  assert.notEqual(replacement.sessionId, sessionId)

  // 句柄还在，但如实报告 terminated
  const dead = await orch.send(sessionId, 'x')
  assert.deepEqual(gone, dead)
})

test('wait(workerIds)：只等指定子集；别的 worker settle 不唤醒它', async () => {
  const client = new FakeDshrClient()
  const orch = createOrchestrator({ client })
  const a = await spawnOne(orch, 'a')
  const b = await spawnOne(orch, 'b')

  const p: Promise<SettledWorker[]> = orch.wait([b.handle.workerId])
  client.emitHost(running(a.sessionId, false)) // a settle 了，但不归这个 wait 管
  await assertPending(p)

  client.emitHost(running(b.sessionId, false))
  const settled = await p
  assert.equal(settled.length, 1)
  assert.equal(settled[0]?.workerId, b.handle.workerId)

  // a 的 settle 还挂着，不带过滤器的 wait 会收走它
  const rest = await orch.wait()
  assert.deepEqual(rest.map((s) => s.workerId), [a.handle.workerId])
})

test('host/agent-error → 以 error settle；host/session-removed 同样', async () => {
  const client = new FakeDshrClient()
  const orch = createOrchestrator({ client })
  const a = await spawnOne(orch, 'a')
  const b = await spawnOne(orch, 'b')

  client.emitHost({ type: 'host/agent-error', sessionId: sid(a.sessionId), message: 'boom' } as HostFrame)
  client.emitHost({ type: 'host/session-removed', sessionId: sid(b.sessionId) } as HostFrame)

  const settled = await orch.wait()
  assert.equal(settled.length, 2)
  const byId = new Map(settled.map((s) => [s.workerId, s]))
  assert.equal(byId.get(a.handle.workerId)?.outcome, 'error')
  assert.equal(byId.get(a.handle.workerId)?.error, 'boom')
  assert.equal(byId.get(b.handle.workerId)?.outcome, 'error')
  assert.equal(a.handle.status, 'error')
})

test('业务错误：spawn 时 session.create / session.prompt 失败抛 OrchestratorCallError；send 失败返回 submitted:false', async () => {
  const client = new FakeDshrClient()
  const orch = createOrchestrator({ client })

  client.failCall('session.create', 'disk full')
  await assert.rejects(orch.spawn({ task: 'x', cwd: '/repo' }), (err: unknown) => {
    assert.ok(err instanceof OrchestratorCallError)
    assert.equal(err.method, 'session.create')
    return true
  })
  assert.equal(orch.list().length, 0)

  client.failCall('session.prompt', 'agent busy')
  await assert.rejects(orch.spawn({ task: 'x', cwd: '/repo' }), OrchestratorCallError)
  assert.equal(orch.list().length, 0) // prompt 失败的 spawn 不留记录、不占额度

  const { sessionId } = await spawnOne(orch)
  client.failCall('session.prompt', 'nope')
  assert.deepEqual(await orch.send(sessionId, 'hi'), { submitted: false })
})

test('cancel 对未知 worker 抛错；dispose 后动词失效', async () => {
  const client = new FakeDshrClient()
  const orch = createOrchestrator({ client })
  await assert.rejects(orch.cancel('nope', 'interrupt'), /unknown worker/)
  assert.deepEqual(await orch.send('nope', 'x'), { submitted: false })

  const { sessionId } = await spawnOne(orch)
  orch.dispose()
  client.emitHost(running(sessionId, false)) // 已退订，帧不再生效
  assert.equal(orch.list().length, 0)
})

test('cancel 的 session.cancel 业务失败会抛错，且 worker 不被除名', async () => {
  const client = new FakeDshrClient()
  const orch = createOrchestrator({ client })
  const { sessionId } = await spawnOne(orch)
  client.failCall('session.cancel', 'session gone')
  await assert.rejects(orch.cancel(sessionId, 'interrupt'), OrchestratorCallError)
  assert.equal(orch.list().length, 1) // cancel 失败，worker 还在
})
