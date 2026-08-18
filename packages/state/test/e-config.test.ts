/**
 * E 批（设置 / 凭证 / provider / 目标）的 state 层验收：
 * 全部用 FakeClient 打桩，**不连真 host**——settings/credentials 的写方法
 * 会动用户真实的 ~/.dsh，这一层只包只读方法 + goal 动词，测试也只碰这些。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectCredentialRefs,
  createState,
  parseGoalProjection,
  type DshrState,
  type SettingsOverview,
} from '@dshr/state'
import { FakeClient, ok, rid, settle, sid } from './fake-client.ts'

async function readyState(client: FakeClient): Promise<DshrState> {
  client.stubBaseline()
  const state = createState({ client })
  client.setReady(1)
  await settle()
  return state
}

const fail = (code: string, message: string) => ({ ok: false as const, error: { code, message, details: {} } })

/** 一份最小的 settings.describe 返回：一个 llm-pi-ai（含 provider profile）+ 一个散件命名空间。 */
function settingsFixture(): SettingsOverview {
  return {
    writable: true,
    hasDocument: true,
    namespaces: [
      {
        ns: 'llm-pi-ai',
        schema: {},
        value: { providers: { mock: { apiKeyEnv: 'MOCK_API_KEY', baseURL: 'http://127.0.0.1:8100/v1' } } },
        applies: 'live',
        secrets: [],
        revision: 0,
      },
      {
        ns: 'web-search-deepseek',
        schema: {},
        value: { apiKeyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-v4-flash' },
        applies: 'live',
        secrets: [{ path: ['apiKey'], set: false }],
        revision: 2,
      },
    ],
  } as SettingsOverview
}

const PROVIDERS = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
  {
    provider: 'mock',
    displayName: 'mock',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'mock'],
    active: false,
    declared: true,
  },
]

// ---- 只读方法的载荷与透传 ----

test('settings.describe / llm.providers / llm.models：空载荷、结果透传', async () => {
  const client = new FakeClient()
  client.onCall('settings.describe', () => ok(settingsFixture()))
  client.onCall('llm.providers', () => ok({ providers: PROVIDERS }))
  client.onCall('llm.models', () => ok({ groups: [], failures: [] }))
  const state = await readyState(client)

  const settings = await state.describeSettings()
  assert.equal(settings.namespaces.length, 2)
  const providers = await state.listProviders()
  assert.equal(providers[0]?.provider, 'deepseek-official')
  const catalog = await state.listModelCatalog()
  assert.deepEqual(catalog.groups, [])

  for (const call of client.calls) assert.deepEqual(call.payload, {})
  const methods = client.calls.map((c) => c.method)
  assert.deepEqual(methods.filter((m) => m.startsWith('settings.') || m.startsWith('llm.')), [
    'settings.describe',
    'llm.providers',
    'llm.models',
  ])
  await state.dispose()
})

test('只读方法的业务错误抛出来（带方法名），不吞', async () => {
  const client = new FakeClient()
  client.onCall('settings.describe', () => fail('loopback-only', 'settings are loopback-pinned'))
  client.onCall('llm.providers', () => fail('boom', 'boom'))
  client.onCall('llm.models', () => fail('boom', 'boom'))
  const state = await readyState(client)
  await assert.rejects(() => state.describeSettings(), /settings\.describe failed: loopback-only/)
  await assert.rejects(() => state.listProviders(), /llm\.providers failed/)
  await assert.rejects(() => state.listModelCatalog(), /llm\.models failed/)
  await state.dispose()
})

test('settings.openDocument：成功静默返回，失败抛错（opener 不可用要能让人看见）', async () => {
  const client = new FakeClient()
  client.onCall('settings.openDocument', () => ok({ opened: true as const }))
  const state = await readyState(client)
  await state.openSettingsDocument()
  assert.deepEqual(client.calls.at(-1)?.payload, {})

  const broken = new FakeClient()
  broken.onCall('settings.openDocument', () => fail('open-failed', 'no opener'))
  const state2 = createState({ client: broken })
  broken.stubBaseline()
  broken.setReady(1)
  await settle()
  await assert.rejects(() => state2.openSettingsDocument(), /settings\.openDocument failed: open-failed/)
  await state.dispose()
  await state2.dispose()
})

// ---- 凭证：ref 发现 + describe 合并 ----

