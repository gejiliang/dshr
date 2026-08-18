/**
 * 设置编辑器的 state 层验收：schema 走查器（纯函数）+ mutateSetting / 凭证写方法
 *（FakeClient 打桩，**不连真 host**——真实写路径的验收在隔离 DSH_HOME 上做，见交付报告）。
 *
 * 夹具的 schema 形状逐字段照抄 2026-08-18 对 dsh 0.1.0-rc.6 的实测
 *（tools/probe-settings-schema.mjs / probe-settings-types.mjs，docs/gap-shapes.md §十一）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createState,
  formatSettingValue,
  parseTextInput,
  refindFields,
  sameValue,
  validateNumberInput,
  walkSettingsNamespace,
  type DshrState,
  type SettingField,
  type SettingsNamespace,
} from '@dshr/state'
import { FakeClient, ok, settle } from './fake-client.ts'

async function readyState(client: FakeClient): Promise<DshrState> {
  client.stubBaseline()
  const state = createState({ client })
  client.setReady(1)
  await settle()
  return state
}

const fail = (code: string, message: string) => ({ ok: false as const, error: { code, message, details: {} } })

/**
 * 一个覆盖面够全的命名空间夹具：枚举（union of const）、含非 const 分支的 union、
 * number（min/max/step）、string、credential-ref、secret、boolean、嵌套 object、
 * array、dict——八种 type 全在。refId 编排与上游实测同构。
 */
function fixtureNamespace(): SettingsNamespace {
  return {
    ns: 'fixture',
    schema: {
      uid: 100,
      refs: {
        1: { type: 'const', meta: { required: true }, value: 'queue' },
        2: { type: 'const', meta: {}, value: 'steer' },
        3: { type: 'union', meta: { default: 'queue' }, list: [1, 2] },
        4: { type: 'string', meta: {} },
        5: { type: 'const', meta: {}, value: null },
        6: { type: 'union', meta: {}, list: [4, 5] }, // string | const(null) → text
        7: { type: 'number', meta: { step: 1, min: 1, max: 64, default: 10 } },
        8: { type: 'string', meta: { role: 'credential-ref', default: 'MOCK_API_KEY' } },
        9: { type: 'string', meta: { role: 'secret' } },
        10: { type: 'boolean', meta: {} },
        11: { type: 'string', meta: {} },
        12: { type: 'object', meta: { default: {} }, dict: { nested: 11 } },
        13: { type: 'array', meta: { default: [] }, inner: 11 },
        14: { type: 'dict', meta: { default: {} }, inner: 11 },
        15: { type: 'const', meta: {}, value: 'fixed' }, // 独立 const → readonly
        100: {
          type: 'object',
          meta: { default: {} },
          dict: {
            mode: 3,
            nullableNote: 6,
            maxTokens: 7,
            apiKeyEnv: 8,
            apiKey: 9,
            stream: 10,
            group: 12,
            tags: 13,
            mapping: 14,
            constant: 15,
          },
        },
      },
    },
    value: {
      mode: 'steer',
      nullableNote: null,
      maxTokens: 10,
      apiKeyEnv: 'MOCK_API_KEY',
      stream: false,
      group: { nested: 'hello' },
      tags: ['a', 'b'],
      mapping: { x: 'y' },
      constant: 'fixed',
      // apiKey 不在——secret 值永不下线
    },
    applies: 'live',
    secrets: [{ path: ['apiKey'], set: true }],
    revision: 7,
  } as SettingsNamespace
}

function fieldByKey(fields: readonly SettingField[], key: string): SettingField {
  const field = fields.find((candidate) => candidate.key === key)
  assert.ok(field !== undefined, `字段 ${key} 应在`)
  return field
}

// ---- schema 走查器 ----

test('走查：union of const 识别成枚举并带出全部选项与当前值', () => {
  const fields = walkSettingsNamespace(fixtureNamespace())
  const mode = fieldByKey(fields, 'mode')
  assert.equal(mode.kind, 'enum')
  assert.deepEqual(mode.options, ['queue', 'steer'])
  assert.equal(mode.hasValue, true)
  assert.equal(mode.value, 'steer')
  assert.deepEqual(mode.path, ['mode'])
})

test('走查：含非 const 分支的 union 退回 text；独立 const 只读且展示字面值', () => {
  const fields = walkSettingsNamespace(fixtureNamespace())
  assert.equal(fieldByKey(fields, 'nullableNote').kind, 'text')
  const constant = fieldByKey(fields, 'constant')
  assert.equal(constant.kind, 'readonly')
  assert.equal(constant.value, 'fixed')
})

