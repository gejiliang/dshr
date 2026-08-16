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

/** 退出时留给「断连接、关自己拉起的 host」的上限，超了就直接走。 */
const SHUTDOWN_BUDGET_MS = 1500

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

  // ⚠️ `exitOnCtrlC` 必须是 true。
  //
  // 终端进 raw mode 之后，**Ctrl-C 不再产生 SIGINT**——它就是一个字节（0x03）
  // 走正常输入通道。所以「设 exitOnCtrlC: false，自己挂 process.on('SIGINT')」
  // 这个写法看着更讲究，实际后果是**按 Ctrl-C 完全没反应，终端被扣住，
  // 只能开另一个窗口去 kill**。实测踩过。
  //
  // 交给 ink：它认得 0x03，会 unmount 并让 `waitUntilExit()` 返回，
  // 下面那段收尾照样跑，统一的 shutdown 路径一点没丢。
  const app = render(h(Shell, { state: effectiveState, components, initialWorkspaceId: workspaceId }), {
    exitOnCtrlC: true,
  })

  let shuttingDown = false
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    const trace = (s: string): void => {
      if (process.env.DSHR_TRACE_SHUTDOWN) process.stderr.write(`[shutdown] ${s}\n`)
    }
    // 先恢复终端——这一步必须同步做完，用户按了退出就该立刻拿回终端。
    trace('unmount')
    app.unmount()

    // ⚠️ 后面这些拆除**必须有上限**。
    // WebSocket 的关闭握手在对端不配合时可以永远不返回，实测就是这样：
    // 同一个交互脚本有时退得掉、有时挂死——一个「有时候退不出去」的 TUI
    // 从用户角度就是坏的。退出时我们并不需要优雅的关闭握手，到点就走。
    const teardown = (async () => {
      trace('state.dispose')
      await state.dispose().catch(() => {})
      trace('client.close')
      await client.close().catch(() => {})
      trace('host.close')
      await host.close().catch(() => {})
    })()
    await Promise.race([
      teardown,
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_BUDGET_MS).unref()),
    ])
    trace('done')
    process.exitCode = code
  }
  const onSigint = (): void => void shutdown(130)
  const onSigterm = (): void => void shutdown(143)
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  // ⚠️ Ctrl-C 自己盯，不全指望 ink。
  //
  // raw mode 下 Ctrl-C 不产生 SIGINT，只是一个字节（0x03）。ink 的 `exitOnCtrlC`
  // 认得它，**但会漏**：组件树在一轮对话里会换（Composer ↔ PendingPrompt、
  // 焦点变化），`useInput` 的挂载数量随之变动，而 0x03 恰好落在那个窗口里就没人接。
  // 实测症状是「刚出答案那一瞬间按 Ctrl-C 没反应，隔两秒再按就好」——
  // 而流式输出正在跑的时候，恰恰是最想按 Ctrl-C 的时候。
  //
  // 直接在 stdin 上看字节，与渲染状态无关。ink 的 exitOnCtrlC 保留着当第二道保险。
  const onStdinData = (chunk: Buffer | string): void => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    if (buf.includes(0x03)) void shutdown(130)
  }
  process.stdin.on('data', onStdinData)

  await app.waitUntilExit()
  process.stdin.off('data', onStdinData)
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
