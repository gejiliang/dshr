#!/usr/bin/env node
/**
 * 排前提风险：**`settings.mutate` 到底能不能从客户端调通**（会不会被 `/api` 的信任栅栏挡）。
 *
 * 如果挡了，「在 TUI 里改设置」这个功能的前提就不成立，要早知道。
 *
 *   node tools/probe-settings-write.mjs [baseUrl]
 *
 * ⚠️ **只对隔离的 DSH_HOME 用**。它会真的写设置——虽然这里刻意「把字段设回它当前的值」，
 * 是一次无害写入，但仍然会让 revision 前进。别拿用户真实的 `~/.dsh` 打。
 */
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:39087'
const { createDshrClient } = await import('@dshr/protocol')
const client = createDshrClient({ baseUrl })
await client.connect()

const described = await client.call('settings.describe', {})
if (!described.ok) {
  console.error('settings.describe 失败:', described.error)
  process.exit(1)
}
const ns = described.value.namespaces.find((n) => n.ns === 'agent-loop') ?? described.value.namespaces[0]
if (ns === undefined) {
  console.error('一个命名空间都没有')
  process.exit(1)
}
console.log(`目标: ${ns.ns}  revision=${ns.revision}  applies=${ns.applies}  writable=${described.value.writable}`)

const root = ns.schema?.refs?.[String(ns.schema?.uid)]
const field = Object.keys(root?.dict ?? {})[0]
if (field === undefined) {
  console.error('这个命名空间没有可寻址的字段')
  process.exit(1)
}
const current = ns.value?.[field]
console.log(`字段 ${field} 当前 = ${JSON.stringify(current)}`)

// 无害写入：把字段设回它当前的值。只为回答「调不调得通」。
const wrote = await client.call('settings.mutate', {
  ns: ns.ns,
  ops: [{ op: 'set', path: [field], value: current }],
  expectedRevision: ns.revision,
})
console.log(
  'mutate →',
  wrote.ok ? `✅ ok，新 revision=${wrote.value.revision}` : `❌ ${wrote.error.code}: ${wrote.error.message}`,
)

// 再打一次 CAS：故意用过期的 revision，确认冲突是可识别的错误而不是静默覆盖。
const stale = await client.call('settings.mutate', {
  ns: ns.ns,
  ops: [{ op: 'set', path: [field], value: current }],
  expectedRevision: 0,
})
console.log(
  'CAS 用过期 revision →',
  stale.ok ? `⚠️ 居然成功了（说明 expectedRevision 没被当回事）` : `✅ 被拒: ${stale.error.code}: ${stale.error.message}`,
)

await client.close()
process.exit(0)
