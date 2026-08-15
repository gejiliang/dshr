/**
 * 集成测试：打 127.0.0.1:39080 上的真实 dsh web host（dsh 0.1.0-rc.6）。
 * **只读**——不调任何会创建会话 / 写配置的方法。
 * host 不可达时自动 skip，别的机器上也能跑。
 *
 * 运行前先 `npx tsc --build packages/protocol`（测试 import 构建产物 ../lib）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createDshrClient } from '../lib/index.js'

const BASE_URL = 'http://127.0.0.1:39080'

async function hostReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'host.describe', payload: {} }),
      signal: AbortSignal.timeout(2_000),
    })
    return response.ok
  } catch {
    return false
  }
}

const reachable = await hostReachable()
const skipIfNoHost = (t: { skip(msg?: string): void }): boolean => {
  if (!reachable) {
    t.skip(`dsh host 不在 ${BASE_URL}，跳过集成测试`)
    return true
  }
  return false
}

test('readiness 握手：两条 WebSocket 都开 + host.describe 成功 → ready', async (t) => {
  if (skipIfNoHost(t)) return
  const client = createDshrClient({ baseUrl: BASE_URL })
  await client.connect() //  resolve 本身就证明两条下行流都开了（readiness 的两半）
  const state = client.state
  assert.equal(state.status, 'ready')
  if (state.status === 'ready') {
    assert.equal(state.generation, 1)
    assert.equal(typeof state.host.version, 'string')
    assert.equal(typeof state.host.cwd, 'string')
    assert.equal(typeof state.host.attachedSessions, 'number')
  }
  await client.close()
  assert.equal(client.state.status, 'closed')
})

test('workspace.list 与 session.list 成功，业务结果走 result.value', async (t) => {
  if (skipIfNoHost(t)) return
  const client = createDshrClient({ baseUrl: BASE_URL })
  const workspaces = await client.call('workspace.list', {})
  assert.equal(workspaces.ok, true)
  if (workspaces.ok) {
    assert.ok(Array.isArray(workspaces.value.items))
    assert.ok(Array.isArray(workspaces.value.archivedSessionIds))
  }
  const sessions = await client.call('session.list', {})
  assert.equal(sessions.ok, true)
  if (sessions.ok) assert.ok(Array.isArray(sessions.value.items))
  await client.close()
})

test('respond 一个不存在会话的 rpcId → 回执 not-pending', async (t) => {
  if (skipIfNoHost(t)) return
  const client = createDshrClient({ baseUrl: BASE_URL })
  const receipt = await client.respond(RpcId(crypto.randomUUID()), { ok: true, value: null })
  assert.deepEqual(receipt, { accepted: false, reason: 'not-pending' })
  await client.close()
})
