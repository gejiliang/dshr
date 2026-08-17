#!/usr/bin/env node
/** 打 C 批写方法的载荷形状。只动会话级的东西，不碰 settings/credentials。 */
import { createDshrClient } from '@dshr/protocol'

const client = createDshrClient({ baseUrl: 'http://127.0.0.1:39081' })
await client.connect()

const created = await client.call('session.create', { cwd: process.cwd() })
if (!created.ok) {
  console.error('session.create failed', created.error)
  process.exit(1)
}
const sessionId = created.value.sessionId
console.log('session:', sessionId)

async function probe(method, payload) {
  const res = await client.call(method, payload)
  if (res.ok) {
    console.log(`\n### ${method}  ✅`)
    console.log(JSON.stringify(res.value, null, 2).slice(0, 500))
  } else {
    console.log(`\n### ${method}  ❌ ${res.error.code}: ${res.error.message}`)
    if (res.error.details) console.log(JSON.stringify(res.error.details).slice(0, 500))
  }
  return res
}

// 先看空对象报什么，zod 的 issues 就是说明书
await probe('session.selectModel', { sessionId })
await probe('agentPreset.select', { sessionId })
await probe('session.rename', { sessionId })
await probe('session.fork', { sessionId })
await probe('session.search', {})
await probe('session.updateQueue', { sessionId })
await probe('session.attachment', { sessionId })
await probe('skill.list', { sessionId })

// 第二轮：带上第一轮逼出来的必填字段，确认成功形状。
// ⚠️ agentPreset.select 的键是 `agentPreset`，不是 `presetId`——猜错过一次。
await probe('agentPreset.select', { sessionId, agentPreset: 'minimal' })
await probe('session.selectModel', { sessionId, provider: 'mock', model: 'mock-model' })
await probe('session.rename', { sessionId, title: '探针改的标题' })
await probe('session.search', { query: '探针' })
await probe('session.updateQueue', { sessionId, itemId: 'nope', action: {} })
await probe('session.attachment', { sessionId, attachmentId: 'nope' })

await client.close?.()
process.exit(0)
