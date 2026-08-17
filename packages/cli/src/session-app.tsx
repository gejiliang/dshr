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
import {
  checkImageLimits,
  imageLimitsFromProjection,
  readImageDraft,
  type DshrState,
  type ImageDraft,
  type JobItem,
  type SessionId,
  type SkillEntry,
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
  type CommandRegistry,
  type DialogSelectOption,
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

/** 会话区被哪个对话框接管（ink 没有浮层，对话框整区接管，docs/opencode-dialogs.md §四）。 */
type Overlay = 'palette' | 'jobs' | 'skills' | 'queue' | 'attach'

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

  // ── 覆盖层（ctrl+p 面板 / jobs / skills / 队列 / 挂图）─────────────────
  // 打开时整区接管会话区（ink 没有浮层，docs/opencode-dialogs.md §四第一节），
  // composer 与底部栏保留。state 镜像进 ref：useInput 回调闭包可能过期。
  const [overlay, setOverlayState] = useState<Overlay | null>(null)
  const overlayRef = useRef<Overlay | null>(null)
  const setOverlay = (next: Overlay | null): void => {
    overlayRef.current = next
    setOverlayState(next)
  }
  // 待发附件与提示条（notice）：提交前自查不过就把理由摆在这里，不发出去。
  const [attachments, setAttachmentsState] = useState<readonly ImageDraft[]>([])
  const attachmentsRef = useRef<readonly ImageDraft[]>([])
  const setAttachments = (next: readonly ImageDraft[]): void => {
    attachmentsRef.current = next
    setAttachmentsState(next)
  }
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [skillsData, setSkillsData] = useState<SkillsData>('loading')

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
      name: 'session.jobs',
      title: 'View background jobs',
      desc: 'List background jobs of this session',
      category: 'Session',
      run: () => setOverlay('jobs'),
    })
    registry.register({
      name: 'session.skills',
      title: 'View skills',
      desc: 'List the skills available in this project',
      category: 'Session',
      run: () => {
        setOverlay('skills')
        setSkillsData('loading')
        void state
          .listSkills(sessionId)
          .then((skills) => setSkillsData(skills))
          .catch((error: unknown) =>
            setSkillsData({ error: error instanceof Error ? error.message : String(error) }),
          )
      },
    })
    registry.register({
      name: 'session.queue-remove',
      title: 'Remove queued message',
      desc: 'Delete a message waiting in the queue',
      category: 'Session',
      bindings: ['ctrl+x'],
      run: () => setOverlay('queue'),
    })
    registry.register({
      name: 'composer.attach',
      title: 'Attach image',
      desc: 'Attach a local image file to the next message',
      category: 'Composer',
      run: () => setOverlay('attach'),
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
  const queue = summary?.queue ?? []
  const jobs = summary?.jobs ?? []
  const runningJobs = jobs.filter((job) => job.status === 'running').length
  const queueLengthRef = useRef(queue.length)
  queueLengthRef.current = queue.length
  const { tokens, percent } = contextUsage(state, sessionId)
  const cwd = summary?.cwd ?? process.cwd()
  const sidebarVisible = columns >= SIDEBAR_MIN_COLUMNS
  const contentWidth = columns - (sidebarVisible ? 42 : 0) - 4

  // 空会话（还没说过话）：中央 logo（opencode Home 的样子）。
  const empty = view.items.every((item) => item.kind !== 'user' && item.kind !== 'assistant')

  // 输入框固定占用：pad 行 + ≥1 输入行 + pad 行 + meta 行 + ╹▀ 行 + 快捷键行。
  const promptRows = 6
  const conversationRows = Math.max(1, rows - promptRows - 1 /* footer */ - 1 /* 保险 */)

  // ctrl+p 开面板、ctrl+x 开队列管理（队列非空才有意义）。审批/提问在场时都不开：
  // PendingPrompt 的 useInput 没有 acceptsKey 机制，开了它会跟对话框抢键（踩过）。
  useInput((input, key) => {
    if (overlayRef.current !== null) return
    if (pending !== undefined) return
    if (key.ctrl && input === 'p') setOverlay('palette')
    if (key.ctrl && input === 'x' && queueLengthRef.current > 0) setOverlay('queue')
  })
  // 对话框开着时来了审批/提问：让路，关掉对话框。
  const pendingKind = pending?.kind
  useEffect(() => {
    if (pendingKind !== undefined && overlayRef.current !== null) setOverlay(null)
  }, [pendingKind])

  // ── 附件：挂图与提交的自查都在这里，host 报错前就该拒掉 ──────────────
  const currentLimits = () => imageLimitsFromProjection(state.projections(sessionId).get('imageLimits'))

  const onAttachPath = (raw: string): void => {
    setOverlay(null)
    void (async () => {
      try {
        const draft = await readImageDraft(raw)
        const limits = currentLimits()
        if (limits !== undefined) {
          const problem = checkImageLimits([...attachmentsRef.current, draft], limits)
          if (problem !== undefined) {
            setNotice(problem)
            return
          }
        }
        setAttachments([...attachmentsRef.current, draft])
        setNotice(undefined)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    })()
  }

  const submit = (text: string): void => {
    const images = attachmentsRef.current
    const limits = currentLimits()
    // 提交前最后一道自查：限额投影存在就拦，不存在（没装附件服务）才放行让 host 回答。
    if (images.length > 0 && limits !== undefined) {
      const problem = checkImageLimits(images, limits)
      if (problem !== undefined) {
        setNotice(problem)
        return
      }
    }
    setNotice(undefined)
    setAttachments([])
    void state.prompt(sessionId, text, images)
  }

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
        onSubmit={submit}
        {...(preset !== undefined ? { preset } : {})}
        {...(model !== undefined ? { model } : {})}
        {...(provider !== undefined ? { provider } : {})}
        planModeSeen={summary?.planModeSeen === true}
        width={contentWidth}
        working={summary?.status === 'working'}
        onInterrupt={() => void state.cancel(sessionId)}
        attachments={attachments.map((draft) => ({ name: draft.name, bytes: draft.bytes }))}
        onClearAttachments={() => setAttachments([])}
        {...(notice !== undefined ? { notice } : {})}
        // 对话框开着时 composer 不能吃键（按键到达那一刻现问，读 ref 不读 state）。
        acceptsKey={() => overlayRef.current === null}
      />
    )

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

  const overlayElement =
    overlay === 'palette' ? (
      <CommandPalette
        registry={registry}
        onClose={() => setOverlay(null)}
        maxHeight={Math.max(5, conversationRows - 6)}
      />
    ) : overlay === 'jobs' ? (
      // 只展示——杀后台任务是模型的 `job_kill` 工具，dshr 不造这个 RPC。
      <DialogSelect
        title="Background jobs"
        options={jobs.map((job) => jobOption(job, Date.now()))}
        onSelect={() => setOverlay(null)}
        onCancel={() => setOverlay(null)}
        maxHeight={Math.max(5, conversationRows - 6)}
      />
    ) : overlay === 'skills' ? (
      <DialogSelect
        title="Skills"
        options={skillsOptions}
        onSelect={() => setOverlay(null)}
        onCancel={() => setOverlay(null)}
        maxHeight={Math.max(5, conversationRows - 6)}
      />
    ) : overlay === 'queue' ? (
      // 选中即删（session.updateQueue 的 remove），对话框不关：队列是活快照，
      // 删完能看到它缩；空了就剩 No results found，esc 收工。
      <DialogSelect
        title="Remove queued message"
        options={queue.map((item) => ({ title: item.text.replaceAll('\n', ' '), value: item.id }))}
        onSelect={(itemId) => {
          void state.removeQueuedMessage(sessionId, itemId).catch((error: unknown) => {
            setNotice(error instanceof Error ? error.message : String(error))
          })
        }}
        onCancel={() => setOverlay(null)}
        maxHeight={Math.max(5, conversationRows - 6)}
      />
    ) : overlay === 'attach' ? (
      <DialogPrompt
        title="Attach image"
        hint="Path to a local image file (png / jpeg / webp / gif)"
        placeholder="/path/to/image.png"
        onSubmit={onAttachPath}
        onCancel={() => setOverlay(null)}
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
                  之间留一行空（上游消息区 paddingBottom=1）。
                  排队消息徽章钉在输入框正上方（opencode 的 QueueDock 位置）。 */}
              <Box flexGrow={1} />
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
        {...(runningJobs > 0 ? { runningJobs } : {})}
        {...(model !== undefined ? { model } : {})}
      />
    </Box>
  )
}
