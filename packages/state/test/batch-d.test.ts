/**
 * D 批的 state 层验收：`session/jobs` 快照进 summary、`session.updateQueue` 的
 * remove、`skill.list` 的只读拉取、`session.prompt` 带图的 content 形状。
 * 全部用 FakeClient 喂帧，不连真 host。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createState, type DshrState } from '@dshr/state'
import { FakeClient, ok, rid, settle, sid } from './fake-client.ts'
import type { JobItem } from '@dshr/state'
import type { MuxFrame } from '@dshr/protocol'

async function readyState(client: FakeClient): Promise<DshrState> {
  client.stubBaseline()
  const state = createState({ client })
  client.setReady(1)
  await settle()
  return state
}

function jobsFrame(sessionId: ReturnType<typeof sid>, jobs: Partial<JobItem>[]): MuxFrame {
  return {
    type: 'session/jobs',
    sessionId,
    jobs: jobs.map((job, i) => ({
      id: job.id ?? `bash-${i + 1}`,
      kind: job.kind ?? 'bash',
      label: job.label ?? `job ${i}`,
      status: job.status ?? 'running',
      ...(job.detail !== undefined ? { detail: job.detail } : {}),
      startedAt: job.startedAt ?? 1_000,
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    })),
  } as unknown as MuxFrame
}

test('session/jobs 帧：整份快照进 summary；空快照清掉', async () => {
  const client = new FakeClient()
  const state = await readyState(client)
  const s1 = sid('s1')
  assert.equal(state.sessions.get(s1)?.jobs, undefined)

  client.emitMux(
    jobsFrame(s1, [
      { id: 'bash-1', label: 'sleep 30', status: 'running', startedAt: 1_000 },
      { id: 'bash-2', label: 'npm test', status: 'failed', detail: 'exit code: 1', startedAt: 500, finishedAt: 900 },
    ]),
    rid('j1'),
  )
  let jobs = state.sessions.get(s1)?.jobs
  assert.ok(jobs)
  assert.equal(jobs.length, 2)
  assert.deepEqual(
    jobs.map((j) => [j.id, j.label, j.status]),
    [
      ['bash-1', 'sleep 30', 'running'],
      ['bash-2', 'npm test', 'failed'],
    ],
  )
  assert.equal(jobs[1]?.detail, 'exit code: 1')

  // 下一份快照整份替换（任务从 running 翻到 completed）
  client.emitMux(jobsFrame(s1, [{ id: 'bash-1', label: 'sleep 30', status: 'completed', startedAt: 1_000, finishedAt: 2_000 }]), rid('j2'))
  jobs = state.sessions.get(s1)?.jobs
  assert.equal(jobs?.length, 1)
  assert.equal(jobs?.[0]?.status, 'completed')

  client.emitMux(jobsFrame(s1, []), rid('j3'))
  assert.equal(state.sessions.get(s1)?.jobs, undefined, '空了就不设（exactOptionalPropertyTypes）')

  await state.dispose()
})

test('removeQueuedMessage：打 session.updateQueue 的 remove，itemId 原样透传', async () => {
  const client = new FakeClient()
  client.onCall('session.updateQueue', () => ok({ accepted: true as const }))
  const state = await readyState(client)

  await state.removeQueuedMessage(sid('s1'), 'q-9')
  const call = client.calls.find((c) => c.method === 'session.updateQueue')
  assert.ok(call)
  assert.deepEqual(call.payload, { sessionId: 's1', itemId: 'q-9', action: { kind: 'remove' } })

  await state.dispose()
})

test('removeQueuedMessage：host 报错时抛出来（调用方要能把理由摆出来）', async () => {
  const client = new FakeClient()
  client.onCall('session.updateQueue', () => ({ ok: false, error: { code: 'not-found', message: 'no such item', details: {} } }))
  const state = await readyState(client)

  await assert.rejects(() => state.removeQueuedMessage(sid('s1'), 'q-nope'), /not-found: no such item/)
  await state.dispose()
})

test('listSkills：只读拉取并裁成展示要的三个字段', async () => {
  const client = new FakeClient()
  client.onCall('skill.list', (payload) => {
    assert.deepEqual(payload, { sessionId: 's1' }, '实测 sessionId 必填')
    return ok({
      skills: [
        { name: 'review', description: '评审一轮改动', modelInvocable: true, whenToUse: '改完代码后' },
        { name: 'handoff', description: '交接会话', modelInvocable: false },
      ],
    })
  })
  const state = await readyState(client)

  const skills = await state.listSkills(sid('s1'))
  assert.deepEqual(skills, [
    { name: 'review', description: '评审一轮改动', modelInvocable: true },
    { name: 'handoff', description: '交接会话', modelInvocable: false },
  ])
  await state.dispose()
})

test('prompt 带图：图片字节随 content 一起发，没有单独的上传调用', async () => {
  const client = new FakeClient()
  client.onCall('session.prompt', () => ok({ accepted: true as const }))
  const state = await readyState(client)

  await state.prompt(sid('s1'), '看这张图', [
    { name: 'a.png', mediaType: 'image/png', data: 'aGVsbG8=', bytes: 5, width: 1, height: 1 },
  ])
  const call = client.calls.find((c) => c.method === 'session.prompt')
  assert.ok(call)
  assert.deepEqual(call.payload, {
    sessionId: 's1',
    mode: 'queue',
    content: [
      { type: 'text', text: '看这张图' },
      { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'a.png' },
    ],
  })
  // 没有别的调用（不存在「先上传」）
  assert.equal(client.calls.filter((c) => c.method !== 'session.prompt' && !c.method.startsWith('session.list') && !c.method.startsWith('workspace.list')).length, 0)
  await state.dispose()
})
