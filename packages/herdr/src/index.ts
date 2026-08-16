/**
 * 把 dshr 的会话状态报给 herdr，让它在侧栏里当一等公民 agent。
 *
 * **这里没有 watcher，也不解析终端画面**——那是 `herdr-openclaw` 那类插件不得不做的事，
 * 因为它们只能从外面看一个黑盒 TUI。dshr 不一样：
 *
 * - pane 身份直接来自环境变量（herdr 给每个 pane 注入 `HERDR_PANE_ID`，实测）
 * - agent 状态来自 dsh host 的**权威事件**（`host/session-status`、未决的
 *   approval/question 帧），不是从画面上猜的——上游改了状态行也不会断
 *
 * 所以上报就是「state 变了就说一声」，仅此而已。
 *
 * 契约（`herdr pane --help`，0.8.x 实测）：
 *   herdr pane report-agent <PANE_ID> --source <ID> --agent <LABEL> --state <STATUS>
 *        [--message <TEXT>] [--agent-session-id <ID>]
 *   herdr pane release-agent <PANE_ID> --source <ID> --agent <LABEL>
 */
import { spawn } from 'node:child_process'
import type { AgentStatus, DshrState, SessionId } from '@dshr/state'

/** 这个上报源的标识；herdr 用它区分「谁在为这个 pane 的 agent 生命周期负责」。 */
export const SOURCE_ID = 'dshr'
/** 侧栏里显示的 agent 名。`--agent` 接受任意标签（herdr-openclaw 已验证过这一点）。 */
export const AGENT_LABEL = 'dsh'

/** herdr 认的状态集合。dshr 的 `error` 没有对应项，落到 `unknown` 并带上消息。 */
export type HerdrState = 'idle' | 'working' | 'blocked' | 'unknown'

export function toHerdrState(status: AgentStatus): HerdrState {
  return status === 'error' ? 'unknown' : status
}

/** 当前 pane 的 id；不在 herdr 里跑时是 undefined。 */
export function currentPaneId(): string | undefined {
  const id = process.env['HERDR_PANE_ID']
  return id !== undefined && id !== '' ? id : undefined
}

/**
 * 跑一条 herdr 写命令。**尽力而为**：herdr 没跑、pane 没了、命令不存在，
 * 都只是让 dshr 少一个侧栏状态，绝不能让 TUI 出事。
 *
 * 用异步 `spawn` 而不是 `spawnSync`：这会在每次状态翻转时被调到，
 * 同步阻塞会卡住渲染。写类命令**成功时没有任何 stdout**，所以不看输出、只看退出码。
 */
function run(args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn('herdr', args, { stdio: 'ignore' })
      child.on('error', () => resolve(false))
      child.on('exit', (code) => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}

export interface ReporterOptions {
  readonly state: DshrState
  readonly sessionId: SessionId
  /** 覆盖 pane id（测试用）。默认读 `HERDR_PANE_ID`。 */
  readonly paneId?: string
  /** 覆盖命令执行器（测试用）。 */
  readonly exec?: (args: readonly string[]) => Promise<boolean>
}

export interface Reporter {
  /** 交还 agent 生命周期并停止上报。退出路径上调用。 */
  dispose(): Promise<void>
}

/**
 * 订阅 state，把这个会话的状态报给 herdr。
 *
 * 不在 herdr 里跑（没有 `HERDR_PANE_ID`）时**什么都不做**——dshr 必须能脱离 herdr 单独用。
 */
export function startReporter(options: ReporterOptions): Reporter {
  const paneId = options.paneId ?? currentPaneId()
  const exec = options.exec ?? run
  if (paneId === undefined) {
    return { dispose: () => Promise.resolve() }
  }

  const base = [paneId, '--source', SOURCE_ID, '--agent', AGENT_LABEL]
  let last: HerdrState | null = null
  let lastMessage: string | undefined
  let disposed = false

  // 会话身份先报一次：侧栏据此把 pane 和 dsh 会话对应起来。
  void exec(['pane', 'report-agent-session', ...base, '--agent-session-id', String(options.sessionId)])

  const push = (): void => {
    if (disposed) return
    const summary = options.state.sessions.get(options.sessionId)
    if (summary === undefined) return
    const next = toHerdrState(summary.status)
    // blocked 时把「在等什么」写进 message，侧栏一眼能看出该去处理哪个。
    const message =
      summary.status === 'blocked' && summary.pending !== undefined
        ? summary.pending.kind === 'approval'
          ? `approval: ${summary.pending.toolName}`
          : 'question'
        : summary.status === 'error'
          ? summary.error
          : undefined
    if (next === last && message === lastMessage) return
    last = next
    lastMessage = message
    void exec([
      'pane',
      'report-agent',
      ...base,
      '--state',
      next,
      ...(message !== undefined ? ['--message', message] : []),
    ])
  }

  push()
  const unsubscribe = options.state.subscribe(push)

  return {
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      unsubscribe()
      // 交还生命周期，否则 dshr 退出后侧栏会留一个永远 idle 的幽灵 agent。
      await exec(['pane', 'release-agent', ...base])
    },
  }
}
