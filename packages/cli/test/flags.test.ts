/**
 * 旗标解析的单测 + 真实进程级的退出码验证（`node lib/main.js --help` 等）。
 * 运行前先 `npx tsc --build packages/cli`（测试 import 构建产物 ../lib）。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FlagError, parseFlags, DEFAULT_PORT } from '../lib/flags.js'

const mainJs = fileURLToPath(new URL('../lib/main.js', import.meta.url))

/** 跑真实进程，拿退出码与输出。 */
function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [mainJs, ...args], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error !== null && error.code === undefined && error.signal === undefined) return reject(error)
      resolve({ code: error === null ? 0 : (error.code ?? null), stdout, stderr })
    })
  })
}

test('无参数：默认 tui 形态，默认端口', () => {
  assert.deepEqual(parseFlags([]), { mode: 'tui', port: DEFAULT_PORT })
})

test('server 子命令：默认与显式端口', () => {
  assert.deepEqual(parseFlags(['server']), { mode: 'server', port: DEFAULT_PORT })
  assert.deepEqual(parseFlags(['server', '--port', '4000']), { mode: 'server', port: 4000 })
  assert.deepEqual(parseFlags(['server', '--port=4001']), { mode: 'server', port: 4001 })
})

test('--connect：loopback URL 归一化到 origin', () => {
  assert.deepEqual(parseFlags(['--connect', 'http://127.0.0.1:39081/']), {
    mode: 'tui',
    port: DEFAULT_PORT,
    connect: 'http://127.0.0.1:39081',
  })
  assert.deepEqual(parseFlags(['--connect=http://localhost:39081']), {
    mode: 'tui',
    port: DEFAULT_PORT,
    connect: 'http://localhost:39081',
  })
})

test('--connect 拒绝非 loopback：远程 attach 在认证层落地前不开', () => {
  assert.throws(() => parseFlags(['--connect', 'http://192.168.1.10:39081']), FlagError)
  assert.throws(() => parseFlags(['--connect', 'https://example.com']), FlagError)
})

test('--connect 与 --port 互斥', () => {
  assert.throws(() => parseFlags(['--connect', 'http://127.0.0.1:39081', '--port', '4000']), FlagError)
})

test('--resume 可单独用、可与 --connect 组合', () => {
  assert.deepEqual(parseFlags(['--resume', 'sess-123']), { mode: 'tui', port: DEFAULT_PORT, resume: 'sess-123' })
  assert.deepEqual(parseFlags(['--connect', 'http://127.0.0.1:39081', '--resume', 'sess-123']), {
    mode: 'tui',
    port: DEFAULT_PORT,
    connect: 'http://127.0.0.1:39081',
    resume: 'sess-123',
  })
})

test('server 不接受 --connect / --resume', () => {
  assert.throws(() => parseFlags(['server', '--connect', 'http://127.0.0.1:39081']), FlagError)
  assert.throws(() => parseFlags(['server', '--resume', 'sess-1']), FlagError)
})

test('错误旗标与缺值都抛 FlagError', () => {
  assert.throws(() => parseFlags(['--bogus']), FlagError)
  assert.throws(() => parseFlags(['--port']), FlagError)
  assert.throws(() => parseFlags(['--port', 'abc']), FlagError)
  assert.throws(() => parseFlags(['--port', '70000']), FlagError)
  assert.throws(() => parseFlags(['--connect']), FlagError)
  assert.throws(() => parseFlags(['--resume']), FlagError)
  assert.throws(() => parseFlags(['nonsense']), FlagError)
})

test('--help 是独立形态', () => {
  assert.deepEqual(parseFlags(['--help']), { mode: 'help' })
})

// ---- 进程级：退出码与输出 ----

test('进程级：--help 退出码 0 且打印用法', async () => {
  const { code, stdout } = await runCli(['--help'])
  assert.equal(code, 0)
  assert.match(stdout, /dshr --connect/)
  assert.match(stdout, /dshr server/)
})

test('进程级：错误旗标非零退出（2），用法进 stderr', async () => {
  const { code, stderr } = await runCli(['--bogus'])
  assert.equal(code, 2)
  assert.match(stderr, /不认识的参数/)
})

test('进程级：互斥组合非零退出（2）', async () => {
  const { code } = await runCli(['--connect', 'http://127.0.0.1:39081', '--port', '4000'])
  assert.equal(code, 2)
})
