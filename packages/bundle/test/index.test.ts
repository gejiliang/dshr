import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, DSHR_RUNTIME_SERVICE, startSurface, type DshrRuntime } from '../src/index.ts'

/** A minimal Cordis-context stand-in: service store plus an absent loader. */
function fakeContext() {
  const provided = new Map<string, unknown>()
  const ctx = {
    get(name: string): unknown {
      if (name === 'loader') return undefined
      return provided.get(name)
    },
    provide(name: string, value: unknown) {
      provided.set(name, value)
      return () => {}
    },
  }
  return { ctx, provided }
}

function captureLog<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = []
  const real = console.log
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  try {
    return { result: fn(), lines }
  } finally {
    console.log = real
  }
}

test('provides dshrRuntime with deployment fallbacks', () => {
  const { ctx, provided } = fakeContext()
  captureLog(() => apply(ctx as never, {}))
  assert.deepEqual(provided.get(DSHR_RUNTIME_SERVICE), { host: '127.0.0.1', port: 39080 })
})

test('row config (flags folded in by the patch) wins over fallbacks', () => {
  const { ctx, provided } = fakeContext()
  captureLog(() => apply(ctx as never, { host: '127.0.0.2', port: 1, connect: 'http://127.0.0.1:39080', resume: 'session-x' }))
  assert.deepEqual(provided.get(DSHR_RUNTIME_SERVICE), {
    host: '127.0.0.2',
    port: 1,
    connect: 'http://127.0.0.1:39080',
    resume: 'session-x',
  } satisfies DshrRuntime)
})

test('`--connect` 时印一行启动信息（树 settle 之后；没有 loader 就立刻印）', () => {
  const { ctx } = fakeContext()
  const { lines } = captureLog(() =>
    apply(ctx as never, { connect: 'http://127.0.0.1:39081', resume: 'session-x' }),
  )
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /resume session-x/)
})

test('挂界面时一个字都不许印——ink 接管了这块屏幕', () => {
  const { ctx } = fakeContext()
  // 没有 connect = 走进程内、自己挂 ink。这时候 console.log 会把画面撕开：
  // 那行会留在 ink 的渲染区里，下一帧擦不掉。
  const { lines } = captureLog(() => apply(ctx as never, { resume: 'session-x' }))
  assert.deepEqual(lines, [])
})

test('`--connect` 不走这条接缝：远程 attach 归网络 carrier', async () => {
  const { ctx } = fakeContext()
  // 给了 connect 就该在碰 apiProxy 之前直接返回——这个 fake 上根本没有 apiProxy，
  // 所以「没抛错」本身就是「没去碰它」的证明。
  const handle = await startSurface(ctx as never, {
    runtime: { host: '127.0.0.1', port: 39080, connect: 'http://127.0.0.1:39081' },
  })
  assert.equal(handle, undefined)
})

test('profile 少了 api-gateway 行时，报一句人能读懂的话', async () => {
  const { ctx } = fakeContext()
  await assert.rejects(
    () => startSurface(ctx as never, { runtime: { host: '127.0.0.1', port: 39080 } }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      // 少一行是最容易犯的错，而 `--dump-config` 看不出来（组合阶段不检查服务依赖）。
      // 所以这里必须指名道姓，不能是 TypeError: Cannot read properties of undefined。
      assert.match(message, /api-gateway/)
      assert.match(message, /dsh-host-apiproxy/)
      return true
    },
  )
})
