#!/usr/bin/env node
/**
 * `dshr` 可执行文件——整个项目的收口。
 *
 * 装配顺序（docs/integration.md）：
 *   解析旗标 → createDshrClient({ baseUrl }) → client.connect()
 *     → createState({ client })
 *     → render(<Shell state components={{ Conversation, Composer, PendingPrompt }} />)
 */
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createDshrClient } from '@dshr/protocol'
import { Shell } from '@dshr/shell'
import { createState, type DshrState, type SessionId } from '@dshr/state'
import { render } from 'ink'
import { createElement as h } from 'react'
import { buildShellComponents } from './assemble.js'
import { FlagError, parseFlags, USAGE, type ParsedFlags } from './flags.js'
import { ensureHost, runServer, type HostHandle } from './host.js'
import { withResumeSession } from './resume.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 选 Shell 落在哪个工作区：等 state 基线化出工作区列表（最多 3s），
 * 还没有就在当前目录建一个。
 */
async function pickWorkspace(state: DshrState): Promise<string> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const first = state.workspaces[0]
    if (first !== undefined) return String(first.workspaceId)
    await sleep(50)
  }
  const created = await state.createWorkspace(process.cwd())
  return String(created)
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

  const state = createState({ client })

  let effectiveState: DshrState = state
  if (flags.resume !== undefined) {
    const sessionId = flags.resume as SessionId
    const history = await client.call('session.history', { sessionId })
    if (!history.ok) {
      process.stderr.write(`--resume: 会话 ${flags.resume} 读不到: ${history.error.code}: ${history.error.message}\n`)
      await state.dispose()
      await client.close()
      await host.close()
      return 1
    }
    effectiveState = withResumeSession(state, sessionId)
  }

  const workspaceId = await pickWorkspace(state)
  const components = buildShellComponents({ state: effectiveState, client })

  // ⚠️ 终端尺寸拿不到时给一个体面的默认值。
  // ink 直接读 `process.stdout.columns/rows` 决定布局宽度，而在**尺寸未知的 tty**
  // 下（`script`、部分 CI、某些多路复用器）拿到的是 **0**——注意是 0 不是 undefined，
  // 所以 `?? 80` 这种写法挡不住，整个界面会塌成一列、每个字一行。实测过。
  if (!(process.stdout.columns > 0)) process.stdout.columns = 80
  if (!(process.stdout.rows > 0)) process.stdout.rows = 24

  // exitOnCtrlC: false —— Ctrl-C 由我们自己的 SIGINT 处理走统一的 shutdown 路径。
  const app = render(h(Shell, { state: effectiveState, components, initialWorkspaceId: workspaceId }), {
    exitOnCtrlC: false,
  })

  let shuttingDown = false
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    // 顺序：先恢复终端（unmount），再断状态与连接，最后只关**自己拉起的** host。
    app.unmount()
    await state.dispose().catch(() => {})
    await client.close().catch(() => {})
    await host.close().catch(() => {})
    process.exitCode = code
  }
  const onSigint = (): void => void shutdown(130)
  const onSigterm = (): void => void shutdown(143)
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  await app.waitUntilExit()
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
  await shutdown(0)
  // Node 的 process.exitCode 类型是 string | number | undefined。
  return typeof process.exitCode === 'number' ? process.exitCode : 0
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
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
