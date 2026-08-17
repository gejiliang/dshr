/**
 * 一个 pane = 一个会话的全屏 TUI。
 *
 * **这里没有 tab、没有 pane、没有侧栏**--那些是 herdr 的活，dshr 跑在它的 pane 里。
 * 曾经有过一个 `@dshr/shell` 复刻了那一整套，是方向性错误，已删
 * （要看它长什么样：`git log -- packages/shell`）。
 *
 * 视觉判据在 docs/opencode-reference.md（实测截屏）与上游源码，
 * 布局照 opencode：左列对话 + 输入框（左右 padding 2），右侧信息列
 * （width 42，pane 窄于 100 列整列折叠），底部一行 cwd + 状态 chip。
 */
import type { DshrClient } from '@dshr/protocol'
import type { DshrState, SessionId } from '@dshr/state'
import {
  CommandPalette,
  Composer,
  Conversation,
  Footer,
  Logo,
  PendingPrompt,
  Sidebar,
  createCommandRegistry,
  type CommandRegistry,
} from '@dshr/tui'
import { Box, useApp, useInput, useStdout } from 'ink'
import { useEffect, useReducer, useRef, useState, type ReactElement } from 'react'

export interface SessionAppProps {
  readonly state: DshrState
  readonly client: DshrClient
  readonly sessionId: SessionId
  /** host 的部署默认模型（host.describe），输入框与底栏用。 */
  readonly model?: string
  readonly provider?: string
  /** dshr 自身版本（底部版本行）。 */
  readonly version?: string
}

/** 右侧信息列的折叠阈值：herdr 的 pane 经常只有 60 列。 */
const SIDEBAR_MIN_COLUMNS = 100

/** 从投影里取上下文用量（键名见 docs/dsh-contract.md 第五之二节）。 */
function contextUsage(
  state: DshrState,
  sessionId: SessionId,
): { tokens?: number; percent?: number } {
  const projections = state.projections(sessionId)
  const pressure = projections.get('contextPressure')
  if (typeof pressure !== 'object' || pressure === null) return {}
  const record = pressure as { pressureTokens?: unknown; projectedTokens?: unknown; contextWindow?: unknown }
  const raw =
    typeof record.pressureTokens === 'number'
      ? record.pressureTokens
      : typeof record.projectedTokens === 'number'
        ? record.projectedTokens
        : undefined
  const window = typeof record.contextWindow === 'number' ? record.contextWindow : undefined
  return {
    ...(raw !== undefined && Number.isFinite(raw) && raw > 0 ? { tokens: raw } : {}),
    ...(raw !== undefined && window !== undefined && window > 0
      ? { percent: Math.min(100, Math.round((raw / window) * 100)) }
      : {}),
  }
}