test('走查：number 带出 min/max/step；boolean 就地切换型；credential-ref 是普通 string', () => {
  const fields = walkSettingsNamespace(fixtureNamespace())
  const maxTokens = fieldByKey(fields, 'maxTokens')
  assert.equal(maxTokens.kind, 'number')
  assert.deepEqual(
    { min: maxTokens.min, max: maxTokens.max, step: maxTokens.step },
    { min: 1, max: 64, step: 1 },
  )
  assert.equal(fieldByKey(fields, 'stream').kind, 'boolean')
  const apiKeyEnv = fieldByKey(fields, 'apiKeyEnv')
  assert.equal(apiKeyEnv.kind, 'string')
  assert.equal(apiKeyEnv.role, 'credential-ref')
  assert.equal(apiKeyEnv.value, 'MOCK_API_KEY')
})

test('走查：secret 字段不出值、标 secretSet、永远只读', () => {
  const fields = walkSettingsNamespace(fixtureNamespace())
  const apiKey = fieldByKey(fields, 'apiKey')
  assert.equal(apiKey.kind, 'readonly')
  assert.equal(apiKey.role, 'secret')
  assert.equal(apiKey.secretSet, true)
  assert.equal(apiKey.hasValue, false)
  assert.ok(!('value' in apiKey), 'secret 字段上不该有 value 键')
})

test('走查：object 下钻出子字段（路径加深）；array / dict 只读并标出原 type', () => {
  const fields = walkSettingsNamespace(fixtureNamespace())
  const group = fieldByKey(fields, 'group')
  assert.equal(group.kind, 'object')
  const nested = fieldByKey(group.children ?? [], 'nested')
  assert.equal(nested.kind, 'string')
  assert.equal(nested.value, 'hello')
  assert.deepEqual(nested.path, ['group', 'nested'])
  const tags = fieldByKey(fields, 'tags')
  assert.equal(tags.kind, 'readonly')
  assert.equal(tags.type, 'array')
  const mapping = fieldByKey(fields, 'mapping')
  assert.equal(mapping.kind, 'readonly')
  assert.equal(mapping.type, 'dict')
})

test('走查：schema 解码失败 / 根不是 object 时返回空，不抛', () => {
  const broken = { ...fixtureNamespace(), schema: { nope: 1 } } as SettingsNamespace
  assert.deepEqual(walkSettingsNamespace(broken), [])
  const rootNotObject = {
    ...fixtureNamespace(),
    schema: { uid: 1, refs: { 1: { type: 'string', meta: {} } } },
  } as SettingsNamespace
  assert.deepEqual(walkSettingsNamespace(rootNotObject), [])
})

test('refindFields：mutate 后整树重走，按 key 轨迹找回下钻位置', () => {
  const roots = walkSettingsNamespace(fixtureNamespace())
  assert.equal(fieldByKey(refindFields(roots, []) ?? [], 'mode').kind, 'enum')
  const deeper = refindFields(roots, ['group'])
  assert.equal(fieldByKey(deeper ?? [], 'nested').value, 'hello')
  assert.equal(refindFields(roots, ['group', 'nested']), undefined, 'nested 不是 object，到底了')
  assert.equal(refindFields(roots, ['missing']), undefined)
})

// ---- 数字校验（不合法给可读消息，不许提交）----

test('validateNumberInput：非数字 / 越界 / 违 step 都是可读错误', () => {
  assert.deepEqual(validateNumberInput('', {}), { ok: false, message: 'a number is required' })
  const notNumber = validateNumberInput('abc', {})
  assert.equal(notNumber.ok, false)
  if (!notNumber.ok) assert.ok(notNumber.message.includes('"abc"'))
  assert.deepEqual(validateNumberInput('0', { min: 1 }), { ok: false, message: 'must be ≥ 1' })
  assert.deepEqual(validateNumberInput('65', { max: 64 }), { ok: false, message: 'must be ≤ 64' })
  const offStep = validateNumberInput('4', { min: 1, step: 2 })
  assert.equal(offStep.ok, false)
  if (!offStep.ok) assert.ok(offStep.message.includes('multiple of 2'))
  assert.deepEqual(validateNumberInput('5', { min: 1, step: 2 }), { ok: true, value: 5 })
  assert.deepEqual(validateNumberInput(' 42 ', { max: 64 }), { ok: true, value: 42 })
})

// ---- 小工具 ----

