/**
 * `@dshr/protocol` 单元测试：打进程内假 host（node:http + ws），
 * 覆盖契约要求的载体行为，不依赖真实 dsh host。
 *
 * 运行前先 `npx tsc --build packages/protocol`（测试 import 构建产物 ../lib）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CarrierError, createDshrClient } from '../lib/index.js'
import type { ConnectionState, HostDescription } from '../lib/index.js'
import { FakeHost, waitFor } from './helpers.ts'

const DESCRIBE: HostDescription = {
  version: '0.0.1',
  cwd: '/tmp/fake',
  provider: 'fake',
  model: 'fake-1',
  attachedSessions: 0,
  canOpenPath: false,
}

const describeOk = { ok: true, value: DESCRIBE }

function unaryOk(method: string): unknown {
  if (method === 'host.describe') return describeOk
  return { ok: true, value: {} }
}

test('unary：信封组装正确，必带 Content-Type，rpcId 由 client 铸造且被回显', async () => {
  const host = await FakeHost.start({ onUnary: unaryOk })
  try {
    const client = createDshrClient({ baseUrl: host.baseUrl })
    const result = await client.call('workspace.list', {})
    assert.deepEqual(result, { ok: true, value: {} })

    assert.equal(host.posts.length, 1)
    const post = host.posts[0]!
    assert.equal(post.path, '/api/workspace.list')
    assert.match(post.contentType ?? '', /^application\/json/)
    const envelope = post.body as { type: string; rpcId: string; method: string; payload: unknown }
    assert.equal(envelope.type, 'client-request')
    assert.equal(envelope.method, 'workspace.list')
    assert.deepEqual(envelope.payload, {})
    // client 铸造的 uuid v4，host 原样回显（假 host 回显请求里的 rpcId，
    // client 校验一致才放行——不一致的情形见下面专项）。
    assert.match(envelope.rpcId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    await client.close()
  } finally {
    await host.close()
  }
})

test('unary：业务错误落在 result.error，不 throw（HTTP 仍是 200）', async () => {
  const host = await FakeHost.start({
    onUnary: (method) =>
      method === 'host.describe'
        ? describeOk
        : {
            ok: false,
            error: { code: 'session-not-found', message: 'no such session', details: { sessionId: 's-x' } },
          },
  })
  try {
    const client = createDshrClient({ baseUrl: host.baseUrl })
    const result = await client.call('session.list', {})
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, 'session-not-found')
      assert.equal(result.error.message, 'no such session')
    }
    await client.close()
  } finally {
    await host.close()
  }
})

test('unary：载体故障才 throw——非 2xx、非 JSON、坏信封', async () => {
  // 非 2xx（HTTP 状态只描述载体）
  {
    const host = await FakeHost.start({ unaryHttp: { status: 415, rawBody: 'Unsupported Media Type' } })
    try {
      const client = createDshrClient({ baseUrl: host.baseUrl })
      await assert.rejects(client.call('workspace.list', {}), (e) => {
        assert.ok(e instanceof CarrierError)
        assert.match(e.message, /HTTP 415/)
        return true
      })
      await client.close()
    } finally {
      await host.close()
    }
  }
  // 200 但非 JSON body
  {
    const host = await FakeHost.start({ unaryHttp: { status: 200, rawBody: '<html>nope</html>' } })
    try {
      const client = createDshrClient({ baseUrl: host.baseUrl })
      await assert.rejects(client.call('workspace.list', {}), /non-JSON/)
      await client.close()
    } finally {
      await host.close()
    }
  }
  // 坏信封（type 不对）
  {
    const host = await FakeHost.start({ unaryHttp: { status: 200, rawBody: '{"type":"wat"}' } })
    try {
      const client = createDshrClient({ baseUrl: host.baseUrl })
      await assert.rejects(client.call('workspace.list', {}), /malformed server-response/)
      await client.close()
    } finally {
      await host.close()
    }
  }
})

test('unary：rpcId 回显不一致 → 载体故障 throw', async () => {
  const host = await FakeHost.start()
  try {
    const client = createDshrClient({ baseUrl: host.baseUrl })
    // 先发一个正常调用确认假 host 回显 rpcId，再换手工 JSON 制造不一致
    await client.call('workspace.list', {})
    const sent = (host.posts[0]!.body as { rpcId: string }).rpcId
    host.options.unaryHttp = {
      status: 200,
      rawBody: JSON.stringify({
        type: 'server-response',
        rpcId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        result: { ok: true, value: {} },
      }),
    }
    assert.notEqual(sent, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    await assert.rejects(client.call('workspace.list', {}), /rpcId mismatch/)
    await client.close()
  } finally {
    await host.close()
  }
})

test('unary：超时与外部 AbortSignal 都是载体故障', async () => {
  const host = await FakeHost.start({ hangUnary: true })
  try {
    const client = createDshrClient({ baseUrl: host.baseUrl, timeoutMs: 100 })
    await assert.rejects(client.call('workspace.list', {}), CarrierError)
    const ac = new AbortController()
    const pending = client.call('workspace.list', {}, ac.signal)
    ac.abort()
    await assert.rejects(pending, CarrierError)
    await client.close()
  } finally {
    await host.close()
  }
})

test('respond：信封是 client-response、rpcId 只回显；回执两种形态都能解析', async () => {
  const host = await FakeHost.start({
    onRespond: (rpcId, result) => {
      // 回执取决于调用方给的 result，用来区分两个分支
      void result
      return rpcId === 'late-one' ? { accepted: false, reason: 'not-pending' } : { accepted: true }
    },
  })
  try {
    const client = createDshrClient({ baseUrl: host.baseUrl })
    const accepted = await client.respond('rpc-42' as never, { ok: true, value: { outcome: 'approved' } })
    assert.deepEqual(accepted, { accepted: true })
    const late = await client.respond('late-one' as never, { ok: true, value: null })
    assert.deepEqual(late, { accepted: false, reason: 'not-pending' })

    assert.equal(host.posts.length, 2)
    const first = host.posts[0]!.body as { type: string; rpcId: string; result: unknown }
    assert.equal(host.posts[0]!.path, '/api/respond')
    assert.match(host.posts[0]!.contentType ?? '', /^application\/json/)
    assert.equal(first.type, 'client-response')
    assert.equal(first.rpcId, 'rpc-42') // 回显，没有新铸
    await client.close()
  } finally {
    await host.close()
  }
})

test('readiness：两条流开 + host.describe 成功才 ready；describe 业务失败则 connect reject', async () => {
  // 正常握手
  {
    const host = await FakeHost.start({ onUnary: unaryOk })
    try {
      const client = createDshrClient({ baseUrl: host.baseUrl })
      const states: ConnectionState[] = []
      client.onConnectionChange((s) => states.push(s))
      await client.connect()
      const state = client.state
      assert.equal(state.status, 'ready')
      if (state.status === 'ready') {
        assert.equal(state.generation, 1)
        assert.equal(state.host.version, '0.0.1')
      }
      assert.equal(client.generation, 1)
      // 两条流确实都开了（readiness 的两半）
      assert.equal(host.muxSockets.length, 1)
      assert.equal(host.hostSockets.length, 1)
      assert.deepEqual(
        states.map((s) => s.status),
        ['ready'],
      )
      await client.close()
      assert.equal(client.state.status, 'closed')
    } finally {
      await host.close()
    }
  }
  // host.describe 返回业务错误 → 握手失败
  {
    const host = await FakeHost.start({
      onUnary: () => ({ ok: false, error: { code: 'internal', message: 'boom', details: {} } }),
    })
    try {
      const client = createDshrClient({ baseUrl: host.baseUrl })
      await assert.rejects(client.connect(), /host\.describe failed/)
      await client.close()
    } finally {
      await host.close()
    }
  }
})

test('下行帧：信封拆出 payload 与 rpcId 投递给对应监听者', async () => {
  const host = await FakeHost.start({ onUnary: unaryOk })
  try {
    const client = createDshrClient({ baseUrl: host.baseUrl })
    const muxFrames: unknown[] = []
    const hostFrames: unknown[] = []
    client.onMuxFrame((frame, rpcId) => muxFrames.push([frame, rpcId]))
    client.onHostFrame((frame, rpcId) => hostFrames.push([frame, rpcId]))
    await client.connect()

    host.pushMux({ type: 'session/subscribed', sessionId: 's-1', lastSeq: 3 }, 'srv-mux-1')
    host.pushHost({ type: 'host/session-status', sessionId: 's-1', running: true }, 'srv-host-1')

    await waitFor(() => muxFrames.length === 1 && hostFrames.length === 1, { label: 'frames' })
    const [muxFrame, muxRpcId] = muxFrames[0] as [unknown, string]
    assert.deepEqual(muxFrame, { type: 'session/subscribed', sessionId: 's-1', lastSeq: 3 })
    assert.equal(muxRpcId, 'srv-mux-1')
    const [hostFrame, hostRpcId] = hostFrames[0] as [unknown, string]
    assert.deepEqual(hostFrame, { type: 'host/session-status', sessionId: 's-1', running: true })
    assert.equal(hostRpcId, 'srv-host-1')
    await client.close()
  } finally {
    await host.close()
  }
})

test('重连：任一条流结束 → lost → 重建两条 → generation 自增', async () => {
  const host = await FakeHost.start({ onUnary: unaryOk })
  try {
    const client = createDshrClient({ baseUrl: host.baseUrl, maxReconnectDelayMs: 500 })
    const states: ConnectionState[] = []
    client.onConnectionChange((s) => states.push(s))
    await client.connect()
    assert.equal(client.generation, 1)

    host.dropStreams() // 两条都断（断一条同理，client 会作废整个 generation）

    await waitFor(() => client.generation === 2 && client.state.status === 'ready', {
      label: 'reconnect to generation 2',
    })
    // 重开流，没有对账也没有 since——假 host 记录每次升级即一条新 socket
    assert.equal(host.muxSockets.length, 2)
    assert.equal(host.hostSockets.length, 2)

    const statuses = states.map((s) => `${s.status}${'generation' in s ? `#${s.generation}` : ''}`)
    assert.deepEqual(statuses, ['ready#1', 'lost#1', 'ready#2'])
    await client.close()
  } finally {
    await host.close()
  }
})

test('stream/error 帧：按流终止处理，错误带进 lost 状态', async () => {
  const host = await FakeHost.start({ onUnary: unaryOk })
  try {
    const client = createDshrClient({ baseUrl: host.baseUrl, maxReconnectDelayMs: 500 })
    const states: ConnectionState[] = []
    client.onConnectionChange((s) => states.push(s))
    const muxFrames: unknown[] = []
    client.onMuxFrame((f) => muxFrames.push(f))
    await client.connect()

    host.pushMux({
      type: 'stream/error',
      error: { code: 'internal', message: 'mux blew up', details: {} },
    })

    await waitFor(() => client.generation === 2 && client.state.status === 'ready', {
      label: 'reconnect after stream/error',
    })
    // stream/error 帧本身不投递给业务监听者
    assert.equal(muxFrames.length, 0)
    const lost = states.find((s) => s.status === 'lost')
    assert.ok(lost && lost.status === 'lost')
    assert.equal(lost.error?.message, 'mux blew up')
    await client.close()
  } finally {
    await host.close()
  }
})

test('close：未决 unary 以载体故障 reject，之后不再有回调、不能再调用', async () => {
  const host = await FakeHost.start({ onUnary: unaryOk })
  try {
    const client = createDshrClient({ baseUrl: host.baseUrl })
    await client.connect()

    // 挂起一条 unary，再 close
    host.options.hangUnary = true
    const pending = client.call('workspace.list', {})
    const statesAfterClose: ConnectionState[] = []
    client.onConnectionChange((s) => statesAfterClose.push(s))
    const framesAfterClose: unknown[] = []
    client.onMuxFrame((f) => framesAfterClose.push(f))

    await client.close()
    await assert.rejects(pending, CarrierError)
    assert.equal(client.state.status, 'closed')
    await assert.rejects(client.call('workspace.list', {}), /closed/)
    await assert.rejects(client.connect(), /closed/)

    // close 之后没有任何新回调（closed 状态本身是在 close() 内同步发的最后一个）
    assert.deepEqual(statesAfterClose, [{ status: 'closed' }])
    host.pushMux({ type: 'session/subscribed', sessionId: 's-late', lastSeq: 0 })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(framesAfterClose.length, 0)
    await assert.rejects(client.respond('x' as never, { ok: true, value: null }), /closed/)
  } finally {
    await host.close()
  }
})
