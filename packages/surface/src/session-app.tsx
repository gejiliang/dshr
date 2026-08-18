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
 * D 批：后台任务（jobs）/ 技能列表 / 队列 remove / 图片附件。
 * 数据形状全部来自 docs/gap-shapes.md §八 的实测载荷，不转译。
 */
import type { DshrClient } from '@dshr/protocol'
import {
  checkImageLimits,
  imageLimitsFromProjection,
  readImageDraft,
  type AgentPresetEntry,
  type DshrState,
  type ImageDraft,
  type JobItem,
  type SessionId,
  type SessionListEntry,
  type SessionModels,
  type SettingsOverview,
  type SkillEntry,
} from '@dshr/state'
import {
  CommandPalette,
  Composer,
  Conversation,
  CredentialsDialog,
  DialogPrompt,
  DialogSelect,
  Footer,
  LazyDialogSelect,
  Logo,
  PendingPrompt,
  QueueDock,
  SettingsEditor,
  Sidebar,
  createCommandRegistry,
  modelOptions,
  providerOptions,
  theme,
  type CommandRegistry,
  type DialogSelectOption,
  type SlashCommandEntry,
} from '@dshr/tui'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { useCallback, useEffect, useReducer, useRef, useState, type ReactElement } from 'react'
import type { RemoteSlashCommand, SlashCommandSource } from './slash-commands.js'

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
  /**
   * dsh 斜杠命令表的注入来源（插件路走 typert；`--connect` 路不注入，
   * 此时 `/` 只出 dshr 自己的命令——已决策的取舍，见 slash-commands.ts）。
   */
  readonly slashCommands?: SlashCommandSource
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
  | { readonly kind: 'settings-editor'; readonly data: SettingsOverview }
  | { readonly kind: 'credentials' }
  | { readonly kind: 'providers' }
  | { readonly kind: 'models' }
  | { readonly kind: 'goal-create' }
  // D 批：jobs / queue-remove 的数据从 summary 活读（帧本来就实时推），不带载荷；
  // skills 要 RPC，带上拉取态。
  | { readonly kind: 'jobs' }
  | { readonly kind: 'skills' }
  | { readonly kind: 'queue-remove' }
  | { readonly kind: 'attach-image' }

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

/** `skill.list` 的拉取态：对话框先开，数据后到。 */
type SkillsData = 'loading' | readonly SkillEntry[] | { readonly error: string }

