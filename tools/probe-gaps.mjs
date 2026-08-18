#!/usr/bin/env node
/**
 * 把**缺口事件的真实载荷形状**从一台真的 dsh host 上打出来。
 *
 * `compaction/*`、`llm/retry*`、`plan/mode`、`hook/*`、`schedule/change` 这些事件
 * **不在核心 `SessionEventMap` 里**——它们由各插件做模块增强声明，
 * 而插件包发出来的 `.d.ts` 里也未必有。所以只能打。
 * （`todo/write`、`subagent/descriptor`、`command/*`、`goal/change` 在包里查得到，
 *   这里一并打出来做交叉验证。）
 *
 * 用法：
 *   # 造重试：让 mock 先失败两次再成功
 *   node tools/mock-llm.mjs --port 8100 --sequence rate_limit,server_error,success
 *   node tools/probe-gaps.mjs http://127.0.0.1:39081 "跑一下"
 *
 * 每种事件只留**第一份**原始 JSON，超过 2KB 的截断。
 */
import { createDshrClient } from '@dshr/protocol'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:39081'
const prompt = process.argv[3] ?? 'hello'
const cwd = process.argv[4] ?? process.cwd()

const client = createDshrClient({ baseUrl })

/** 每种事件的第一份样本 + 计数。 */
const samples = new Map()
const counts = new Map()

/** `request/header` 里带着组装好的全部工具 schema——这是查 dsh 真实工具名的唯一可靠来源。 */
const toolNames = new Set()

function record(type, payload) {
  counts.set(type, (counts.get(type) ?? 0) + 1)
  if (!samples.has(type)) samples.set(type, payload)
  if (type === 'request/header') {
    for (const tool of payload?.data?.header?.tools ?? []) {
      if (tool?.name) toolNames.add(tool.name)
    }
  }
}

client.onHostFrame((frame) => record(`«host» ${frame.type}`, frame))

client.onMuxFrame((frame) => {
  if (frame.type === 'session/event') {
    const event = frame.event
    record(event?.type ?? '(no type)', event)
    return
  }
  record(`«mux» ${frame.type}`, frame)
})

await client.connect()

const created = await client.call('session.create', { cwd })
if (!created.ok) {
  console.error('session.create failed:', created.error)
  process.exit(1)
}
const sessionId = created.value.sessionId
console.log(`session: ${sessionId}`)

// goal.* 是直接可调的，顺手把 goal/change 的形状也打出来。
// ⚠️ 载荷形状是猜的——失败了就把 zod 的 issues 打全，那份报错本身就是形状说明书。
const goal = await client.call('goal.create', { sessionId, content: [{ type: 'text', text: 'probe goal' }] })
if (!goal.ok) console.log(`goal.create → ${goal.error.code}: ${JSON.stringify(goal.error.details)}`)
else console.log('goal.create → ok')

// 形状照 packages/state/src/state.ts 里已经验证过的那份，别另猜。
const sent = await client.call('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: prompt }],
})
if (!sent.ok) console.error('session.prompt failed:', sent.error)

// 等这一轮跑完（host/session-status running=false），最多 60s。
await new Promise((resolve) => {
  let settled = false
  const finish = () => {
    if (settled) return
    settled = true
    resolve()
  }
  client.onHostFrame((frame) => {
    if (frame.type === 'host/session-status' && frame.running === false) setTimeout(finish, 1500).unref?.()
  })
  setTimeout(finish, 60_000).unref?.()
})

// C/D/E 批要用的只读方法，一次问清楚返回形状。失败的把 zod issues 打出来——
// 那份报错本身就是载荷说明书（`goal.create` 的 `objective` 就是这么问出来的）。
console.log('\n── 只读方法探测 ──')
for (const [method, payload] of [
  ['session.models', { sessionId }],
  ['agentPreset.list', {}],
  ['skill.list', {}],
  ['llm.providers', {}],
  ['settings.describe', {}],
  ['credentials.describe', {}],
  ['host.describe', {}],
]) {
  const res = await client.call(method, payload)
  if (!res.ok) {
    console.log(`\n### ${method} → ${res.error.code}: ${res.error.message}`)
    if (res.error.details) console.log(JSON.stringify(res.error.details).slice(0, 400))
    continue
  }
  let json = JSON.stringify(res.value, null, 2)
  if (json.length > 1200) json = `${json.slice(0, 1200)}\n… (截断)`
  console.log(`\n### ${method}\n${json}`)
}

console.log(`\n── 工具（来自 request/header，共 ${toolNames.size} 个）──`)
console.log([...toolNames].sort().join('  '))

console.log('\n── 事件直方图 ──')
for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(String(n).padStart(4), type)
}

console.log('\n── 每种事件的第一份原始样本 ──')
for (const [type, payload] of samples) {
  let json
  try {
    json = JSON.stringify(payload, null, 2)
  } catch {
    json = String(payload)
  }
  if (json.length > 2000) json = `${json.slice(0, 2000)}\n… (截断，共 ${json.length} 字符)`
  console.log(`\n### ${type}\n${json}`)
}

await client.close?.()
process.exit(0)
