import { createDshrClient } from '@dshr/protocol'
const client = createDshrClient({ baseUrl: 'http://127.0.0.1:39081' })
await client.connect()
for (const [method, payload] of [
  ['settings.describe', {}],
  ['llm.providers', {}],
  ['llm.models', {}],
  ['credentials.describe', {}],
]) {
  const res = await client.call(method, payload)
  if (!res.ok) {
    console.log(`\n### ${method} → ${res.error.code}: ${res.error.message}`)
    if (res.error.details) console.log(JSON.stringify(res.error.details).slice(0, 800))
    continue
  }
  let json = JSON.stringify(res.value, null, 2)
  if (json.length > 4000) json = json.slice(0, 4000) + '\n…(截断)'
  console.log(`\n### ${method}\n${json}`)
}
await client.close?.()
process.exit(0)