test('collectCredentialRefs：provider 目录序优先，散件命名空间兜底，holders 去重', () => {
  const refs = collectCredentialRefs(settingsFixture(), PROVIDERS)
  assert.deepEqual([...refs.keys()], ['MOCK_API_KEY', 'DEEPSEEK_API_KEY'])
  assert.deepEqual(refs.get('MOCK_API_KEY'), ['mock', 'llm-pi-ai'])
  assert.deepEqual(refs.get('DEEPSEEK_API_KEY'), ['web-search-deepseek'])
})

test('collectCredentialRefs：profile 指不到 / apiKeyEnv 缺失时不编 ref', () => {
  const settings = {
    writable: true,
    hasDocument: false,
    namespaces: [{ ns: 'llm-deepseek', schema: {}, value: {}, applies: 'live', secrets: [], revision: 0 }],
  } as unknown as SettingsOverview
  const refs = collectCredentialRefs(settings, PROVIDERS)
  assert.deepEqual([...refs.keys()], [])
})

test('describeCredentials：refs 从设置发现，状态从 credentials.describe 合并，值不过线', async () => {
  const client = new FakeClient()
  client.onCall('settings.describe', () => ok(settingsFixture()))
  client.onCall('llm.providers', () => ok({ providers: PROVIDERS }))
  client.onCall('credentials.describe', (payload) => {
    assert.deepEqual(payload, { refs: ['MOCK_API_KEY', 'DEEPSEEK_API_KEY'] })
    return ok({
      credentials: {
        MOCK_API_KEY: { configured: true, source: 'env', writable: true },
        DEEPSEEK_API_KEY: { configured: false, writable: true },
      },
    })
  })
  const state = await readyState(client)
  const credentials = await state.describeCredentials()
  assert.deepEqual(credentials, [
    { ref: 'MOCK_API_KEY', configured: true, source: 'env', writable: true, holders: ['mock', 'llm-pi-ai'] },
    { ref: 'DEEPSEEK_API_KEY', configured: false, writable: true, holders: ['web-search-deepseek'] },
  ])
  // 载荷与返回里没有任何值字段——结构性检查一遍键名
  for (const call of client.calls) assert.ok(!JSON.stringify(call.payload).includes('value'))
  await state.dispose()
})

test('describeCredentials：没有已知 ref 时不打 credentials.describe', async () => {
  const client = new FakeClient()
  client.onCall('settings.describe', () =>
    ok({ writable: true, hasDocument: false, namespaces: [] } as SettingsOverview),
  )
  client.onCall('llm.providers', () => ok({ providers: [] }))
  const state = await readyState(client)
  assert.deepEqual(await state.describeCredentials(), [])
  assert.ok(!client.calls.some((c) => c.method === 'credentials.describe'))
  await state.dispose()
})

// ---- goal 投影解析 ----

test('parseGoalProjection：实测形状全字段；null / 缺字段 / 坏 phase 都是 undefined', () => {
  // 2026-08-17 实测样本（tools/probe-goal.mjs），phase=blocked 带 blockedReason
  const probed = {
    goal: {
      id: 'goal-baed9648',
      revision: 2,
      objective: 'probe objective',
      phase: 'blocked',
      blockedReason: { code: 'round-limit', message: 'Goal reached its configured limit of 3 rounds.' },
      maxGoalRounds: 3,
    },
    roundsStarted: 3,
    createdAt: 1786958465327,
    updatedAt: 1786958465464,
  }
  const info = parseGoalProjection(probed)
  assert.ok(info)
  assert.equal(info.id, 'goal-baed9648')
  assert.equal(info.revision, 2)
  assert.equal(info.phase, 'blocked')
  assert.equal(info.blockedReason, 'Goal reached its configured limit of 3 rounds.')
  assert.equal(info.roundsStarted, 3)
  assert.equal(info.maxGoalRounds, 3)

  assert.equal(parseGoalProjection(null), undefined) // clear 之后
  assert.equal(parseGoalProjection(undefined), undefined)
  assert.equal(parseGoalProjection({ goal: null }), undefined)
  assert.equal(parseGoalProjection({ goal: { id: 'g', revision: 1, objective: 'x' } }), undefined) // 缺 phase
  assert.equal(
    parseGoalProjection({ goal: { id: 'g', revision: 1, objective: 'x', phase: 'weird' } }),
    undefined,
  )
  assert.equal(
    parseGoalProjection({ goal: { id: 'g', revision: 0, objective: 'x', phase: 'active' } }),
    undefined,
  )
})

