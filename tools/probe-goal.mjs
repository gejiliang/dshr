import { createDshrClient } from '@dshr/protocol'
const client = createDshrClient({ baseUrl: 'http://127.0.0.1:39081' })
await client.connect()
const created = await client.call('session.create', { cwd: process.cwd() })
const sessionId = created.value.sessionId
console.log('session:', sessionId)
client.onMuxFrame((frame) => {
  if (frame.type === 'session/projection') {
    console.log('projection:', frame.key, JSON.stringify(frame.value).slice(0, 600))
  }
  if (frame.type === 'session/event' && frame.event?.type === 'goal/change') {
    console.log('goal/change event:', JSON.stringify(frame.event).slice(0, 600))
  }
})
const g = await client.call('goal.create', { sessionId, objective: 'probe objective', maxGoalRounds: 3 })
console.log('goal.create:', JSON.stringify(g))
await new Promise((r) => setTimeout(r, 1500))
const ref = g.ok ? g.value.ref : undefined
if (ref) {
  const p = await client.call('goal.pause', { sessionId, ref })
  console.log('goal.pause:', JSON.stringify(p))
  await new Promise((r) => setTimeout(r, 1000))
  if (p.ok) {
    const c = await client.call('goal.clear', { sessionId, ref: p.value.ref })
    console.log('goal.clear:', JSON.stringify(c))
  }
  await new Promise((r) => setTimeout(r, 1000))
}
// history 尾页的 projections 块里有没有 goal 键
const h = await client.call('session.history', { sessionId })
if (h.ok) console.log('history projections keys:', Object.keys(h.value.projections?.values ?? {}), 'goal =', JSON.stringify(h.value.projections?.values?.goal).slice(0, 300))
await client.close?.()
process.exit(0)
