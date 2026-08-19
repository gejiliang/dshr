/**
 * 设置编辑器与凭证对话框的 TUI 验收（ink-testing-library，不连真 host）。
 *
 * 覆盖：三层下钻、枚举选择（当前项 ●）、number 本地校验不合法不提交、
 * boolean 就地切换、secret 不提供输入、array/dict 只读有理由、CAS 失败的可读回执、
 * 凭证的掩码输入（真值不上屏）与 unset 的一步确认。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import './force-color.ts'
import { flush, outputOf } from './helpers.ts'
import { CredentialsDialog, DialogPrompt, SettingsEditor } from '../lib/index.js'
import type { CredentialRefState, SettingsNamespace, SettingsOverview } from '@dshr/state'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'

const DOWN = '\x1b[B'
const ENTER = '\r'
const ESC = '\x1b'

/** 与 state 层同构的夹具（形状照抄 2026-08-18 实测）。 */
function fixtureNamespace(over: Partial<SettingsNamespace> = {}): SettingsNamespace {
  return {
    ns: 'fixture',
    schema: {
      uid: 100,
      refs: {
        1: { type: 'const', meta: {}, value: 'queue' },
        2: { type: 'const', meta: {}, value: 'steer' },
        3: { type: 'union', meta: { default: 'queue' }, list: [1, 2] },
        7: { type: 'number', meta: { step: 1, min: 1, max: 64, default: 10 } },
        8: { type: 'string', meta: { role: 'credential-ref', default: 'MOCK_API_KEY' } },
        9: { type: 'string', meta: { role: 'secret' } },
        10: { type: 'boolean', meta: {} },
        11: { type: 'string', meta: {} },
        12: { type: 'object', meta: { default: {} }, dict: { nested: 11 } },
        13: { type: 'array', meta: { default: [] }, inner: 11 },
        100: {
          type: 'object',
          meta: { default: {} },
          dict: {
            mode: 3,
            maxTokens: 7,
            apiKeyEnv: 8,
            apiKey: 9,
            stream: 10,
            group: 12,
            tags: 13,
          },
        },
      },
    },
    value: {
      mode: 'steer',
      maxTokens: 10,
      apiKeyEnv: 'MOCK_API_KEY',
      stream: false,
      group: { nested: 'hello' },
      tags: ['a', 'b'],
    },
    applies: 'restart',
    secrets: [{ path: ['apiKey'], set: false }],
    revision: 7,
    ...over,
  } as SettingsNamespace
}

function fixtureOverview(): SettingsOverview {
  return {
    writable: true,
    hasDocument: true,
    namespaces: [
      { ns: 'ui-onboarding', schema: { uid: 1, refs: { 1: { type: 'object', meta: {}, dict: {} } } }, value: {}, applies: 'live', secrets: [], revision: 0 },
      fixtureNamespace(),
    ],
  } as SettingsOverview
}

type MutateCall = { ns: string; ops: readonly unknown[]; expectedRevision: number }

/** onMutate 打桩：记录载荷，返回 revision+1、value 合并后的新 view（仿 host 行为）。 */
function makeMutate(impl?: (call: MutateCall) => SettingsNamespace) {
  const calls: MutateCall[] = []
  const onMutate = (ns: string, ops: readonly { path: string[]; value?: unknown }[], expectedRevision: number): Promise<SettingsNamespace> => {
    calls.push({ ns, ops, expectedRevision })
    if (impl !== undefined) return Promise.resolve(impl({ ns, ops, expectedRevision }))
    const base = fixtureNamespace()
    const value = { ...(base.value as Record<string, unknown>) }
    const op = ops[0]
    if (op !== undefined && op.value !== undefined && op.path.length === 1) value[op.path[0] as string] = op.value
    return Promise.resolve(fixtureNamespace({ value, revision: expectedRevision + 1 }))
  }
  return { calls, onMutate }
}

// ---- DialogPrompt 的 mask / error ----

test('DialogPrompt mask：屏上全是 •，提交的是真值', async (t) => {
  t.after(cleanup)
  const submitted: string[] = []
  const app = render(
    h(DialogPrompt, { title: 'Set MOCK_API_KEY', mask: true, onSubmit: (v) => submitted.push(v), onCancel: () => {} }),
  )
  await flush()
  app.stdin.write('s3cr3t')
  await flush()
  const out = outputOf(app)
  assert.ok(!out.includes('s3cr3t'), '真值不该上屏')
  assert.ok(out.includes('••••••'), '应回显掩码')
  app.stdin.write(ENTER)
  await flush()
  assert.deepEqual(submitted, ['s3cr3t'], '提交的应是真值')
  app.unmount()
})

