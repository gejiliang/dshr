/**
 * `defaultSpawnHost` 的回归测试。
 *
 * 这里只测**拉起进程这件事本身**，不真的去起 dsh——用 `DSHR_DSH_COMMAND`
 * 换成一个立刻结束的小命令即可。真 dsh 的启动由 tools/verify-tty.exp 覆盖。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaultSpawnHost } from '../lib/host.js'

test('defaultSpawnHost：日志重定向用的是有效 fd，拉起时不抛', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshr-host-test-'))
  const logPath = join(dir, 'host.log')

  // ⚠️ 这条断言是踩出来的：原实现把 `createWriteStream()` 的返回值直接塞进 `stdio`，
  // 而 WriteStream 是异步打开的、刚创建时 fd 还是 null，于是 Node 当场抛
  // ERR_INVALID_ARG_VALUE——`dshr` 裸跑（自己拉 host 的主路径）一启动就崩。
  // 离屏渲染的测试一条都碰不到这里。
  const previous = process.env['DSHR_DSH_COMMAND']
  process.env['DSHR_DSH_COMMAND'] = 'node -e console.error("hello-from-fake-host")'
  try {
    const child = defaultSpawnHost(39999, logPath)
    const code = await new Promise<number>((resolve, reject) => {
      child.on('exit', (c) => resolve(c ?? -1))
      child.on('error', reject)
    })
    assert.equal(code, 0, '假 host 应该正常退出')

    // stdout/stderr 确实落进了日志文件——TUI 画面不会被污染。
    const log = await readFile(logPath, 'utf8')
    assert.match(log, /hello-from-fake-host/)
  } finally {
    if (previous === undefined) delete process.env['DSHR_DSH_COMMAND']
    else process.env['DSHR_DSH_COMMAND'] = previous
  }
})