function abbreviateHome(path: string): string {
  const home = process.env.HOME
  if (home !== undefined && home !== '' && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`
  }
  return path
}

export function SessionApp({
  state,
  client,
  sessionId,
  model,
  provider,
  version,
}: SessionAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => state.subscribe(bump), [state])
  const { exit } = useApp()

  // ── 命令面板（ctrl+p，opencode 实测键位）─────────────────────────────
  // 打开时整区接管会话区（ink 没有浮层，docs/opencode-dialogs.md §四第一节），
  // composer 与底部栏保留。state 镜像进 ref：useInput 回调闭包可能过期。
  const [paletteOpen, setPaletteOpenState] = useState(false)
  const paletteOpenRef = useRef(false)
  const setPaletteOpen = (open: boolean): void => {
    paletteOpenRef.current = open
    setPaletteOpenState(open)
  }
  const registryRef = useRef<CommandRegistry | null>(null)
  if (registryRef.current === null) {
    // 只注册真命令——每条都走现有路径，没有「点了没反应」的条目。
    const registry = createCommandRegistry()
    registry.register({
      name: 'session.interrupt',
      title: 'Interrupt',
      desc: 'Cancel the current turn',
      category: 'Session',
      bindings: ['esc'],
      run: () => void state.cancel(sessionId),
    })
    registry.register({
      name: 'app.exit',
      title: 'Exit the app',
      category: 'System',
      bindings: ['ctrl+c'],
      run: () => exit(),
    })
    registryRef.current = registry
  }
  const registry = registryRef.current
  const { stdout } = useStdout()
  const columns = stdout !== undefined && stdout.columns > 0 ? stdout.columns : 80
  const rows = stdout !== undefined && stdout.rows > 0 ? stdout.rows : 24

  const view = state.conversation(sessionId)
  const summary = state.sessions.get(sessionId)
  const pending = summary?.pending
  const preset = summary?.agentPreset
  const { tokens, percent } = contextUsage(state, sessionId)
  const cwd = summary?.cwd ?? process.cwd()
  const sidebarVisible = columns >= SIDEBAR_MIN_COLUMNS
  const contentWidth = columns - (sidebarVisible ? 42 : 0) - 4

  // 空会话（还没说过话）：中央 logo（opencode Home 的样子）。
  const empty = view.items.every((item) => item.kind !== 'user' && item.kind !== 'assistant')

  // 输入框固定占用：pad 行 + ≥1 输入行 + pad 行 + meta 行 + ╹▀ 行 + 快捷键行。
  const promptRows = 6
  const conversationRows = Math.max(1, rows - promptRows - 1 /* footer */ - 1 /* 保险 */)

  // ctrl+p 开面板。审批/提问在场时不开：PendingPrompt 的 useInput 没有
  // acceptsKey 机制，面板开了它会跟面板抢键（输入被两个处理器同时消费，踩过）。
  useInput((input, key) => {
    if (paletteOpenRef.current) return
    if (key.ctrl && input === 'p' && pending === undefined) setPaletteOpen(true)
  })
  // 面板开着时来了审批/提问：让路，关掉面板。
  const pendingKind = pending?.kind
  useEffect(() => {
    if (pendingKind !== undefined && paletteOpenRef.current) setPaletteOpen(false)
  }, [pendingKind])

  const promptElement =
    pending !== undefined ? (
      <PendingPrompt
        pending={pending}
        onApprove={(outcome) => void state.answerApproval(sessionId, outcome)}
        onAnswer={(answer) => void state.answerQuestion(sessionId, answer)}
        onCancel={() => {
          // state 没有「放弃交互」动词：直接在协议层回错误，host 会广播 resolved。
          void client
            .respond(pending.rpcId, {
              ok: false,
              error: { code: 'cancelled', message: 'dismissed by user', details: {} },
            })
            .catch(() => {})
        }}
      />
    ) : (
      <Composer
        onSubmit={(text) => void state.prompt(sessionId, text)}
        {...(preset !== undefined ? { preset } : {})}
        {...(model !== undefined ? { model } : {})}
        {...(provider !== undefined ? { provider } : {})}
        width={contentWidth}
        working={summary?.status === 'working'}
        onInterrupt={() => void state.cancel(sessionId)}
        // 面板开着时 composer 不能吃键（按键到达那一刻现问，读 ref 不读 state）。
        acceptsKey={() => !paletteOpenRef.current}
      />
    )

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={rows}>
      <Box flexDirection="row" flexGrow={1} minHeight={0}>
        <Box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2}>
          {paletteOpen ? (
            <>
              {/* 对话框整区接管会话区，内部布局逐项照搬 opencode。 */}
              <CommandPalette
                registry={registry}
                onClose={() => setPaletteOpen(false)}
                maxHeight={Math.max(5, conversationRows - 6)}
              />
              <Box flexGrow={1} />
              <Box height={1} flexShrink={0} />
              {promptElement}
            </>
          ) : empty ? (
            // 空会话 = 上游 home 路由：logo + 输入框作为一个整体垂直居中，
            // 输入框不钉底（有对话后才钉底）。
            <Box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
              <Logo />
              <Box height={1} flexShrink={0} />
              {promptElement}
            </Box>
          ) : (
            <>
              <Conversation
                view={view}
                {...(preset !== undefined ? { preset } : {})}
                contentWidth={contentWidth}
                maxRows={conversationRows}
              />
              {/* 对话顶格、输入框钉在底部（上游 scrollbox flexGrow 把 prompt 压到底）；
                  之间留一行空（上游消息区 paddingBottom=1）。 */}
              <Box flexGrow={1} />
              <Box height={1} flexShrink={0} />
              {promptElement}
            </>
          )}
        </Box>
        {sidebarVisible ? (
          <Sidebar
            {...(summary?.title !== undefined ? { title: summary.title } : {})}
            workspace={abbreviateHome(cwd)}
            {...(tokens !== undefined ? { contextTokens: tokens } : {})}
            {...(percent !== undefined ? { contextPercent: percent } : {})}
            {...(version !== undefined ? { version } : {})}
          />
        ) : null}
      </Box>
      <Footer
        cwd={abbreviateHome(cwd)}
        connection={
          client.state.status === 'ready'
            ? 'ready'
            : client.state.status === 'lost'
              ? 'lost'
              : 'connecting'
        }
        {...(pending?.kind === 'approval' ? { pendingApprovals: 1 } : {})}
        {...(model !== undefined ? { model } : {})}
      />
    </Box>
  )
}
