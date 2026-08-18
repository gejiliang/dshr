/**
 * `@dshr/surface` —— **把一个 dsh 会话挂成终端界面**，与 carrier 无关。
 *
 * 存在的理由是「同一套挂载逻辑要被两条路共用」：
 *
 * - **插件路（默认）**：`dsh --profile dshr` 一个进程零端口，
 *   `@dshr/bundle` 的 `startSurface` 用进程内 carrier 调这里
 * - **网络路（`--connect`）**：`dshr --connect <url>` 接一台别人的 host，
 *   `packages/cli` 用 HTTP+WS carrier 调这里
 *
 * 下面那些终端处理（raw mode 下的 0x03、收尾预算、尺寸为 0）全是踩出来的，
 * **两条路都需要，所以不能留在任何一条路自己家里**。
 *
 * ⚠️ **这个包不认识 herdr。** 往 herdr 报 agent 状态是"给 dshr 做 herdr 插件"
 * 那一期的事，不是 dsh 插件本身的职责。所以它以 {@link MountSurfaceOptions.hooks}
 * 的形式注入——今天由 `packages/cli` 传进来，将来由 herdr 那边提供。
 */
import type { DshrClient } from '@dshr/protocol'
import { createState, type DshrState, type SessionId } from '@dshr/state'
import { render } from 'ink'
import { createElement as h } from 'react'
import { SessionApp } from './session-app.js'

export { SessionApp } from './session-app.js'
export type { SessionAppProps } from './session-app.js'

/** 退出时留给拆除的上限，超了就直接走。 */
const SHUTDOWN_BUDGET_MS = 1500

export interface SurfaceHooks {
  /** 会话换了（Switch session / fork）。 */
  readonly onSessionChange?: (sessionId: SessionId) => void
  /** 在 state / client 关闭**之前**跑（herdr 交还 agent 生命周期就挂这里）。 */
  readonly beforeTeardown?: () => Promise<void>
  /** 在 state / client 关闭**之后**跑（CLI 用它关自己拉起的 host）。 */
  readonly afterTeardown?: () => Promise<void>
}

export interface MountSurfaceOptions {
  readonly client: DshrClient
  /** 复用已有的 state；不给就自己建一个（并负责关它）。 */
  readonly state?: DshrState
  /** `--resume <id>`；不给就按 cwd 取工作区、在其下新建会话。 */
  readonly resume?: string
  /** 底栏与输入框显示用的部署默认值（`host.describe`）。 */
  readonly model?: string
  readonly provider?: string
  /** dshr 自身版本（底部版本行）。 */
  readonly version?: string
  readonly hooks?: SurfaceHooks
}

export interface SurfaceHandle {
  readonly sessionId: SessionId
  /** 界面退出（Ctrl-C / 命令面板的 Exit）时 resolve，给出退出码。 */
  waitUntilExit(): Promise<number>
  /** 主动拆掉（宿主要收工时用）。 */
  close(code?: number): Promise<void>
}

/**
 * 定下这个 surface 要显示哪个会话。
 *
 * 有 `resume` 就用它（先读一页历史确认存在，读不到直接报错，
 * 不要开一个空界面让人以为连上了）；否则按 **cwd** 取工作区、在其下新建一个会话。
 * 用 cwd 而不是「第一个工作区」是因为终端本来就带着 cwd，
 * 而 dsh 的工作区也是按路径去重的——两边天然对齐。
 */
export async function resolveSession(
  state: DshrState,
  options: { resume?: string },
): Promise<SessionId> {
  if (options.resume !== undefined) {
    const sessionId = options.resume as SessionId
    const failure = await state
      .conversation(sessionId)
      .loadOlder()
      .then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
    if (failure !== null) throw new Error(`--resume: 会话 ${options.resume} 读不到: ${failure}`)
    return sessionId
  }
  const cwd = process.cwd()
  const workspaceId = await state.createWorkspace(cwd)
  return state.createSession({ cwd, workspaceId })
}

/**
 * 挂载终端界面。返回后界面已经在跑，用 `waitUntilExit()` 等它结束。
 */
export async function mountSurface(options: MountSurfaceOptions): Promise<SurfaceHandle> {
  const ownsState = options.state === undefined
  const state = options.state ?? createState({ client: options.client })
  const sessionId = await resolveSession(state, {
    ...(options.resume !== undefined ? { resume: options.resume } : {}),
  })

  // ⚠️ 终端尺寸拿不到时给一个体面的默认值。
  // ink 直接读 `process.stdout.columns/rows` 决定布局宽度，而在**尺寸未知的 tty**
  // 下（`script`、部分 CI、某些多路复用器）拿到的是 **0**——注意是 0 不是 undefined，
  // 所以 `?? 80` 这种写法挡不住，整个界面会塌成一列、每个字一行。实测过。
  if (!(process.stdout.columns > 0)) process.stdout.columns = 80
  if (!(process.stdout.rows > 0)) process.stdout.rows = 24

  const active = { current: sessionId }

  // ⚠️ `exitOnCtrlC` 必须是 true。
  //
  // 终端进 raw mode 之后，**Ctrl-C 不再产生 SIGINT**——它就是一个字节（0x03）
  // 走正常输入通道。所以「设 exitOnCtrlC: false，自己挂 process.on('SIGINT')」
  // 这个写法看着更讲究，实际后果是**按 Ctrl-C 完全没反应，终端被扣住，
  // 只能开另一个窗口去 kill**。实测踩过。
  const app = render(
    h(SessionApp, {
      state,
      client: options.client,
      sessionId,
      onSessionChange: (id: SessionId) => {
        active.current = id
        options.hooks?.onSessionChange?.(id)
      },
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.version !== undefined ? { version: options.version } : {}),
    }),
    { exitOnCtrlC: true },
  )

  let shuttingDown = false
  let exitCode = 0
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    exitCode = code
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
      trace('hooks.beforeTeardown')
      await options.hooks?.beforeTeardown?.().catch(() => {})
      if (ownsState) {
        trace('state.dispose')
        await state.dispose().catch(() => {})
      }
      trace('client.close')
      await options.client.close().catch(() => {})
      trace('hooks.afterTeardown')
      await options.hooks?.afterTeardown?.().catch(() => {})
    })()
    await Promise.race([
      teardown,
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_BUDGET_MS).unref()),
    ])
    trace('done')
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

  const detach = (): void => {
    process.stdin.off('data', onStdinData)
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }

  return {
    sessionId,
    async waitUntilExit(): Promise<number> {
      await app.waitUntilExit()
      detach()
      await shutdown(exitCode)
      return exitCode
    },
    async close(code = 0): Promise<void> {
      detach()
      await shutdown(code)
    },
  }
}
