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
 *
 * C 批：切模型 / 切预设（tab 就地循环 + 面板项）/ 切会话 / 重命名 / 分叉。
 * E 批：设置 / 凭证 / provider / 部署级模型清单 / 目标动词。
 * 数据形状全部来自 docs/gap-shapes.md §八 的实测载荷，不转译。
 */
import type { DshrClient } from '@dshr/protocol'
import type {
  AgentPresetEntry,
  DshrState,
  SessionId,
  SessionListEntry,
  SessionModels,
} from '@dshr/state'
import {
  CommandPalette,
  Composer,
  Conversation,
  DialogPrompt,
  DialogSelect,
  Footer,
  LazyDialogSelect,
  Logo,
  PendingPrompt,
  QueueDock,
  Sidebar,
  createCommandRegistry,
  credentialOptions,
  modelOptions,
  providerOptions,
  settingsOptions,
  theme,
  type CommandRegistry,
  type DialogSelectOption,
} from '@dshr/tui'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
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
  /** 切会话/分叉之后通知外层（herdr 上报要跟着换 sessionId）。 */
  readonly onSessionChange?: (sessionId: SessionId) => void
}

/** 右侧信息列的折叠阈值：herdr 的 pane 经常只有 60 列。 */
const SIDEBAR_MIN_COLUMNS = 100

/**
 * 打开的对话框；空 = 没有。对话框整区接管会话区（ink 没有浮层，见 docs/opencode-dialogs.md §四）。
 * C 批的是带载荷的（取完数再开）；E 批的是「取数→展示」懒加载型，不需要 payload。
 */
type DialogState =
  | { readonly kind: 'palette' }
  | { readonly kind: 'model'; readonly data: SessionModels }
  | { readonly kind: 'preset'; readonly presets: readonly AgentPresetEntry[] }
  | { readonly kind: 'sessions'; readonly items: readonly SessionListEntry[] }
  | { readonly kind: 'rename'; readonly sessionId: SessionId; readonly initial: string }
  | { readonly kind: 'settings' }
  | { readonly kind: 'credentials' }
  | { readonly kind: 'providers' }
  | { readonly kind: 'models' }
  | { readonly kind: 'goal-create' }

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * E 批动词的回执：进会话视图的 notice 行（durable、跟着会话走）。
 * 与 C 批的 showNotice（8 秒 transient 警告条）是两个面——goal 的成败是
 * 会话历史的一部分（CAS 冲突、phase 竞态），不该 8 秒后消失。
 */
function notify(state: DshrState, sessionId: SessionId, text: string): void {
  state.conversation(sessionId).pushNotice(text)
}

/** goal 动词成功后的回执用词。 */
const GOAL_DONE: Record<'pause' | 'resume' | 'complete' | 'clear', string> = {
  pause: 'paused',
  resume: 'resumed',
  complete: 'completed',
  clear: 'cleared',
}

/** 模型对话框条目的 value：`[provider, model]` 的 JSON（id 里可能带 `/`，别拼字符串）。 */
function modelValue(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

function parseModelValue(value: string): { provider: string; model: string } | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { provider: parsed[0], model: parsed[1] }
    }
  } catch {
    // 非法 value 当作没有
  }
  return undefined
}

/**
 * 会话级模型目录（`session.models`）→ DialogSelect 条目
 * （同构映射：groups→category、name→标题、current→●）。
 * ⚠️ 与 `@dshr/tui` 的 `modelOptions`（`llm.models`，**部署级**清单）是两个东西，别合。
 */
function sessionModelOptions(data: SessionModels): DialogSelectOption[] {
  const out: DialogSelectOption[] = []
  for (const group of data.groups) {
    for (const model of group.models) {
      out.push({
        title: model.name,
        // opencode：`deepseek-v4-flash Newapi (quota-proxy)`——标题后跟 muted 的 provider 名。
        label: group.name,
        category: group.name,
        current: data.current.provider === group.id && data.current.model === model.id,
        value: modelValue(group.id, model.id),
      })
    }
  }
  return out
}