test('sameValue：枚举值比较覆盖 null/false/0 与深相等', () => {
  assert.ok(sameValue(null, null))
  assert.ok(sameValue(false, false))
  assert.ok(sameValue(0, 0))
  assert.ok(sameValue('queue', 'queue'))
  assert.ok(!sameValue(0, false))
  assert.ok(!sameValue(null, undefined))
})

test('parseTextInput：JSON 优先，失败按纯字符串（string|const(null) 的场景）', () => {
  assert.equal(parseTextInput('null'), null)
  assert.equal(parseTextInput('42'), 42)
  assert.equal(parseTextInput('{"a":1}') && JSON.stringify(parseTextInput('{"a":1}')), '{"a":1}')
  assert.equal(parseTextInput('just words'), 'just words')
})

test('formatSettingValue：字符串原样、空串加引号、其余走 JSON', () => {
  assert.equal(formatSettingValue('queue'), 'queue')
  assert.equal(formatSettingValue(''), '""')
  assert.equal(formatSettingValue(42), '42')
  assert.equal(formatSettingValue(null), 'null')
  assert.equal(formatSettingValue(['a']), '["a"]')
  assert.equal(formatSettingValue(undefined), '—')
})

// ---- mutateSetting / 凭证写方法（FakeClient 打桩）----

test('mutateSetting：载荷是 {ns, ops, expectedRevision}，返回值带回新 revision（不再 describe）', async () => {
  const client = new FakeClient()
  const next = { ...fixtureNamespace(), revision: 8, value: { ...fixtureNamespace().value, maxTokens: 12 } }
  client.onCall('settings.mutate', () => ok(next))
  const state = await readyState(client)

  const result = await state.mutateSetting(
    'fixture',
    [{ op: 'set', path: ['maxTokens'], value: 12 }],
    7,
  )
  assert.equal(result.revision, 8)
  const call = client.calls.find((c) => c.method === 'settings.mutate')
  assert.deepEqual(call?.payload, {
    ns: 'fixture',
    ops: [{ op: 'set', path: ['maxTokens'], value: 12 }],
    expectedRevision: 7,
  })
  // 没有再补一次 describe
  assert.ok(!client.calls.some((c) => c.method === 'settings.describe'))
  await state.dispose()
})

test('mutateSetting：CAS 撞了抛 settings-conflict（消息可读），校验失败抛 settings-rejected', async () => {
  const client = new FakeClient()
  client.onCall('settings.mutate', (payload) => {
    const { expectedRevision } = payload as { expectedRevision: number }
    return expectedRevision === 7
      ? fail('settings-conflict', 'settings namespace "fixture" changed since it was read (expected revision 7, now 9)')
      : fail('settings-rejected', '$.maxTokens expected number but got abc')
  })
  const state = await readyState(client)
  await assert.rejects(
    () => state.mutateSetting('fixture', [{ op: 'set', path: ['maxTokens'], value: 12 }], 7),
    /settings\.mutate failed: settings-conflict: .*changed since it was read/,
  )
  await assert.rejects(
    () => state.mutateSetting('fixture', [{ op: 'set', path: ['maxTokens'], value: 'abc' }], 9),
    /settings-rejected/,
  )
  await state.dispose()
})

test('凭证写方法：set/unset 载荷透传；凭证值不进错误消息', async () => {
  const client = new FakeClient()
  client.onCall('credentials.set', () => ok({}))
  client.onCall('credentials.unset', () => ok({}))
  const state = await readyState(client)
  await state.setCredential('MOCK_API_KEY', 'test-key-not-real')
  await state.unsetCredential('MOCK_API_KEY')
  assert.deepEqual(
    client.calls
      .filter((c) => c.method.startsWith('credentials.'))
      .map((c) => ({ method: c.method, payload: c.payload })),
    [
      { method: 'credentials.set', payload: { ref: 'MOCK_API_KEY', value: 'test-key-not-real' } },
      { method: 'credentials.unset', payload: { ref: 'MOCK_API_KEY' } },
    ],
  )
  await state.dispose()
})

test('凭证写方法：影子层拒绝抛 credential-rejected，消息里只有 host 的 code/message', async () => {
  const client = new FakeClient()
  client.onCall('credentials.set', () =>
    fail('credential-rejected', 'reference is shadowed by a read-only layer'),
  )
  const state = await readyState(client)
  const error = await state.setCredential('MOCK_API_KEY', 'test-key-not-real').catch((e: unknown) => e)
  assert.ok(error instanceof Error)
  assert.ok(error.message.includes('credential-rejected'))
  assert.ok(!error.message.includes('test-key-not-real'), '错误消息不许带凭证值')
  await state.dispose()
})