test('DialogPrompt error：校验提示显示出来且对话框不关', async (t) => {
  t.after(cleanup)
  const app = render(h(DialogPrompt, { title: 'Number', error: 'must be ≤ 64', onSubmit: () => {}, onCancel: () => {} }))
  await flush()
  assert.ok(outputOf(app).includes('must be ≤ 64'))
  app.unmount()
})

// ---- SettingsEditor ----

test('第一层：命名空间列表，restart 标出来，esc 关闭', async (t) => {
  t.after(cleanup)
  let closed = 0
  const { onMutate } = makeMutate()
  const app = render(h(SettingsEditor, { overview: fixtureOverview(), onMutate, onClose: () => closed++ }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('fixture'))
  assert.ok(out.includes('⚠ applies on restart'), 'restart 命名空间要标出来')
  assert.ok(out.includes('applies live'))
  app.stdin.write(ESC)
  await flush()
  assert.strictEqual(closed, 1)
  app.unmount()
})

test('第二层：字段列表带当前值；secret 只显示配置状态；array 标只读', async (t) => {
  t.after(cleanup)
  const { onMutate } = makeMutate()
  const app = render(h(SettingsEditor, { overview: fixtureOverview(), onMutate, onClose: () => {} }))
  await flush()
  app.stdin.write(DOWN) // fixture 命名空间
  app.stdin.write(ENTER)
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('mode'))
  assert.ok(out.includes('steer'), '枚举字段显示当前值')
  assert.ok(out.includes('secret · not configured'), 'secret 显示未配置，无值')
  assert.ok(!out.includes('not editable in the TUI yet (secret)'), 'secret 的理由不是「暂不支持」')
  assert.ok(out.includes('not editable in the TUI yet (array)'), 'array 标出暂不支持')
  assert.ok(out.includes('restart'), 'restart 提示要在')
  app.unmount()
})

test('枚举：选项屏当前值画 ●；选另一个值发出一个 set op 并显示新 revision 回执', async (t) => {
  t.after(cleanup)
  const { calls, onMutate } = makeMutate()
  const app = render(h(SettingsEditor, { overview: fixtureOverview(), onMutate, onClose: () => {} }))
  await flush()
  app.stdin.write(DOWN + ENTER) // 进 fixture
  await flush()
  app.stdin.write(ENTER) // 第一个字段 mode → 枚举屏
  await flush()
  const enumOut = outputOf(app)
  assert.ok(enumOut.includes('queue'))
  assert.ok(enumOut.includes('● '), '当前值 steer 应画 ●')
  const steerHasBullet = enumOut
    .split('\n')
    .filter((line) => line.includes('steer'))
    .some((line) => line.includes('●'))
  assert.ok(steerHasBullet, '● 应在 steer 行')
  app.stdin.write(ENTER) // 选 queue（第一项）
  await flush(80)
  assert.deepEqual(
    calls.map((c) => ({ ns: c.ns, ops: c.ops, expectedRevision: c.expectedRevision })),
    [{ ns: 'fixture', ops: [{ op: 'set', path: ['mode'], value: 'queue' }], expectedRevision: 7 }],
  )
  const after = outputOf(app)
  assert.ok(after.includes('mode = queue (rev 8)'), '回执应带新 revision')
  assert.ok(after.includes('queue'), '字段列表应显示新值（不再 describe）')
  app.unmount()
})

test('number：越界输入给可读提示且**不提交**；合法值才发 mutate', async (t) => {
  t.after(cleanup)
  const { calls, onMutate } = makeMutate()
  const app = render(h(SettingsEditor, { overview: fixtureOverview(), onMutate, onClose: () => {} }))
  await flush()
  app.stdin.write(DOWN + ENTER) // 进 fixture
  await flush()
  app.stdin.write(DOWN + ENTER) // maxTokens
  await flush()
  // 初始值 10 在输入框里；清掉再输 100（> max 64）。
  // ⚠️ 退格要逐次写：合并在一次 write 里会被 ink 当一个输入串插入（实测）。
  app.stdin.write('\x7f')
  app.stdin.write('\x7f')
  await flush()
  app.stdin.write('100')
  await flush()
  app.stdin.write(ENTER)
  await flush()
  assert.ok(outputOf(app).includes('must be ≤ 64'), '越界要给可读提示')
  assert.deepEqual(calls, [], '不合法不许提交')
  app.stdin.write('\x7f')
  app.stdin.write('\x7f')
  app.stdin.write('\x7f')
  await flush()
  app.stdin.write('42')
  await flush()
  app.stdin.write(ENTER)
  await flush(80)
  assert.deepEqual(calls.length, 1)
  assert.deepEqual(calls[0]?.ops, [{ op: 'set', path: ['maxTokens'], value: 42 }])
  app.unmount()
})