/** 后台任务列表里的一条：label 标题、kind+耗时 muted 说明、status 决定 tone。 */
function jobOption(job: JobItem, now: number): DialogSelectOption {
  const end = job.finishedAt ?? now
  const seconds = Math.max(0, (end - job.startedAt) / 1000)
  const duration = seconds >= 60 ? `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s` : `${seconds.toFixed(1)}s`
  const label = `${job.kind} · ${duration}${job.detail !== undefined ? ` · ${job.detail}` : ''}`
  const tone =
    job.status === 'failed' || job.status === 'killed'
      ? ('error' as const)
      : job.status === 'completed'
        ? ('muted' as const)
        : ('default' as const)
  return { title: job.label, label, tone, value: job.id }
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
  slashCommands: slashSource,
}: SessionAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => state.subscribe(bump), [state])
  const { exit } = useApp()

  // ── 当前会话（切会话/分叉会换）─────────────────────────────────
  const [activeSessionId, setActiveSessionId] = useState<SessionId>(initialSessionId)
  // ⚠️ **也要订阅会话视图本身**，不能只订阅 state。
  //
  // 会话视图的变更（`pushNotice` 这类本地反馈行）只通知会话订阅者，而会话的订阅
  // 原来只发生在 `<Conversation>` 内部——它**只在非空分支挂载**。于是空白会话上
  // 推一条 notice：订阅者一个都没有 → SessionApp 不重绘 → `empty` 不会被重算 →
  // 永远停在 logo，通知看不见。
  //
  // 踩过：斜杠命令在空白会话上返回 undefined，回执推了但屏幕纹丝不动（探针证实
  // 分支确实进了、notify 确实调了）。**通知通道在最需要它的时候不可见，比没有更糟。**
  useEffect(() => state.conversation(activeSessionId).subscribe(bump), [state, activeSessionId])
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

  // ── D 批：待发附件与附件提示（附件问题要一直挂着直到解决，不走 8 秒 transient）──
  const [attachments, setAttachmentsState] = useState<readonly ImageDraft[]>([])
  const attachmentsRef = useRef<readonly ImageDraft[]>([])
  const setAttachments = (next: readonly ImageDraft[]): void => {
    attachmentsRef.current = next
    setAttachmentsState(next)
  }
  const [attachNotice, setAttachNotice] = useState<string | undefined>(undefined)
  const [skillsData, setSkillsData] = useState<SkillsData>('loading')

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
  const loadCredentials = useCallback(() => state.describeCredentials(), [state])
  const loadProviders = useCallback(async () => providerOptions(await state.listProviders()), [state])
  const loadModels = useCallback(async () => modelOptions(await state.listModelCatalog()), [state])

  /** 打开设置编辑器：取全量 describe 再开（取数失败给可读提示）。 */
  const openSettingsEditor = async (): Promise<void> => {
    try {
      const data = await state.describeSettings()
      setDialog({ kind: 'settings-editor', data })
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
    // D 批：后台任务 / 技能 / 队列 remove / 挂图。
    registry.register({
      name: 'session.jobs',
      title: 'View background jobs',
      desc: 'List background jobs of this session',
      category: 'Session',
      run: () => setDialog({ kind: 'jobs' }),
    })
    registry.register({
      name: 'session.skills',
      title: 'View skills',
      desc: 'List the skills available in this project',
      category: 'Session',
      run: () => {
        setDialog({ kind: 'skills' })
        setSkillsData('loading')
        void state
          .listSkills(activeRef.current)
          .then((skills) => setSkillsData(skills))
          .catch((error: unknown) => setSkillsData({ error: errorText(error) }))
      },
    })
    registry.register({
      name: 'session.queue-remove',
      title: 'Remove queued message',
      desc: 'Delete a message waiting in the queue',
      category: 'Session',
      bindings: ['ctrl+x'],
      run: () => setDialog({ kind: 'queue-remove' }),
    })
    registry.register({
      name: 'composer.attach',
      title: 'Attach image',
      desc: 'Attach a local image file to the next message',
      category: 'Composer',
      run: () => setDialog({ kind: 'attach-image' }),
    })
    // E 批：设置 / 凭证 / provider / 部署级模型清单。
    // 设置在 TUI 里改完（docs/gap-shapes.md §十一的起因：openDocument 弹的是
    // **宿主机桌面**的编辑器，SSH 过来的人根本看不见）——TUI 编辑器是默认入口；
    // openDocument 保留给人真的坐在宿主机前的场景，名字说清楚它干什么。
    registry.register({
      name: 'settings.edit',
      title: 'Settings',
      desc: 'View and edit settings in this terminal',
      category: 'Settings',
      run: () => void openSettingsEditor(),
    })
    registry.register({
      name: 'settings.open',
      title: 'Open settings file on the host machine',
      desc: 'Hand the settings document to the desktop editor of the machine running the host',
      category: 'Settings',
      run: async () => {
        try {
          await state.openSettingsDocument()
          notify(state, activeRef.current, 'Settings document handed to the system editor on the host machine.')
        } catch (error) {
          notify(state, activeRef.current, `Open settings failed: ${errorText(error)}`)
        }
      },
    })
    registry.register({
      name: 'credentials.edit',
      title: 'Configure credentials',
      desc: 'Set (masked input) or unset stored credential values',
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

  // ── 斜杠命令：两个来源合并成一个列表 ─────────────────────────
  // `/` 是客户端的活（docs/gap-shapes.md §十一）：`session.prompt` 发 `/help`
  // 只是当普通文本塞给模型（实测，事件流里没有 command/run）。dshr 自己的命令
  // 两条路都有；dsh 的命令表来自注入的来源（没有来源就只显示自己的，不做占位条目）。
  const [remoteSlash, setRemoteSlash] = useState<readonly RemoteSlashCommand[]>([])
  const slashFetchRef = useRef(0)
  const refetchSlash = useCallback((): void => {
    if (slashSource === undefined) return
    const token = ++slashFetchRef.current
    void slashSource.list(activeRef.current).then(
      (list) => {
        if (token === slashFetchRef.current) setRemoteSlash(list)
      },
      () => {
        // 拿不到就只显示 dshr 自己的——不放假按钮（章程）。
        if (token === slashFetchRef.current) setRemoteSlash([])
      },
    )
  }, [slashSource])
  // 初次 + 切会话之后各取一次；`commands/change` 帧（实测抓到过）到了再重取。
  // 别每次打开都无脑重取，也别一次取完再不更新。
  useEffect(() => refetchSlash(), [refetchSlash, activeSessionId])
  useEffect(
    () =>
      state.onRemoteEvent((event) => {
        if (event === 'commands/change') refetchSlash()
      }),
    [state, refetchSlash],
  )

  // 合并列表（每次渲染现算：registry 的 hidden 会跟 goal 相位变，remoteSlash 是 state）。
  const slashEntries: readonly SlashCommandEntry[] = [
    ...registry.list().map((command) => ({
      key: `dshr:${command.name}`,
      name: command.name,
      label: command.title,
      source: 'dshr' as const,
    })),
    ...remoteSlash.map((command) => ({
      key: `dsh:${command.name}`,
      name: command.name,
      ...(command.description !== undefined ? { label: command.description } : {}),
      source: 'dsh' as const,
      ...(command.takesInput === true ? { takesInput: true } : {}),
    })),
  ]
  const slashEntriesRef = useRef(slashEntries)
  slashEntriesRef.current = slashEntries

  const runSlashEntry = (entry: SlashCommandEntry, line: string): void => {
    if (entry.source === 'dshr') {
      registry.dispatch(entry.name)
      return
    }
    if (slashSource === undefined) return
    const id = activeRef.current
    void slashSource.run(id, line).then(
      (receipt) => {
        // 业务失败（CommandExecution.result.kind === 'error'）的回执进会话 notice 行。
        if (receipt !== undefined) {
          notify(state, id, receipt)
          return
        }
        // ⚠️ `undefined` = **这行没被任何命令认领**，绝不能静默吞掉。
        //
        // 实测踩过：**空白会话（还没跑过一轮）上执行任何斜杠命令都返回 undefined**——
        // host 侧 `CommandRuntime.execute` 走 `view(agent).get(name)`，而空白会话
        // 还没有 agent，视图是空的。当时表现就是「回车之后界面上什么都不发生」，
        // 正是我们最想避免的那类「按钮点了没反应」。
        // 跑过一轮之后同一条命令就正常了（实测 `/compact` 返回真实回执）。
        notify(
          state,
          id,
          `/${entry.name} did nothing — slash commands need a started session; send a message first.`,
        )
      },
      (error: unknown) => notify(state, id, `/${entry.name} failed: ${errorText(error)}`),
    )
  }
  const { stdout } = useStdout()
  const columns = stdout !== undefined && stdout.columns > 0 ? stdout.columns : 80
  const rows = stdout !== undefined && stdout.rows > 0 ? stdout.rows : 24

  const view = state.conversation(activeSessionId)
  const summary = state.sessions.get(activeSessionId)
  const pending = summary?.pending
  const preset = summary?.agentPreset
  const queue = summary?.queue ?? []
  const jobs = summary?.jobs ?? []
  const runningJobs = jobs.filter((job) => job.status === 'running').length
  const queueLengthRef = useRef(queue.length)
  queueLengthRef.current = queue.length
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
  // 空状态（画 logo）的判定：**通知与错误也算内容**。
  //
  // ⚠️ 踩过：原来只看 user/assistant，于是在**空白会话**上任何 `pushNotice` 都画不出来——
  // 视图仍被判为空 → 渲染 logo → 通知被顶掉。表现是「回车之后界面上什么都不发生」，
  // 而这正是通知通道存在的意义（斜杠命令在空白会话上返回 undefined 就撞了这个）。
  // 通知channel 在最需要它的时候不可见，比没有更糟。
  const VISIBLE_KINDS = new Set(['user', 'assistant', 'notice', 'error'])
  const empty = view.items.every((item) => !VISIBLE_KINDS.has(item.kind))

  // 输入框固定占用：pad 行 + ≥1 输入行 + pad 行 + meta 行 + ╹▀ 行 + 快捷键行。
  const promptRows = 6
  const conversationRows = Math.max(1, rows - promptRows - 1 /* footer */ - 1 /* 保险 */)

  // ctrl+p 开面板、ctrl+x 开队列管理（队列非空才有意义）。审批/提问在场时不开：
  // PendingPrompt 的 useInput 没有 acceptsKey 机制，开了它会跟对话框抢键（踩过）。
  useInput((input, key) => {
    if (dialogRef.current !== null) return
    if (pending !== undefined) return
    if (key.ctrl && input === 'p') setDialog({ kind: 'palette' })
    if (key.ctrl && input === 'x' && queueLengthRef.current > 0) setDialog({ kind: 'queue-remove' })
  })
  // 面板/对话框开着时来了审批/提问：让路，关掉。
  const pendingKind = pending?.kind
  useEffect(() => {
    if (pendingKind !== undefined && dialogRef.current !== null) setDialog(null)
  }, [pendingKind])

  // ── D 批附件：挂图与提交的自查都在这里，host 报错前就该拒掉 ──────────
  const currentLimits = () => imageLimitsFromProjection(state.projections(activeRef.current).get('imageLimits'))

  const onAttachPath = (raw: string): void => {
    setDialog(null)
    void (async () => {
      try {
        const draft = await readImageDraft(raw)
        const limits = currentLimits()
        if (limits !== undefined) {
          const problem = checkImageLimits([...attachmentsRef.current, draft], limits)
          if (problem !== undefined) {
            setAttachNotice(problem)
            return
          }
        }
        setAttachments([...attachmentsRef.current, draft])
        setAttachNotice(undefined)
      } catch (error) {
        setAttachNotice(errorText(error))
      }
    })()
  }

  const submit = (text: string): void => {
    // `/` 开头先走命令路由：`/` 是客户端的活（docs/gap-shapes.md §十一），
    // 原样发给 host 只会被当成普通文本塞给模型（实测）。
    // 未匹配到任何命令的 `/...` 保持原样发给模型——上游对陌生斜杠行也是如此。
    const slashMatch = /^\/(\S+)/.exec(text)
    if (slashMatch !== null) {
      const entry = slashEntriesRef.current.find((e) => e.name === slashMatch[1])
      if (entry !== undefined) {
        runSlashEntry(entry, text)
        return
      }
    }
    const images = attachmentsRef.current
    const limits = currentLimits()
    // 提交前最后一道自查：限额投影存在就拦，不存在（没装附件服务）才放行让 host 回答。
    if (images.length > 0 && limits !== undefined) {
      const problem = checkImageLimits(images, limits)
      if (problem !== undefined) {
        setAttachNotice(problem)
        return
      }
    }
    setAttachNotice(undefined)
    setAttachments([])
    void state.prompt(activeRef.current, text, images)
  }

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
        onSubmit={submit}
        {...(preset !== undefined ? { preset } : {})}
        {...(model !== undefined ? { model } : {})}
        {...(provider !== undefined ? { provider } : {})}
        planModeSeen={summary?.planModeSeen === true}
        width={contentWidth}
        working={summary?.status === 'working'}
        onInterrupt={() => void state.cancel(activeSessionId)}
        onCyclePreset={() => void cyclePreset()}
        attachments={attachments.map((draft) => ({ name: draft.name, bytes: draft.bytes }))}
        onClearAttachments={() => setAttachments([])}
        {...(attachNotice !== undefined ? { notice: attachNotice } : {})}
        slashCommands={slashEntries}
        onSlashCommand={(entry) => runSlashEntry(entry, `/${entry.name}`)}
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
      // ── E 批：设置编辑器 / 凭证对话框 / 懒加载只读对话框 / goal-create ──
      case 'settings-editor':
        return (
          <SettingsEditor
            overview={dialog.data}
            onMutate={(ns, ops, expectedRevision) => state.mutateSetting(ns, ops, expectedRevision)}
            onClose={close}
            maxHeight={maxHeight}
          />
        )
      case 'credentials':
        return (
          <CredentialsDialog
            load={loadCredentials}
            onSet={(ref, value) => state.setCredential(ref, value)}
            onUnset={(ref) => state.unsetCredential(ref)}
            onClose={close}
            maxHeight={maxHeight}
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
      // ── D 批 ─────────────────────────────────────────────────
      case 'jobs':
        // 只展示——杀后台任务是模型的 `job_kill` 工具，dshr 不造这个 RPC。
        return (
          <DialogSelect
            title="Background jobs"
            options={jobs.map((job) => jobOption(job, Date.now()))}
            maxHeight={maxHeight}
            onSelect={close}
            onCancel={close}
          />
        )
      case 'skills': {
        const skillsOptions: DialogSelectOption[] =
          skillsData === 'loading'
            ? [{ title: 'Loading…', tone: 'muted', value: '__loading' }]
            : typeof skillsData === 'object' && 'error' in skillsData
              ? [{ title: skillsData.error, tone: 'error', value: '__error' }]
              : skillsData.map((skill) => ({
                  title: skill.name,
                  label: skill.description,
                  value: skill.name,
                }))
        return (
          <DialogSelect
            title="Skills"
            options={skillsOptions}
            maxHeight={maxHeight}
            onSelect={close}
            onCancel={close}
          />
        )
      }
      case 'queue-remove':
        // 选中即删（session.updateQueue 的 remove），对话框不关：队列是活快照，
        // 删完能看到它缩；空了就剩 No results found，esc 收工。
        return (
          <DialogSelect
            title="Remove queued message"
            options={queue.map((item) => ({ title: item.text.replaceAll('\n', ' '), value: item.id }))}
            maxHeight={maxHeight}
            onSelect={(itemId) => {
              void state.removeQueuedMessage(activeRef.current, itemId).catch((error: unknown) => {
                setAttachNotice(errorText(error))
              })
            }}
            onCancel={close}
          />
        )
      case 'attach-image':
        return (
          <DialogPrompt
            title="Attach image"
            placeholder="Path to a local image file (png / jpeg / webp / gif)"
            onSubmit={onAttachPath}
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
        {...(runningJobs > 0 ? { runningJobs } : {})}
        {...(model !== undefined ? { model } : {})}
      />
    </Box>
  )
}
