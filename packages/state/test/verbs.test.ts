/**
 * C 批动词的验收：切模型 / 切预设 / 重命名 / 分叉 / 会话列表 / search 增强。
 * 载荷形状全部对齐 docs/gap-shapes.md §八 的实测记录（FakeClient 喂，不连真 host）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createState, type DshrState } from '@dshr/state'
import { FakeClient, listItem, ok, settle, sid } from './fake-client.ts'

async function readyState(client: FakeClient): Promise<DshrState> {
  client.stubBaseline()
  const state = createState({ client })
  client.setReady(1)
  await settle()
  return state
}

const MODELS = {
  current: { provider: 'mock', model: 'mock-model' },
  routable: true,
  groups: [
    {
      id: 'mock',
      name: 'Mock',
      models: [{ id: 'mock-model', name: 'Mock Model' }],
    },
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
    },
  ],
  failures: [],
}

test('listModels：返回原样（不转译），并用 current 播种 summary 的 model/provider', async () => {
  const client = new FakeClient()
  client.onCall('session.models', () => ok(MODELS))
  const state = await readyState(client)
  const s1 = sid('s1')
  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true })

  const data = await state.listModels(s1)
  assert.equal(data.groups.length, 2)
  assert.equal(data.current.model, 'mock-model')
  const summary = state.sessions.get(s1)
  assert.equal(summary?.model, 'mock-model')
  assert.equal(summary?.provider, 'mock')

  const call = client.calls.find((c) => c.method === 'session.models')
  assert.deepEqual(call?.payload, { sessionId: 's1' })
  await state.dispose()
})

test('selectModel：载荷 { sessionId, provider, model }，成功后 summary 跟着变', async () => {
  const client = new FakeClient()
  client.onCall('session.selectModel', (payload) => {
    const p = payload as { provider: string; model: string }
    return ok({ selected: { provider: p.provider, model: p.model } })
  })
  const state = await readyState(client)
  const s1 = sid('s1')
  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true })

  await state.selectModel(s1, 'deepseek-official', 'deepseek-v4-flash')
  const call = client.calls.find((c) => c.method === 'session.selectModel')
  assert.deepEqual(call?.payload, {
    sessionId: 's1',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  const summary = state.sessions.get(s1)
  assert.equal(summary?.model, 'deepseek-v4-flash')
  assert.equal(summary?.provider, 'deepseek-official')
  await state.dispose()
})

test('selectModel 失败原样抛错（code 在消息里）', async () => {
  const client = new FakeClient()
  client.onCall('session.selectModel', () => ({
    ok: false,
    error: { code: 'bad-request', message: 'no such model', details: {} },
  }))
  const state = await readyState(client)
  await assert.rejects(
    () => state.selectModel(sid('s1'), 'mock', 'nope'),
    (error: Error) => {
      assert.ok(error.message.includes('bad-request'))
      assert.ok(error.message.includes('no such model'))
      return true
    },
  )
  await state.dispose()
})

test('selectPreset：载荷键是 agentPreset（不是 presetId），成功后 summary.agentPreset 更新', async () => {
  const client = new FakeClient()
  client.onCall('agentPreset.select', (payload) => {
    const p = payload as { agentPreset: string }
    return ok({ agentPreset: p.agentPreset })
  })
  const state = await readyState(client)
  const s1 = sid('s1')
  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true, agentPreset: 'standard' })

  await state.selectPreset(s1, 'code')
  const call = client.calls.find((c) => c.method === 'agentPreset.select')
  // ⚠️ 实测确认过的键名（docs/gap-shapes.md §八）：猜成 presetId 会静默打错。
  assert.deepEqual(call?.payload, { sessionId: 's1', agentPreset: 'code' })
  assert.equal(state.sessions.get(s1)?.agentPreset, 'code')
  await state.dispose()
})

test('listPresets：返回名册原样', async () => {
  const client = new FakeClient()
  client.onCall('agentPreset.list', () =>
    ok({
      presets: [
        { id: 'standard', trust: 'system', isDefault: true, name: '标准模式', description: '…' },
        { id: 'code', trust: 'system', isDefault: false, name: 'PTC 模式', description: '…' },
      ],
      authorable: true,
      hasDocument: true,
    }),
  )
  const state = await readyState(client)
  const presets = await state.listPresets()
  assert.deepEqual(
    presets.map((p) => p.id),
    ['standard', 'code'],
  )
  assert.equal(presets[0]?.name, '标准模式')
  await state.dispose()
})

test('renameSession：返回的 { title, seq } 直接落进 title 投影格，不等推送帧', async () => {
  const client = new FakeClient()
  client.onCall('session.rename', () => ok({ title: 'renamed session', seq: 7 }))
  const state = await readyState(client)
  const s1 = sid('s1')
  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true })

  await state.renameSession(s1, 'renamed session')
  assert.equal(state.sessions.get(s1)?.title, 'renamed session')
  assert.equal(state.projections(s1).get('title'), 'renamed session')

  // higher-seq-wins 纪律不破：更旧 seq 的推送帧不许盖掉刚 settle 的标题。
  client.emitMux({ type: 'session/projection', sessionId: s1, key: 'title', value: 'stale', seq: 3 })
  assert.equal(state.sessions.get(s1)?.title, 'renamed session')

  const call = client.calls.find((c) => c.method === 'session.rename')
  assert.deepEqual(call?.payload, { sessionId: 's1', title: 'renamed session' })
  await state.dispose()
})

test('forkSession：返回新 sessionId；fork-unavailable 原样抛出（可读提示给调用方）', async () => {
  const client = new FakeClient()
  const forked = sid('s2')
  client.onCall('session.fork', () => ok({ sessionId: forked }))
  const state = await readyState(client)

  const result = await state.forkSession(sid('s1'))
  assert.equal(result, forked)
  assert.deepEqual(client.calls.find((c) => c.method === 'session.fork')?.payload, {
    sessionId: 's1',
  })

  client.onCall('session.fork', () => ({
    ok: false,
    error: { code: 'fork-unavailable', message: 'has no completed turn to fork from', details: {} },
  }))
  await assert.rejects(
    () => state.forkSession(sid('s1')),
    (error: Error) => {
      assert.ok(error.message.includes('fork-unavailable'))
      assert.ok(error.message.includes('has no completed turn'))
      return true
    },
  )
  await state.dispose()
})

test('listSessions：走 session.list（不依赖 search），标题从投影取', async () => {
  const client = new FakeClient()
  const state = await readyState(client)
  client.onCall('session.list', () =>
    ok({
      items: [
        listItem(sid('s1'), {
          updatedAt: 200,
          blank: false,
          cwd: '/tmp/a',
          projections: { asOfSeq: 9, values: { title: 'first session' } },
        }),
        listItem(sid('s2'), { updatedAt: 100, blank: true }),
      ],
    }),
  )
  const entries = await state.listSessions()
  assert.equal(entries.length, 2)
  assert.equal(entries[0]?.sessionId, sid('s1'))
  assert.equal(entries[0]?.title, 'first session')
  assert.equal(entries[0]?.cwd, '/tmp/a')
  assert.equal(entries[1]?.title, undefined)
  assert.equal(entries[1]?.blank, true)
  // 顺手刷了记录：会话列表回来以后 summary 也有标题了。
  assert.equal(state.sessions.get(sid('s1'))?.title, 'first session')
  await state.dispose()
})

test('searchSessions：部署关掉 search 时返回 undefined（退回本地过滤），开着时返回 id 序', async () => {
  const client = new FakeClient()
  client.onCall('session.search', () => ({
    ok: false,
    error: {
      code: 'bad-request',
      message: 'session search is disabled: this deployment configures the session-query index with openAt "never"',
      details: {},
    },
  }))
  const state = await readyState(client)
  assert.equal(await state.searchSessions('anything'), undefined)

  client.onCall('session.search', () =>
    ok({ items: [{ sessionId: sid('s9'), snippet: '…' }], hasMore: false }),
  )
  assert.deepEqual(await state.searchSessions('query'), [sid('s9')])
  assert.deepEqual(
    client.calls.filter((c) => c.method === 'session.search').map((c) => c.payload),
    [{ query: 'anything' }, { query: 'query' }],
  )
  await state.dispose()
})
