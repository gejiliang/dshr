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
import { pathToFileURL } from 'node:url'
import { startReporter } from '@dshr/herdr'
import { createDshrClient } from '@dshr/protocol'
import { createState, type DshrState, type SessionId } from '@dshr/state'
import { render } from 'ink'
import { createElement as h } from 'react'
import { FlagError, parseFlags, USAGE, type ParsedFlags } from './flags.js'
import { ensureHost, runServer, type HostHandle } from './host.js'
import { SessionApp } from './session-app.js'

/** 退出时留给「断连接、关自己拉起的 host」的上限，超了就直接走。 */
const SHUTDOWN_BUDGET_MS = 1500

/**
 * 定下这个 pane 要显示哪个会话。
 *
 * 有 `--resume` 就用它（先读一页历史确认存在，读不到直接报错退出，
 * 不要开一个空界面让人以为连上了）；否则按 **cwd** 取工作区、在其下新建一个会话。
 * 用 cwd 而不是「第一个工作区」是因为 herdr 的 pane 本来就带着 cwd，
 * 而 dsh 的工作区也是按路径去重的——两边天然对齐。
 */
async function resolveSession(
  state: DshrState,
  flags: Extract<ParsedFlags, { mode: 'tui' }>,
): Promise<SessionId | { error: string }> {
  if (flags.resume !== undefined) {
    const sessionId = flags.resume as SessionId
    const history = await state.conversation(sessionId).loadOlder().then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
    if (history !== null) return { error: `--resume: 会话 ${flags.resume} 读不到: ${history}` }
    return sessionId
  }
  const cwd = process.cwd()
  const workspaceId = await state.createWorkspace(cwd)
  return state.createSession({ cwd, workspaceId })
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

  const resolved = await resolveSession(state, flags)
  if (typeof resolved === 'object') {
    process.stderr.write(`${resolved.error}\n`)
    await state.dispose()
    await client.close()
    await host.close()
    return 1
  }
  const sessionId = resolved
  const described = await client.call('host.describe', {})
  const model = described.ok ? described.value.model : undefined

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
  // 跑在 herdr 的 pane 里就把状态报上去，侧栏据此把这个 pane 显示成一个 agent。
  // 不在 herdr 里跑时它自己是 no-op（判据是 `HERDR_PANE_ID` 在不在）。
  const herdr = startReporter({ state, sessionId })

  const app = render(
    h(SessionApp, { state, client, sessionId, ...(model !== undefined ? { model } : {}) }),
    { exitOnCtrlC: true },
  )

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
      // 先交还 herdr 的 agent 生命周期，否则侧栏留一个永远 idle 的幽灵。
      trace('herdr.dispose')
      await herdr.dispose().catch(() => {})
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