/** 预设名册 → DialogSelect 条目（name 作标题、description 作 muted 说明、当前项 ●）。 */
function presetOptions(presets: readonly AgentPresetEntry[], current: string | undefined): DialogSelectOption[] {
  return presets.map((preset) => ({
    title: preset.name ?? preset.id,
    ...(preset.description !== undefined ? { label: preset.description } : {}),
    current: preset.id === current,
    value: preset.id,
  }))
}

/** 会话列表 → DialogSelect 条目（按 updatedAt 降序，上游 session.list 的顺序）。 */
function sessionOptions(items: readonly SessionListEntry[], activeId: SessionId): DialogSelectOption[] {
  return items.map((item) => ({
    title: item.title ?? (item.blank ? 'New session' : String(item.sessionId)),
    ...(item.cwd !== undefined ? { label: abbreviateHome(item.cwd) } : {}),
    current: item.sessionId === activeId,
    value: String(item.sessionId),
  }))
}

export function SessionApp({
  state,
  client,
  sessionId: initialSessionId,
  model: hostModel,
  provider: hostProvider,
  version,
  onSessionChange,
}: SessionAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => state.subscribe(bump), [state])
  const { exit } = useApp()

  // ── 当前会话（切会话/分叉会换）─────────────────────────────────
  const [activeSessionId, setActiveSessionId] = useState<SessionId>(initialSessionId)
  const activeRef = useRef(activeSessionId)
  const switchSession = (id: SessionId): void => {
    if (id === activeRef.current) return
    activeRef.current = id
    setActiveSessionId(id)
    onSessionChange?.(id)
  }

  // ── 对话框（ctrl+p 面板 / 模型 / 预设 / 会话 / 重命名 / E 批懒加载型）───
  // state 镜像进 ref：useInput 回调闭包可能过期，按键到达那一刻现问。
  const [dialog, setDialogState] = useState<DialogState | null>(null)
  const dialogRef = useRef<DialogState | null>(null)
  const setDialog = (next: DialogState | null): void => {
    dialogRef.current = next
    setDialogState(next)
  }

  // ── 一次性提示（fork-unavailable 这类可读错误）────────────────
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showNotice = (text: string): void => {
    setNotice(text)
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 8_000)
  }

  // ── C 批动词 ─────────────────────────────────────────────────
  const openModelDialog = async (): Promise<void> => {
    try {
      const data = await state.listModels(activeRef.current)
      setDialog({ kind: 'model', data })
    } catch (error) {
      showNotice(errorText(error))
    }
  }

  const openPresetDialog = async (): Promise<void> => {
    try {
      const presets = await state.listPresets()
      if (presets.length === 0) {
        showNotice('this deployment composes no agent presets')
        return
      }
      setDialog({ kind: 'preset', presets })
    } catch (error) {
      showNotice(errorText(error))
    }
  }

  const openSessionsDialog = async (): Promise<void> => {
    try {
      const items = await state.listSessions()
      setDialog({ kind: 'sessions', items })
    } catch (error) {
      showNotice(errorText(error))
    }
  }

  const forkSession = async (): Promise<void> => {
    const from = activeRef.current
    try {
      const forked = await state.forkSession(from)
      switchSession(forked)
      showNotice(`forked → ${String(forked)}`)
    } catch (error) {
      // 没有已完成轮时 host 回 fork-unavailable——如实显示，不静默失败。
      showNotice(errorText(error))
    }
  }

  /** tab 就地循环预设（opencode 实测行为）；非 blank 会话会被 host 拒，提示出来。 */
  const cyclePreset = async (): Promise<void> => {
    const id = activeRef.current
    try {
      const presets = await state.listPresets()
      if (presets.length === 0) return
      const first = presets[0]
      if (first === undefined) return
      const current =
        state.sessions.get(id)?.agentPreset ?? presets.find((p) => p.isDefault)?.id ?? first.id
      const index = presets.findIndex((p) => p.id === current)
      const next = presets[(index + 1) % presets.length]
      if (next === undefined || next.id === current) return
      await state.selectPreset(id, next.id)
    } catch (error) {
      showNotice(errorText(error))
    }
  }

  // ── E 批：只读对话框的取数函数（引用必须稳定——LazyDialogSelect 的
  //    useEffect 依赖它，变了就重取）──────────────────────────────
  const loadSettings = useCallback(async () => settingsOptions(await state.describeSettings()), [state])
  const loadCredentials = useCallback(
    async () => credentialOptions(await state.describeCredentials()),
    [state],
  )
  const loadProviders = useCallback(async () => providerOptions(await state.listProviders()), [state])
  const loadModels = useCallback(async () => modelOptions(await state.listModelCatalog()), [state])

  // ── 命令注册表（只注册真命令——每条都走通了的路径）──────────────
  const registryRef = useRef<CommandRegistry | null>(null)
  if (registryRef.current === null) {
    const registry = createCommandRegistry()
    registry.register({
      name: 'model.switch',
      title: 'Switch model',
      desc: 'Change the model for this session',
      // opencode 实测：Switch model 在 Suggested 分组（未输入时才有，一过滤就消失）。
      suggested: true,
      run: () => void openModelDialog(),
    })
    registry.register({
      name: 'session.switch',
      title: 'Switch session',
      desc: 'Open another session in this pane',
      category: 'Session',
      run: () => void openSessionsDialog(),
    })
    registry.register({
      name: 'preset.switch',
      title: 'Switch agent preset',
      desc: 'Blank sessions only (host locks it after the first turn)',
      category: 'Session',
      run: () => void openPresetDialog(),
    })
    registry.register({
      name: 'session.fork',
      title: 'Fork session',
      desc: 'Branch off from the last completed turn',
      category: 'Session',
      run: () => void forkSession(),
    })
    registry.register({
      name: 'session.interrupt',
      title: 'Interrupt',
      desc: 'Cancel the current turn',
      category: 'Session',
      bindings: ['esc'],
      run: () => void state.cancel(activeRef.current),
    })
    // E 批：设置 / 凭证 / provider / 部署级模型清单。设计取向是「打开文档」而不是
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
          notify(state, activeRef.current, 'Settings document handed to the system editor.')
        } catch (error) {
          notify(state, activeRef.current, `Open settings failed: ${errorText(error)}`)
        }
      },
    })
    registry.register({
      name: 'settings.view',
      title: 'View settings',
      desc: 'Read-only overview of settings namespaces',
      category: 'Settings',
      run: () => setDialog({ kind: 'settings' }),
    })
    registry.register({
      name: 'credentials.view',
      title: 'Configure credentials',
      desc: 'Which credentials are configured; values live in the settings document',
      category: 'Settings',
      run: () => setDialog({ kind: 'credentials' }),
    })
    registry.register({
      name: 'llm.providers',
      title: 'View providers',
      desc: 'Configurable provider directory (read-only)',
      category: 'Model',
      run: () => setDialog({ kind: 'providers' }),
    })
    registry.register({
      name: 'llm.models',
      title: 'View models',
      desc: 'Host-wide model catalog (read-only)',
      category: 'Model',
      run: () => setDialog({ kind: 'models' }),
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
  const goal = state.goalOf(activeSessionId)
  const goalId = goal?.id
  const goalPhase = goal?.phase
  useEffect(() => {
    const hasGoal = goalId !== undefined && goalPhase !== undefined
    const verb = (kind: 'pause' | 'resume' | 'complete' | 'clear') => async (): Promise<void> => {
      const call = { pause: state.pauseGoal, resume: state.resumeGoal, complete: state.completeGoal, clear: state.clearGoal }[kind]
      const id = activeRef.current
      try {
        await call.call(state, id)
        notify(state, id, `Goal ${GOAL_DONE[kind]}.`)
      } catch (error) {
        notify(state, id, `Goal ${kind} failed: ${errorText(error)}`)
      }
    }
    registry.register({
      name: 'goal.create',
      title: 'Create goal',
      desc: 'Arm a goal with an objective',
      category: 'Goal',
      hidden: hasGoal,
      run: () => setDialog({ kind: 'goal-create' }),
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
  }, [state, activeSessionId, registry, goalId, goalPhase])
  const { stdout } = useStdout()
  const columns = stdout !== undefined && stdout.columns > 0 ? stdout.columns : 80
  const rows = stdout !== undefined && stdout.rows > 0 ? stdout.rows : 24

  const view = state.conversation(activeSessionId)
  const summary = state.sessions.get(activeSessionId)
  const pending = summary?.pending
  const preset = summary?.agentPreset
  const queue = summary?.queue ?? []
  // 会话自己选过模型（listModels/selectModel 播种）就以它为准，否则用部署默认。
  const model = summary?.model ?? hostModel
  const provider = summary?.provider ?? hostProvider
  // ⚠️ 用 activeSessionId 而不是入参 sessionId——C 批之后会话是可以换的。
  const { tokens, percent } = contextUsage(state, activeSessionId)
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
    if (dialogRef.current !== null) return
    if (key.ctrl && input === 'p' && pending === undefined) setDialog({ kind: 'palette' })
  })
  // 面板/对话框开着时来了审批/提问：让路，关掉。
  const pendingKind = pending?.kind
  useEffect(() => {
    if (pendingKind !== undefined && dialogRef.current !== null) setDialog(null)
  }, [pendingKind])

  const noticeElement =
    notice !== null ? (
      <Box flexShrink={0}>
        <Text color={theme.warning}>⚠ </Text>
        <Text color={theme.text}>{notice}</Text>
      </Box>
    ) : null

  const promptElement =
    pending !== undefined ? (
      <PendingPrompt
        pending={pending}
        onApprove={(outcome) => void state.answerApproval(activeSessionId, outcome)}
        onAnswer={(answer) => void state.answerQuestion(activeSessionId, answer)}
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
        onSubmit={(text) => void state.prompt(activeSessionId, text)}
        {...(preset !== undefined ? { preset } : {})}
        {...(model !== undefined ? { model } : {})}
        {...(provider !== undefined ? { provider } : {})}
        planModeSeen={summary?.planModeSeen === true}
        width={contentWidth}
        working={summary?.status === 'working'}
        onInterrupt={() => void state.cancel(activeSessionId)}
        onCyclePreset={() => void cyclePreset()}
        // 对话框开着时 composer 不能吃键（按键到达那一刻现问，读 ref 不读 state）。
        acceptsKey={() => dialogRef.current === null}
      />
    )

  /** 当前对话框的内容元素（null = 没开）。 */
  const dialogElement = (() => {
    if (dialog === null) return null
    const close = (): void => setDialog(null)
    const maxHeight = Math.max(5, conversationRows - 6)
    switch (dialog.kind) {
      case 'palette':
        return (
          <CommandPalette
            registry={registry}
            onClose={close}
            maxHeight={maxHeight}
          />
        )
      case 'model':
        return (
          <DialogSelect
            title="Select model"
            options={sessionModelOptions(dialog.data)}
            maxHeight={maxHeight}
            onSelect={(value) => {
              close()
              const selection = parseModelValue(value)
              if (selection === undefined) return
              state
                .selectModel(activeRef.current, selection.provider, selection.model)
                .catch((error: unknown) => showNotice(errorText(error)))
            }}
            onCancel={close}
          />
        )
      case 'preset': {
        const current =
          summary?.agentPreset ?? dialog.presets.find((p) => p.isDefault)?.id
        return (
          <DialogSelect
            title="Select agent preset"
            options={presetOptions(dialog.presets, current)}
            maxHeight={maxHeight}
            onSelect={(value) => {
              close()
              state
                .selectPreset(activeRef.current, value)
                .catch((error: unknown) => showNotice(errorText(error)))
            }}
            onCancel={close}
          />
        )
      }
      case 'sessions':
        return (
          <DialogSelect
            title="Sessions"
            options={sessionOptions(dialog.items, activeSessionId)}
            // search 是增强：有就用来过滤，部署关掉时（openAt "never"）state 返回
            // undefined，DialogSelect 退回本地过滤——没有它也照样能用。
            remoteSearch={(query) =>
              state.searchSessions(query).then((ids) => ids?.map(String))
            }
            maxHeight={maxHeight}
            // dsh 没有 pin 这个概念，不造；delete 归 herdr。底部动作条只有 rename。
            actions={[
              {
                label: 'rename',
                key: 'ctrl+r',
                onTrigger: (value) => {
                  if (value === undefined) return
                  const item = dialog.items.find((i) => String(i.sessionId) === value)
                  setDialog({
                    kind: 'rename',
                    sessionId: value as SessionId,
                    initial: item?.title ?? '',
                  })
                },
              },
            ]}
            onSelect={(value) => {
              close()
              switchSession(value as SessionId)
            }}
            onCancel={close}
          />
        )
      case 'rename':
        return (
          <DialogPrompt
            title="Rename session"
            initial={dialog.initial}
            placeholder="New title"
            onSubmit={(title) => {
              close()
              state
                .renameSession(dialog.sessionId, title)
                .catch((error: unknown) => showNotice(errorText(error)))
            }}
            onCancel={close}
          />
        )
      // ── E 批：懒加载只读对话框 + goal-create 输入框 ─────────────
      case 'settings':
        return (
          <LazyDialogSelect
            title="Settings"
            load={loadSettings}
            onClose={close}
            maxHeight={maxHeight}
            note="Read-only view · edit in your editor with the “Open settings” command"
          />
        )
      case 'credentials':
        return (
          <LazyDialogSelect
            title="Credentials"
            load={loadCredentials}
            onClose={close}
            maxHeight={maxHeight}
            note="Values never leave the host · set them in the settings document (“Open settings”)"
          />
        )
      case 'providers':
        return (
          <LazyDialogSelect
            title="Providers"
            load={loadProviders}
            onClose={close}
            maxHeight={maxHeight}
          />
        )
      case 'models':
        return (
          <LazyDialogSelect
            title="Models"
            load={loadModels}
            onClose={close}
            maxHeight={maxHeight}
          />
        )
      case 'goal-create':
        return (
          <DialogPrompt
            title="Create goal"
            placeholder="Objective"
            onSubmit={(objective) => {
              close()
              const id = activeRef.current
              state.createGoal(id, objective).then(
                () => notify(state, id, 'Goal created.'),
                (error: unknown) => notify(state, id, `Goal create failed: ${errorText(error)}`),
              )
            }}
            onCancel={close}
          />
        )
    }
  })()

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={rows}>
      <Box flexDirection="row" flexGrow={1} minHeight={0}>
        <Box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2}>
          {dialogElement !== null ? (
            <>
              {/* 对话框整区接管会话区，内部布局逐项照搬 opencode。 */}
              {dialogElement}
              <Box flexGrow={1} />
              {noticeElement}
              <Box height={1} flexShrink={0} />
              {promptElement}
            </>
          ) : empty ? (
            // 空会话 = 上游 home 路由：logo + 输入框作为一个整体垂直居中，
            // 输入框不钉底（有对话后才钉底）。
            <Box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
              <Logo />
              {noticeElement}
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
                  之间留一行空（上游消息区 paddingBottom=1）。
                  排队消息徽章钉在输入框正上方（opencode 的 QueueDock 位置）。 */}
              <Box flexGrow={1} />
              {noticeElement}
              <Box height={1} flexShrink={0} />
              {queue.length > 0 ? <QueueDock items={queue} /> : null}
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
