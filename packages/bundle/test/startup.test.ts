import assert from 'node:assert/strict'
import { test } from 'node:test'
// Run straight from src: node strips types, and every import below is either
// runtime-real or `import type` (erased), so no build step is needed.
import { apply, DSHR_STARTUP_SERVICE, type DshrStartup } from '../src/startup.ts'
import { internals } from '@deepseek-ai/dsh-cmdline'

/** A minimal Cordis-context stand-in carrying exactly what parseCmdline reads. */
function fakeContext(args: string[]) {
  const provided = new Map<string, unknown>()
  const exitCodes: number[] = []
  const ctx = {
    get(name: string): unknown {
      if (name === 'cmdlineArgs') return { get: () => Object.freeze([...args]) }
      if (name === 'appExit') return (code: number) => void exitCodes.push(code)
      return undefined
    },
    provide(name: string, value: unknown) {
      provided.set(name, value)
      return () => {}
    },
  }
  return { ctx, provided, exitCodes }
}

/** Swap commander output away from the process streams for one parse. */
function captureOutput<T>(fn: () => T): { result: T; out: string; err: string } {
  let out = ''
  let err = ''
  const realOut = internals.stdout
  const realErr = internals.stderr
  internals.stdout = { write: (text: string) => void (out += text) } as typeof realOut
  internals.stderr = { write: (text: string) => void (err += text) } as typeof realErr
  try {
    return { result: fn(), out, err }
  } finally {
    internals.stdout = realOut
    internals.stderr = realErr
  }
}

function parse(args: string[]) {
  const fake = fakeContext(args)
  const io = captureOutput(() => apply(fake.ctx as never))
  return { ...fake, ...io }
}

test('no flags: provides an empty startup value', () => {
  const { provided, exitCodes } = parse([])
  assert.deepEqual(provided.get(DSHR_STARTUP_SERVICE), {})
  assert.deepEqual(exitCodes, [])
})

test('--port parses to a number', () => {
  const { provided } = parse(['--port', '39080'])
  assert.deepEqual(provided.get(DSHR_STARTUP_SERVICE), { port: 39080 })
})

test('--host 127.0.0.1 passes through', () => {
  const { provided } = parse(['--host', '127.0.0.1'])
  assert.deepEqual(provided.get(DSHR_STARTUP_SERVICE), { host: '127.0.0.1' })
})

test('--connect and --resume pass through', () => {
  const { provided } = parse(['--connect', 'http://127.0.0.1:39080', '--resume', 'session-abc'])
  assert.deepEqual(provided.get(DSHR_STARTUP_SERVICE), {
    connect: 'http://127.0.0.1:39080',
    resume: 'session-abc',
  } satisfies DshrStartup)
})

test('--host 0.0.0.0 is rejected before anything is provided', () => {
  const { provided, exitCodes, err } = parse(['--host', '0.0.0.0'])
  assert.equal(provided.has(DSHR_STARTUP_SERVICE), false)
  assert.deepEqual(exitCodes, [1])
  assert.match(err, /--host 0\.0\.0\.0 is intentionally not supported/)
})

test('non-numeric --port is a usage error', () => {
  const { provided, exitCodes, err } = parse(['--port', 'abc'])
  assert.equal(provided.has(DSHR_STARTUP_SERVICE), false)
  assert.deepEqual(exitCodes, [1])
  assert.match(err, /--port must be a number/)
})

test('--connect conflicts with --host/--port', () => {
  const { provided, exitCodes, err } = parse(['--connect', 'http://127.0.0.1:39080', '--port', '39080'])
  assert.equal(provided.has(DSHR_STARTUP_SERVICE), false)
  assert.deepEqual(exitCodes, [1])
  assert.match(err, /one family, not both/)
})

test('--help prints help and provides nothing', () => {
  const { provided, exitCodes, out } = parse(['--help'])
  assert.equal(provided.has(DSHR_STARTUP_SERVICE), false)
  assert.deepEqual(exitCodes, [0])
  assert.match(out, /--resume <sessionId>/)
})