test('boolean：enter 就地切换，不弹输入框', async (t) => {
  t.after(cleanup)
  const { calls, onMutate } = makeMutate()
  const app = render(h(SettingsEditor, { overview: fixtureOverview(), onMutate, onClose: () => {} }))
  await flush()
  app.stdin.write(DOWN + ENTER)
  await flush()
  app.stdin.write(DOWN + DOWN + DOWN + DOWN + ENTER) // stream: false → true
  await flush(80)
  assert.deepEqual(calls[0]?.ops, [{ op: 'set', path: ['stream'], value: true }])
  assert.ok(outputOf(app).includes('stream = true (rev 8)'))
  app.unmount()
})

test('object 下钻一层；esc 返回上一层', async (t) => {
  t.after(cleanup)
  const { onMutate } = makeMutate()
  const app = render(h(SettingsEditor, { overview: fixtureOverview(), onMutate, onClose: () => {} }))
  await flush()
  app.stdin.write(DOWN + ENTER)
  await flush()
  // group 是第 6 个字段（mode/maxTokens/apiKeyEnv/apiKey/stream/group）
  app.stdin.write(DOWN + DOWN + DOWN + DOWN + DOWN + ENTER)
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('fixture · group'), '标题应带下钻轨迹')
  assert.ok(out.includes('nested'))
  assert.ok(out.includes('hello'))
  app.stdin.write(ESC)
  await flush()
  assert.ok(outputOf(app).includes('maxTokens'), 'esc 应回到命名空间字段层')
  app.unmount()
})

test('secret 字段按下 enter：给可读理由，不弹输入框、不发 mutate', async (t) => {
  t.after(cleanup)
  const { calls, onMutate } = makeMutate()
  const app = render(h(SettingsEditor, { overview: fixtureOverview(), onMutate, onClose: () => {} }))
  await flush()
  app.stdin.write(DOWN + ENTER)
  await flush()
  app.stdin.write(DOWN + DOWN + DOWN + ENTER) // apiKey（secret）
  await flush()
  assert.ok(outputOf(app).includes('write-only secret slot'))
  assert.deepEqual(calls, [])
  app.unmount()
})

test('CAS 撞了：错误回执可读地显示出来，不吞', async (t) => {
  t.after(cleanup)
  const failing = (): Promise<SettingsNamespace> =>
    Promise.reject(new Error('settings.mutate failed: settings-conflict: settings namespace "fixture" changed since it was read (expected revision 7, now 9)'))
  const app = render(h(SettingsEditor, { overview: fixtureOverview(), onMutate: failing, onClose: () => {} }))
  await flush()
  app.stdin.write(DOWN + ENTER)
  await flush()
  app.stdin.write(ENTER) // mode 枚举屏
  await flush()
  app.stdin.write(ENTER) // 选 queue
  await flush(80)
  const out = outputOf(app)
  assert.ok(out.includes('settings-conflict'), 'CAS 冲突要可见')
  // 完整消息会被 80 列折行（中间断词），钉住两个足够远的片段即可。
  assert.ok(out.includes('changed since'), 'host 的可读消息要原样显示')
  app.unmount()
})

// ---- CredentialsDialog ----

const CREDS: readonly CredentialRefState[] = [
  { ref: 'MOCK_API_KEY', configured: true, source: 'env', writable: true, holders: ['mock'] },
  { ref: 'DEEPSEEK_API_KEY', configured: false, writable: true, holders: ['web-search-deepseek'] },
  { ref: 'ENV_LOCKED', configured: true, source: 'env', writable: false, holders: ['locked'] },
]

function renderCredentials(over: {
  onSet?: (ref: string, value: string) => Promise<void>
  onUnset?: (ref: string) => Promise<void>
  onClose?: () => void
}) {
  return render(
    h(CredentialsDialog, {
      load: () => Promise.resolve(CREDS),
      onSet: over.onSet ?? (() => Promise.resolve()),
      onUnset: over.onUnset ?? (() => Promise.resolve()),
      onClose: over.onClose ?? (() => {}),
    }),
  )
}

test('凭证列表：配置状态与 read-only 标记；read-only 的点了给可读理由', async (t) => {
  t.after(cleanup)
  const app = renderCredentials({})
  await flush(80)
  const out = outputOf(app)
  assert.ok(out.includes('MOCK_API_KEY'))
  assert.ok(out.includes('configured via env'))
  assert.ok(out.includes('not configured'))
  assert.ok(out.includes('read-only'))
  // ENV_LOCKED 是第三行
  app.stdin.write(DOWN + DOWN + ENTER)
  await flush()
  assert.ok(outputOf(app).includes('ENV_LOCKED is read-only here'), '只读的点了要给理由')
  app.unmount()
})