test('goalOf：从 session/projection 帧读，higher-seq-wins，clear（null）后消失', async () => {
  const client = new FakeClient()
  const state = await readyState(client)
  const s1 = sid('s1')
  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true, cwd: '/tmp/x' })

  const projection = (value: unknown, seq: number) =>
    ({ type: 'session/projection', sessionId: s1, key: 'goal', value, seq }) as never
  assert.equal(state.goalOf(s1), undefined)

  client.emitMux(
    projection(
      { goal: { id: 'goal-1', revision: 1, objective: 'do it', phase: 'active', maxGoalRounds: 5 }, roundsStarted: 0, createdAt: 1, updatedAt: 1 },
      10,
    ),
    rid('p1'),
  )
  assert.equal(state.goalOf(s1)?.objective, 'do it')
  assert.equal(state.goalOf(s1)?.phase, 'active')

  // 旧 seq 不许覆盖（higher-seq-wins）
  client.emitMux(
    projection(
      { goal: { id: 'goal-1', revision: 1, objective: 'stale', phase: 'active', maxGoalRounds: 5 }, roundsStarted: 0, createdAt: 1, updatedAt: 1 },
      9,
    ),
    rid('p2'),
  )
  assert.equal(state.goalOf(s1)?.objective, 'do it')

  // clear：投影值变 null
  client.emitMux(projection(null, 11), rid('p3'))
  assert.equal(state.goalOf(s1), undefined)
  await state.dispose()
})

// ---- goal 动词 ----

test('goal.create 的载荷键是 objective；pause 的 ref 是派发那一刻现读的投影', async () => {
  const client = new FakeClient()
  client.onCall('goal.create', () => ok({ ref: { id: 'goal-1' as never, revision: 1 } }))
  client.onCall('goal.pause', () => ok({ ref: { id: 'goal-1' as never, revision: 3 } }))
  const state = await readyState(client)
  const s1 = sid('s1')
  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true, cwd: '/tmp/x' })

  await state.createGoal(s1, 'ship it')
  assert.deepEqual(client.calls.at(-1), { method: 'goal.create', payload: { sessionId: s1, objective: 'ship it' } })

  // 模型的自动轮次把 revision 推到了 3（实测会发生）——动词必须带最新的
  client.emitMux(
    {
      type: 'session/projection',
      sessionId: s1,
      key: 'goal',
      value: { goal: { id: 'goal-1', revision: 3, objective: 'ship it', phase: 'active', maxGoalRounds: 5 }, roundsStarted: 2, createdAt: 1, updatedAt: 2 },
      seq: 20,
    } as never,
    rid('p1'),
  )
  await state.pauseGoal(s1)
  assert.deepEqual(client.calls.at(-1)?.payload, { sessionId: s1, ref: { id: 'goal-1', revision: 3 } })
  await state.dispose()
})

test('goal 动词：没有目标时抛可读错误；RPC 业务错误带方法名抛出', async () => {
  const client = new FakeClient()
  client.onCall('goal.clear', () => fail('GOAL_STALE_REVISION', 'stale goal ref'))
  const state = await readyState(client)
  const s1 = sid('s1')
  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true, cwd: '/tmp/x' })

  await assert.rejects(() => state.pauseGoal(s1), /goal\.pause: 当前会话没有目标/)

  client.emitMux(
    {
      type: 'session/projection',
      sessionId: s1,
      key: 'goal',
      value: { goal: { id: 'goal-1', revision: 1, objective: 'x', phase: 'active', maxGoalRounds: 0 }, roundsStarted: 0, createdAt: 1, updatedAt: 1 },
      seq: 5,
    } as never,
    rid('p1'),
  )
  await assert.rejects(() => state.clearGoal(s1), /goal\.clear failed: GOAL_STALE_REVISION/)
  await state.dispose()
})

test('pushNotice：命令回执进会话视图的 notice 行', async () => {
  const client = new FakeClient()
  client.stubBaseline()
  client.onCall('session.history', () => ok({ events: [], hasMore: false }))
  const state = createState({ client })
  client.setReady(1)
  await settle()
  const s1 = sid('s1')
  client.emitHost({ type: 'host/session-added', sessionId: s1, blank: true, cwd: '/tmp/x' })
  const view = state.conversation(s1)
  await settle()
  view.pushNotice('Goal paused.')
  const notice = view.items.find((item) => item.kind === 'notice')
  assert.ok(notice)
  assert.equal(notice.kind === 'notice' ? notice.text : '', 'Goal paused.')
  await state.dispose()
})
