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

test('prints one startup line once the tree has settled (no loader: immediately)', () => {
  const { ctx } = fakeContext()
  const { lines } = captureLog(() => apply(ctx as never, { resume: 'session-x' }))
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /resume session-x/)
})

test('the surface seam mounts nothing in this version', async () => {
  const { ctx } = fakeContext()
  const handle = await startSurface(ctx as never, { runtime: { host: '127.0.0.1', port: 39080 } })
  assert.equal(handle, undefined)
})
