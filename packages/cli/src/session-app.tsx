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
  Logo,
  PendingPrompt,
  QueueDock,
  Sidebar,
  createCommandRegistry,
  theme,
  type CommandRegistry,
  type DialogSelectOption,
} from '@dshr/tui'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
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
  /** 切会话/分叉之后通知外层（herdr 上报要跟着换 sessionId）。 */
  readonly onSessionChange?: (sessionId: SessionId) => void
}

/** 右侧信息列的折叠阈值：herdr 的 pane 经常只有 60 列。 */
const SIDEBAR_MIN_COLUMNS = 100

/** 打开的对话框；空 = 没有。对话框整区接管会话区（ink 没有浮层，见 docs/opencode-dialogs.md §四）。 */
type DialogState =
  | { readonly kind: 'palette' }
  | { readonly kind: 'model'; readonly data: SessionModels }
  | { readonly kind: 'preset'; readonly presets: readonly AgentPresetEntry[] }
  | { readonly kind: 'sessions'; readonly items: readonly SessionListEntry[] }
  | { readonly kind: 'rename'; readonly sessionId: SessionId; readonly initial: string }

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

/** 模型目录 → DialogSelect 条目（同构映射：groups→category、name→标题、current→●）。 */
function modelOptions(data: SessionModels): DialogSelectOption[] {
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

  // ── 对话框（ctrl+p 面板 / 模型 / 预设 / 会话 / 重命名）───────────
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
  /**
   * 会话列的**列宽**（含左右 padding 2）。
   *
   * ⚠️ 必须钉死，不能只给 `flexGrow={1}`。踩过：一条很长又不好折行的正文
   * （比如整段没有换行的助手输出）会让 yoga 按内容的固有宽度把这一列撑开，
   * 超过它应得的份额，**把右侧信息列整个挤出屏幕右缘**——现象是侧栏凭空消失、
   * 正文按满宽折行。侧栏自己的 `flexShrink={0}` 挡不住这个，因为问题出在兄弟节点撑大。
   * 复现：150×45 下连发十轮，每轮回一段长正文。
   */
  const contentColumnWidth = columns - (sidebarVisible ? 42 : 0)
  const contentWidth = contentColumnWidth - 4

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
  // 面板开着时来了审批/提问：让路，关掉面板。
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
    switch (dialog.kind) {
      case 'palette':
        return (
          <CommandPalette
            registry={registry}
            onClose={close}
            maxHeight={Math.max(5, conversationRows - 6)}
          />
        )
      case 'model':
        return (
          <DialogSelect
            title="Select model"
            options={modelOptions(dialog.data)}
            maxHeight={Math.max(5, conversationRows - 6)}
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
            maxHeight={Math.max(5, conversationRows - 6)}
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
            maxHeight={Math.max(5, conversationRows - 6)}
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
    }
  })()

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={rows}>
      <Box flexDirection="row" flexGrow={1} minHeight={0}>
        <Box
          flexDirection="column"
          width={contentColumnWidth}
          flexShrink={0}
          paddingLeft={2}
          paddingRight={2}
        >
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
