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
  LazyDialogSelect,
  Logo,
  PendingPrompt,
  Sidebar,
  TextPromptDialog,
  createCommandRegistry,
  credentialOptions,
  modelOptions,
  providerOptions,
  settingsOptions,
  type CommandRegistry,
} from '@dshr/tui'
import { Box, useApp, useInput, useStdout } from 'ink'
import { useCallback, useEffect, useReducer, useRef, useState, type ReactElement } from 'react'

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

/** 命令动词的成败回执：进会话视图的 notice 行（dispatch 吞 rejection，没有它就是静默失败）。 */
function notify(state: DshrState, sessionId: SessionId, text: string): void {
  state.conversation(sessionId).pushNotice(text)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 占据会话区的东西：命令面板或某个对话框（ink 没有浮层，见 docs/opencode-dialogs.md §四）。 */
type OverlayKind = 'palette' | 'settings' | 'credentials' | 'providers' | 'models' | 'goal-create'

/** goal 动词成功后的回执用词。 */
const GOAL_DONE: Record<'pause' | 'resume' | 'complete' | 'clear', string> = {
  pause: 'paused',
  resume: 'resumed',
  complete: 'completed',
  clear: 'cleared',
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

  // ── 命令面板与对话框（ctrl+p，opencode 实测键位）────────────────────────
  // 打开时整区接管会话区（ink 没有浮层，docs/opencode-dialogs.md §四第一节），
  // composer 与底部栏保留。state 镜像进 ref：useInput 回调闭包可能过期。
  const [overlay, setOverlayState] = useState<OverlayKind | null>(null)
  const overlayRef = useRef<OverlayKind | null>(null)
  const setOverlay = (next: OverlayKind | null): void => {
    overlayRef.current = next
    setOverlayState(next)
  }
  // 只读对话框的取数函数：引用必须稳定（LazyDialogSelect 的 useEffect 依赖它）。
  const loadSettings = useCallback(async () => settingsOptions(await state.describeSettings()), [state])
  const loadCredentials = useCallback(
    async () => credentialOptions(await state.describeCredentials()),
    [state],
  )
  const loadProviders = useCallback(async () => providerOptions(await state.listProviders()), [state])
  const loadModels = useCallback(async () => modelOptions(await state.listModels()), [state])
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
    // E 批：设置 / 凭证 / provider / 模型清单。设计取向是「打开文档」而不是
    // 在 TUI 里做配置编辑器——上游自带 openDocument 就是这个意图。
    // settings.update/replace/mutate 与 credentials.set/unset 会写真实 ~/.dsh，
    // state 层故意不包它们，这里自然也没有入口。
    registry.register({
      name: 'settings.open',
      title: 'Open settings',
      desc: 'Edit the settings document in your editor',
      category: 'Settings',
      run: async () => {
        try {
          await state.openSettingsDocument()
          notify(state, sessionId, 'Settings document handed to the system editor.')
        } catch (error) {
          notify(state, sessionId, `Open settings failed: ${errorMessage(error)}`)
        }
      },
    })
    registry.register({
      name: 'settings.view',
      title: 'View settings',
      desc: 'Read-only overview of settings namespaces',
      category: 'Settings',
      run: () => setOverlay('settings'),
    })
    registry.register({
      name: 'credentials.view',
      title: 'Configure credentials',
      desc: 'Which credentials are configured; values live in the settings document',
      category: 'Settings',
      run: () => setOverlay('credentials'),
    })
    registry.register({
      name: 'llm.providers',
      title: 'View providers',
      desc: 'Configurable provider directory (read-only)',
      category: 'Model',
      run: () => setOverlay('providers'),
    })
    registry.register({
      name: 'llm.models',
      title: 'View models',
      desc: 'Host-wide model catalog (read-only)',
      category: 'Model',
      run: () => setOverlay('models'),
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

  // goal 动词：没有目标时**隐藏**（章程：不许静默失败也不许假按钮）。
  // ref 在派发那一刻现读（revision 会被模型的自动轮次推进，存旧 ref 必撞
  // GOAL_STALE_REVISION——实测，见 packages/state/src/goal.ts）。
  const goal = state.goalOf(sessionId)
  const goalId = goal?.id
  const goalPhase = goal?.phase
  useEffect(() => {
    const hasGoal = goalId !== undefined && goalPhase !== undefined
    const verb = (kind: 'pause' | 'resume' | 'complete' | 'clear') => async (): Promise<void> => {
      const call = { pause: state.pauseGoal, resume: state.resumeGoal, complete: state.completeGoal, clear: state.clearGoal }[kind]
      try {
        await call.call(state, sessionId)
        notify(state, sessionId, `Goal ${GOAL_DONE[kind]}.`)
      } catch (error) {
        notify(state, sessionId, `Goal ${kind} failed: ${errorMessage(error)}`)
      }
    }
    registry.register({
      name: 'goal.create',
      title: 'Create goal',
      desc: 'Arm a goal with an objective',
      category: 'Goal',
      hidden: hasGoal,
      run: () => setOverlay('goal-create'),
    })
    registry.register({
      name: 'goal.pause',
      title: 'Pause goal',
      desc: 'Disarm automatic continuation',
      category: 'Goal',
      hidden: goalPhase !== 'active',
      run: () => void verb('pause')(),
    })
    registry.register({
      name: 'goal.resume',
      title: 'Resume goal',
      desc: 'Re-arm a paused or blocked goal',
      category: 'Goal',
      hidden: goalPhase !== 'paused' && goalPhase !== 'blocked',
      run: () => void verb('resume')(),
    })
    registry.register({
      name: 'goal.complete',
      title: 'Complete goal',
      desc: 'Mark the current goal complete',
      category: 'Goal',
      hidden: !hasGoal || goalPhase === 'complete',
      run: () => void verb('complete')(),
    })
    registry.register({
      name: 'goal.clear',
      title: 'Clear goal',
      desc: 'Drop the current goal (tombstone is kept)',
      category: 'Goal',
      hidden: !hasGoal,
      run: () => void verb('clear')(),
    })
  }, [state, sessionId, registry, goalId, goalPhase])
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
    if (overlayRef.current !== null) return
    if (key.ctrl && input === 'p' && pending === undefined) setOverlay('palette')
  })
  // 面板/对话框开着时来了审批/提问：让路，关掉。
  const pendingKind = pending?.kind
  useEffect(() => {
    if (pendingKind !== undefined && overlayRef.current !== null) setOverlay(null)
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
        // 面板/对话框开着时 composer 不能吃键（按键到达那一刻现问，读 ref 不读 state）。
        acceptsKey={() => overlayRef.current === null}
      />
    )

  const dialogMaxHeight = Math.max(5, conversationRows - 6)
  const closeOverlay = (): void => setOverlay(null)
  const overlayElement =
    overlay === 'palette' ? (
      <CommandPalette registry={registry} onClose={closeOverlay} maxHeight={dialogMaxHeight} />
    ) : overlay === 'settings' ? (
      <LazyDialogSelect
        title="Settings"
        load={loadSettings}
        onClose={closeOverlay}
        maxHeight={dialogMaxHeight}
        note="Read-only view · edit in your editor with the “Open settings” command"
      />
    ) : overlay === 'credentials' ? (
      <LazyDialogSelect
        title="Credentials"
        load={loadCredentials}
        onClose={closeOverlay}
        maxHeight={dialogMaxHeight}
        note="Values never leave the host · set them in the settings document (“Open settings”)"
      />
    ) : overlay === 'providers' ? (
      <LazyDialogSelect
        title="Providers"
        load={loadProviders}
        onClose={closeOverlay}
        maxHeight={dialogMaxHeight}
      />
    ) : overlay === 'models' ? (
      <LazyDialogSelect
        title="Models"
        load={loadModels}
        onClose={closeOverlay}
        maxHeight={dialogMaxHeight}
      />
    ) : overlay === 'goal-create' ? (
      <TextPromptDialog
        title="Create goal"
        placeholder="Objective"
        hint="enter to create and arm · esc to cancel"
        onSubmit={(objective) => {
          closeOverlay()
          state.createGoal(sessionId, objective).then(
            () => notify(state, sessionId, 'Goal created.'),
            (error: unknown) => notify(state, sessionId, `Goal create failed: ${errorMessage(error)}`),
          )
        }}
        onCancel={closeOverlay}
      />
    ) : null

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={rows}>
      <Box flexDirection="row" flexGrow={1} minHeight={0}>
        <Box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2}>
          {overlayElement !== null ? (
            <>
              {/* 对话框整区接管会话区，内部布局逐项照搬 opencode。 */}
              {overlayElement}
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
            {...(goal !== undefined
              ? {
                  goal: {
                    objective: goal.objective,
                    phase: goal.phase,
                    ...(goal.blockedReason !== undefined
                      ? { blockedReason: goal.blockedReason }
                      : {}),
                    roundsStarted: goal.roundsStarted,
                    maxGoalRounds: goal.maxGoalRounds,
                  },
                }
              : {})}
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
