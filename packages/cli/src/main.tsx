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
import { runProfile } from './profile.js'

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

/**
 * `--connect <url>`：接一台**别人已经起好**的 host。
 *
 * ⚠️ 这条路**不走 profile**，也不在本进程里起 host plane。理由：profile 会无条件
 * 挂一整套 storage / agent / sessions，attach 到别人 host 的时候那套完全用不上，
 * 还会和目标 host 抢同一个 `$DSH_HOME/sessions`。
 * 所以这里是一个光杆 Node 进程：HTTP+WS carrier + 同一个 `@dshr/surface`。
 */
async function runConnected(flags: Extract<ParsedFlags, { mode: 'tui' }> & { connect: string }): Promise<number> {
  const client = createDshrClient({ baseUrl: flags.connect })
  try {
    await client.connect()
  } catch (error) {
    process.stderr.write(`连不上 host ${flags.connect}: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const described = await client.call('host.describe', {})
  const model = described.ok ? described.value.model : undefined
  const provider = described.ok ? described.value.provider : undefined
  const version = ownVersion()

  const state = createState({ client })
  const active: { current?: SessionId } = {}
  // ⚠️ herdr 上报**不是 `@dshr/surface` 的依赖，是这条路注入的**。
  // 「给 dshr 做 herdr 插件」是下一期的事，不是 dsh 插件本身的职责。
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
        afterTeardown: async () => {
          await state.dispose().catch(() => {})
        },
      },
    })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    await state.dispose().catch(() => {})
    await client.close().catch(() => {})
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
  // 裸跑 = 插件路：交给 `dsh --profile dshr`，界面在那个进程里挂（零端口）。
  // 只有 `--connect` 才留在这个进程里，用 HTTP carrier 接别人的 host。
  if (flags.connect === undefined) {
    return runProfile({ ...(flags.resume !== undefined ? { resume: flags.resume } : {}) })
  }
  return runConnected({ ...flags, connect: flags.connect })
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
