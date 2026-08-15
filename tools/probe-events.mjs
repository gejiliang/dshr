#!/usr/bin/env node
/**
 * 从一台真的 dsh host 上把 `SessionEvent` 的**实际形状**打出来。
 *
 * 事件的联合类型在 `@deepseek-ai/dsh-session/types` 里，但真正长什么样、
 * 哪些字段真的会出现，读类型不如打一遍——`@dshr/state` 的折叠逻辑靠这个。
 *
 *   node tools/probe-events.mjs [baseUrl] [sessionId]
 */
import { createDshrClient } from '@dshr/protocol'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:39081'
const client = createDshrClient({ baseUrl })
await client.connect()

let sessionId = process.argv[3]
if (!sessionId) {
  const list = await client.call('session.list', {})
  if (!list.ok || list.value.items.length === 0) {
    console.error('no sessions on this host; run tools/e2e.mjs first')
    process.exit(1)
  }
  sessionId = list.value.items[list.value.items.length - 1].sessionId
}
console.log(`session: ${sessionId}\n`)

const history = await client.call('session.history', { sessionId })
if (!history.ok) {
  console.error('session.history failed:', history.error)
  process.exit(1)
}

const entries = history.value.events
const histogram = {}
for (const entry of entries) {
  const type = entry?.event?.type ?? entry?.type ?? '(unknown)'
  histogram[type] = (histogram[type] ?? 0) + 1
}

console.log('── event type histogram ──')
for (const [type, n] of Object.entries(histogram).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${type}`)
}

console.log('\n── first entry, verbatim ──')
console.log(JSON.stringify(entries[0], null, 1))

const marker = process.env.PROBE_MARKER ?? 'mock says'
const textish = entries.find((e) => JSON.stringify(e).includes(marker))
if (textish) {
  console.log(`\n── an entry containing ${JSON.stringify(marker)} ──`)
  console.log(JSON.stringify(textish, null, 1).slice(0, 1500))
}

console.log('\n── projections block keys ──')
console.log(Object.keys(history.value.projections ?? {}))
console.log('projections:', JSON.stringify(history.value.projections ?? {}, null, 1).slice(0, 800))

await client.close()
