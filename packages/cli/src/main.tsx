#!/usr/bin/env node
/**
 * `dshr` 可执行文件：**一个 pane 里的一个 dsh 会话**。
 *
 * 工作区、tab、pane、活跃 agent 侧栏——**全是 herdr 的活**，dshr 跑在它的 pane 里。
 * 曾经有过一个 `@dshr/shell` 把那一整套复刻了一遍，是方向性错误，已删；
 * 要看它长什么样：`git log -- packages/shell`。
 *
 * 装配顺序：
 *   解析旗标 → createDshrClient({ baseUrl }) → client.connect()
 *     → createState({ client }) → 定下 sessionId → render(<SessionApp/>)
 */
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { startReporter } from '@dshr/herdr'
import { createDshrClient } from '@dshr/protocol'
import { createState, type SessionId } from '@dshr/state'
import { mountSurface } from '@dshr/surface'
import { FlagError, parseFlags, USAGE, type ParsedFlags } from './flags.js'
import { ensureHost, runServer, type HostHandle } from './host.js'

const require = createRequire(import.meta.url)

/** dshr 自身版本（底部版本行用）。 */
function ownVersion(): string | undefined {
  try {
    const pkg = require('../package.json') as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

async function runTui(flags: Extract<ParsedFlags, { mode: 'tui' }>): Promise<number> {
  // --connect 给了就直接用，绝不再自己起 host。
  const host: HostHandle =
    flags.connect !== undefined
      ? { baseUrl: flags.connect, owned: false, close: () => Promise.resolve() }
      : await ensureHost({ port: flags.port })

  const client = createDshrClient({ baseUrl: host.baseUrl })
  try {
    await client.connect()
  } catch (error) {
    await host.close()
    process.stderr.write(`连不上 host ${host.baseUrl}: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const described = await client.call('host.describe', {})
  const model = described.ok ? described.value.model : undefined
  const provider = described.ok ? described.value.provider : undefined
  const version = ownVersion()

  // state 由**这里**建并持有：herdr 的上报要用它，拆除顺序也归这条路自己管
  // （所以下面 mountSurface 传了 state，它就不会去 dispose 别人的东西）。
  const state = createState({ client })
  const active: { current?: SessionId } = {}
  // ⚠️ herdr 上报**不是 `@dshr/surface` 的依赖，是这条路注入的**。
  // 「给 dshr 做 herdr 插件」是下一期的事，不是 dsh 插件本身的职责；
  // 插件路（`dsh --profile dshr`）不会走到这里。
  // 不在 herdr 里跑时 startReporter 自己是 no-op（判据是 HERDR_PANE_ID 在不在）。
  let reporter: { dispose(): Promise<void> } | undefined

  let surface
  try {
    surface = await mountSurface({
      client,
      state,
      ...(flags.resume !== undefined ? { resume: flags.resume } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(version !== undefined ? { version } : {}),
      hooks: {
        onSessionChange: (id) => {
          active.current = id
        },
        // 先交还 herdr 的 agent 生命周期，否则侧栏留一个永远 idle 的幽灵。
        beforeTeardown: async () => {
          await reporter?.dispose()
        },
        // state 与自己拉起的 host 归这条路关。
        afterTeardown: async () => {
          await state.dispose().catch(() => {})
          await host.close().catch(() => {})
        },
      },
    })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    await state.dispose().catch(() => {})
    await client.close().catch(() => {})
    await host.close().catch(() => {})
    return 1
  }

  active.current = surface.sessionId
  reporter = startReporter({ state, sessionId: () => active.current as SessionId })

  return surface.waitUntilExit()
}

export async function main(argv: readonly string[]): Promise<number> {
  let flags: ParsedFlags
  try {
    flags = parseFlags(argv)
  } catch (error) {
    if (error instanceof FlagError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`)
      return 2
    }
    throw error
  }
  if (flags.mode === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  if (flags.mode === 'server') return runServer({ port: flags.port })
  return runTui(flags)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => finish(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
      finish(1)
    },
  )
}

/**
 * 收尾之后**显式退出**。
 *
 * ⚠️ 只设 `process.exitCode` 是不够的：那只在事件循环自己排空时才生效。
 * 一个 TUI 收尾后总还剩点东西吊着循环（WebSocket 的收尾、raw-mode 的 stdin、
 * 上游库自己的定时器），于是**界面已经没了、进程还在**——从用户角度就是
 * 「按了 Ctrl-C 没反应，终端被扣住」。实测踩过：Ctrl-C 之后进程活了 6 分钟。
 *
 * 到这里该拆的都拆了，走人即可。stdout 对 TTY 是同步写，不存在没刷完的输出。
 */
function finish(code: number): void {
  process.exitCode = code
  process.exit(code)
}
