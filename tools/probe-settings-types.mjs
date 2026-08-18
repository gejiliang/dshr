#!/usr/bin/env node
/**
 * 数清楚设置 schema 里一共出现哪几种 `type` 和哪几种 `meta` 键——
 * 这决定 TUI 表单要做几种控件，别多做也别漏。
 *
 *   node tools/probe-settings-types.mjs [baseUrl]
 */
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:39086'
const { createDshrClient } = await import('@dshr/protocol')
const client = createDshrClient({ baseUrl })
await client.connect()
const res = await client.call('settings.describe', {})
if (!res.ok) {
  console.error(res.error)
  process.exit(1)
}

const types = new Map()
const metaKeys = new Map()
const roles = new Map()
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)

for (const ns of res.value.namespaces) {
  const schema = ns.schema
  if (typeof schema !== 'object' || schema === null) continue
  const refs = schema.refs ?? {}
  for (const ref of Object.values(refs)) {
    if (typeof ref !== 'object' || ref === null) continue
    bump(types, String(ref.type))
    for (const k of Object.keys(ref.meta ?? {})) bump(metaKeys, k)
    if (ref.meta?.role !== undefined) bump(roles, String(ref.meta.role))
  }
}

const show = (name, m) =>
  console.log(`${name}: ` + [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}(${n})`).join(' '))
show('type', types)
show('meta 键', metaKeys)
show('role', roles)

// 顺带看一个带 union / array 的例子，确认嵌套怎么表达
for (const ns of res.value.namespaces) {
  const refs = ns.schema?.refs ?? {}
  const interesting = Object.entries(refs).find(([, r]) => ['union', 'array', 'dict', 'intersect'].includes(r?.type))
  if (interesting) {
    console.log(`\n${ns.ns} 里的 ${interesting[1].type} 示例:`)
    console.log(JSON.stringify(interesting[1], null, 2).slice(0, 500))
    break
  }
}

await client.close()
process.exit(0)
