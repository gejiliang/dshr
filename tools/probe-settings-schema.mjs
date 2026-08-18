#!/usr/bin/env node
/**
 * 把 `settings.describe` 里每个命名空间的 **schema 形状**打出来。
 *
 * 这决定「设置能不能在 TUI 里做成表单」：schema 够结构化就能按字段生成控件，
 * 否则只能退回编辑原始值。
 *
 *   node tools/probe-settings-schema.mjs [baseUrl]
 *
 * ⚠️ 只读。**别拿用户真实的 `~/.dsh` 打**——用隔离的 DSH_HOME 起一台。
 */
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:39086'
const { createDshrClient } = await import('@dshr/protocol')
const client = createDshrClient({ baseUrl })
await client.connect()

const res = await client.call('settings.describe', {})
if (!res.ok) {
  console.error('settings.describe failed:', res.error)
  process.exit(1)
}
const { writable, hasDocument, namespaces } = res.value
console.log(`writable=${writable} hasDocument=${hasDocument} namespaces=${namespaces.length}`)
console.log(namespaces.map((n) => `${n.ns}(${n.applies},rev${n.revision})`).join('  '))

for (const ns of namespaces.slice(0, 3)) {
  console.log(`\n${'='.repeat(60)}\n### ${ns.ns}  applies=${ns.applies}  revision=${ns.revision}`)
  console.log(`secrets: ${JSON.stringify(ns.secrets)}`)
  console.log(`--- value ---\n${JSON.stringify(ns.value, null, 2).slice(0, 700)}`)
  console.log(`--- schema ---\n${JSON.stringify(ns.schema, null, 2).slice(0, 1600)}`)
}

await client.close()
process.exit(0)
