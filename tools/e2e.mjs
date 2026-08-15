#!/usr/bin/env node
/**
 * 端到端冒烟：用 `@dshr/protocol` 连一台真的 dsh host，建会话、发提示、看流式输出。
 *
 * 这是「这东西真的能跑」的证据——单测证明不了跨进程的那一半。
 *
 *   # 1) 起 mock 端点（零凭据）
 *   node tools/mock-llm.mjs --port 8100 --text "hello from the mock"
 *
 *   # 2) 起 host，指向 mock（settings.yaml 见 docs/profile.md）
 *   MOCK_API_KEY=mock-key DSH_HOME=/tmp/dshhome \
 *     npx @deepseek-ai/dsh@0.1.0-rc.6 web --port 39081
 *
 *   # 3) 跑这个
 *   node tools/e2e.mjs http://127.0.0.1:39081
 */
import { createDshrClient } from '@dshr/protocol'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:39081'
const cwd = process.argv[3] ?? process.cwd()

const client = createDshrClient({ baseUrl })

const seen = { text: '', tools: [], done: false }

client.onConnectionChange((s) => console.log(`· connection: ${s.status}`))

client.onHostFrame((frame) => {
  if (frame.type === 'host/session-status') {
    console.log(`· session-status running=${frame.running}`)
    if (!frame.running) seen.done = true
  }
  if (frame.type === 'host/agent-error') console.error(`· agent-error: ${frame.message}`)
})

client.onMuxFrame((frame) => {
  if (frame.type === 'session/event') {
    const e = frame.event
    // 事件形状随上游版本漂移，这里只做粗读，够证明流是通的。
    const type = e?.type ?? '?'
    if (type.includes('text')) {
      const delta = e?.delta ?? e?.text ?? ''
      if (typeof delta === 'string') {
        seen.text += delta
        process.stdout.write(delta)
      }
    } else if (type.startsWith('tool/')) {
      seen.tools.push(type)
      console.log(`\n· ${type}`)
    }
  }
  if (frame.type === 'approval/requested') {
    console.log(`\n· approval requested for ${frame.toolName} (rpcId ${frame.rpcId ?? '?'})`)
  }
})

console.log(`connecting to ${baseUrl} …`)
await client.connect()
console.log(`ready (generation ${client.generation})`)

const created = await client.call('session.create', { cwd })
if (!created.ok) {
  console.error('session.create failed:', created.error)
  process.exit(1)
}
const { sessionId } = created.value
console.log(`session: ${sessionId}`)

const prompted = await client.call('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: 'Reply with exactly one short sentence.' }],
  clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
})
if (!prompted.ok) {
  console.error('session.prompt failed:', prompted.error)
  process.exit(1)
}
console.log('prompt accepted, streaming:\n')

const deadline = Date.now() + 60_000
while (!seen.done && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200))
}

console.log('\n\n── result ──')
console.log(`streamed text : ${JSON.stringify(seen.text)}`)
console.log(`tool events   : ${seen.tools.length ? seen.tools.join(', ') : '(none)'}`)
console.log(`turn finished : ${seen.done}`)

const history = await client.call('session.history', { sessionId })
console.log(`history events: ${history.ok ? history.value.events.length : `failed ${history.error.code}`}`)

await client.close()
process.exit(seen.done && seen.text.length > 0 ? 0 : 1)