test('凭证录入：掩码输入，真值不上屏、只进 onSet，回执不带值', async (t) => {
  t.after(cleanup)
  const setCalls: { ref: string; value: string }[] = []
  const app = renderCredentials({ onSet: (ref, value) => { setCalls.push({ ref, value }); return Promise.resolve() } })
  await flush(80)
  app.stdin.write(ENTER) // MOCK_API_KEY → actions
  await flush()
  app.stdin.write(ENTER) // Set value…
  await flush()
  app.stdin.write('test-key-not-real')
  await flush()
  const masked = outputOf(app)
  assert.ok(!masked.includes('test-key-not-real'), '真值不该上屏')
  assert.ok(masked.includes('•'), '应回显掩码')
  app.stdin.write(ENTER)
  await flush(80)
  assert.deepEqual(setCalls, [{ ref: 'MOCK_API_KEY', value: 'test-key-not-real' }])
  const after = outputOf(app)
  assert.ok(after.includes('MOCK_API_KEY updated'), '回执只说更新了')
  assert.ok(!after.includes('test-key-not-real'), '回执不许带值')
  app.unmount()
})

test('凭证 unset：要一步确认；取消不删，确认才删', async (t) => {
  t.after(cleanup)
  const unsetCalls: string[] = []
  const app = renderCredentials({ onUnset: (ref) => { unsetCalls.push(ref); return Promise.resolve() } })
  await flush(80)
  app.stdin.write(ENTER) // MOCK_API_KEY → actions
  await flush()
  app.stdin.write(DOWN + ENTER) // Unset…
  await flush()
  assert.ok(outputOf(app).includes('Unset MOCK_API_KEY?'), '要有确认步')
  app.stdin.write(ENTER) // Cancel
  await flush()
  assert.deepEqual(unsetCalls, [], '取消不该删')
  app.stdin.write(ENTER) // actions  again
  await flush()
  app.stdin.write(DOWN + ENTER) // Unset…
  await flush()
  app.stdin.write(DOWN + ENTER) // 确认 Unset
  await flush(80)
  assert.deepEqual(unsetCalls, ['MOCK_API_KEY'])
  assert.ok(outputOf(app).includes('MOCK_API_KEY unset'))
  app.unmount()
})

test('未配置的 ref 没有 Unset 入口', async (t) => {
  t.after(cleanup)
  const app = renderCredentials({})
  await flush(80)
  app.stdin.write(DOWN + ENTER) // DEEPSEEK_API_KEY（未配置）→ actions
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('Set value…'))
  assert.ok(!out.includes('Unset…'), '没配过的不该有 Unset 入口')
  app.unmount()
})

test('CAS 冲突：刷新 revision 再让人重试，不死循环（回归）', async (t) => {
  t.after(cleanup)
  // ⚠️ 跨厂商评审（DeepSeek）挑出来的：原来冲突后只 setReceipt 就回字段屏，
  // **本地 revision 还是旧的** —— 人再改一次仍然拿旧 revision 去写，撞同一个冲突，
  // 只能关掉编辑器重开才能续上。不丢别人的改动，但丢自己的输入且重试死循环。
  let refreshed = 0
  const conflict = new Error(
    'settings.mutate failed: settings-conflict: settings namespace "fixture" changed since it was read (expected revision 7, now 9)',
  )
  const onMutate = (): Promise<SettingsNamespace> => Promise.reject(conflict)
  const onRefresh = (): Promise<SettingsOverview> => {
    refreshed++
    const fresh = fixtureOverview()
    return Promise.resolve({
      ...fresh,
      namespaces: fresh.namespaces.map((ns) => ({ ...ns, revision: 9 })),
    })
  }
  const app = render(
    h(SettingsEditor, { overview: fixtureOverview(), onMutate, onRefresh, onClose: () => {} }),
  )
  await flush()
  app.stdin.write(DOWN + ENTER)
  await flush()
  app.stdin.write(DOWN + DOWN + DOWN + DOWN + ENTER) // boolean 就地切换 → 触发 mutate
  await flush(80)

  const out = outputOf(app)
  assert.ok(out.includes('settings-conflict'), `冲突原因必须原样给人看: ${JSON.stringify(out.slice(0, 300))}`)
  assert.ok(out.includes('reloaded'), '必须说明已经重新拉过，可以重试')
  assert.strictEqual(refreshed, 1, 'CAS 冲突必须触发一次 describe 刷新，否则重试永远撞同一堵墙')
  app.unmount()
})
