/**
 * `@dshr/state` 的公开契约。
 *
 * 这个文件是 TUI 层唯一认识的形状。**本包不许 import ink 或 react**——
 * 它必须能在 `node:test` 里裸跑，这是硬边界，不是风格偏好。
 */
import type {
  DshrClient,
  HostFrame,
  MuxFrame,
  RequestPayload,
  ResponseValue,
  RpcId,
  Unsubscribe,
} from '@dshr/protocol'

export type { Unsubscribe }

/** dsh 的 SessionId 是 branded string；这里按结构取用，不重新 brand。 */
export type SessionId = Extract<HostFrame, { type: 'host/session-added' }>['sessionId']
export type WorkspaceId = Extract<HostFrame, { type: 'host/workspace-removed' }>['workspaceId']

type ApprovalRequested = Extract<MuxFrame, { type: 'approval/requested' }>
type QuestionRequested = Extract<MuxFrame, { type: 'question/requested' }>
type ApprovalResolved = Extract<MuxFrame, { type: 'approval/resolved' }>

export type ApprovalOutcome = ApprovalResolved['outcome']
export type QuestionItems = QuestionRequested['questions']

/**
 * 侧栏那三个状态。
 *
 * **判据来自 host 的权威事件，不解析终端画面**——这是 dshr 相对终端多路复用器的
 * 结构性优势：后者只能从画面上猜，上游一改状态行格式就断。
 */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'error'

/** 一个会话正被什么挡住。`rpcId` 是应答时要回显的那个，不能新铸。 */
export type PendingInteraction =
  | { kind: 'approval'; rpcId: RpcId; approvalId: ApprovalRequested['approvalId']; toolName: string; callId?: ApprovalRequested['callId']; reason?: string }
  | { kind: 'question'; rpcId: RpcId; questions: QuestionItems }

export interface SessionSummary {
  sessionId: SessionId
  /** 来自 `session/projection`，不是单独的帧。可能还没到。 */
  title?: string
  cwd?: string
  status: AgentStatus
  /**
   * `host/session-added` 的 `blank` 恒为 true（帧在 session/created 时就发）。
   * 第一次 `host/session-status{running:true}` 时翻掉它；
   * 重连时以 `session.list` 的 `summary.blank` 为准。
   */
  blank: boolean
  parentSessionId?: SessionId
  origin?: 'subagent'
  agentPreset?: string
  /** status 为 'blocked' 时必有值。 */
  pending?: PendingInteraction
  /** status 为 'error' 时的最近一条消息。 */
  error?: string
}

export interface WorkspaceSummary {
  workspaceId: WorkspaceId
  title: string
  path: string
  /** host 的 durable 顺序。 */
  sessionIds: readonly SessionId[]
}

// ---- E 批类型（形状实测见 docs/gap-shapes.md §八 与 packages/state/src/goal.ts）----

/** `settings.describe` 的返回。 */
export type SettingsOverview = ResponseValue<'settings.describe'>
/** `llm.providers` 的一行。 */
export type ProviderEntry = ResponseValue<'llm.providers'>['providers'][number]
/** `llm.models` 的返回（`groups` + `failures`）。 */
export type ModelCatalog = ResponseValue<'llm.models'>

/** 一个已知 credential ref 的配置状态（**永远不含值**——上游契约结构性保证）。 */
export interface CredentialRefState {
  /** ref 名，如 `DEEPSEEK_API_KEY`。 */
  readonly ref: string
  readonly configured: boolean
  /** 生效来源（`env` / `file` …），未配置时缺省。 */
  readonly source?: string
  readonly writable: boolean
  /** 引用它的 holder：provider 显示名 / 设置命名空间。 */
  readonly holders: readonly string[]
}

export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** GoalId 是 branded string（上游品牌）；品牌只是编译期标记，运行时就是字符串。 */
export type GoalRefId = RequestPayload<'goal.pause'>['ref']['id']

/** 当前目标的读侧视图（`goal` 投影），`{id, revision}` 就是动词的 CAS ref。 */
export interface GoalInfo {
  readonly id: GoalRefId
  readonly revision: number
  readonly objective: string
  readonly phase: GoalPhase
  /** `phase` 为 `blocked` 时的原因（人读的那句）。 */
  readonly blockedReason?: string
  readonly roundsStarted: number
  readonly maxGoalRounds: number
}

/** 会话视图里的一项。工具调用**折叠成一行**，展开才看详情。 */
export type ConversationItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | {
      kind: 'reasoning'
      id: string
      text: string
      streaming: boolean
      /** 从流式 block-start/block-end 的时间戳算出的思考时长；组装不出时缺省。 */
      durationMs?: number
    }
  | {
      kind: 'tool'
      id: string
      callId: string
      name: string
      status: 'running' | 'ok' | 'error'
      /** host 算好的渲染意图。**有就用它**，没有才回退到通用 JSON 卡片。 */
      view?: Extract<MuxFrame, { type: 'session/event' }>['view']
      args?: unknown
      result?: unknown
    }
  /** 每轮结尾的页脚（opencode 的 `▣ Build · model · 2.1s`）。 */
  | {
      kind: 'turn'
      id: string
      durationMs: number
      /** 这轮最后一个 assistant 消息的 provenance（`assistant/message` 自带）。 */
      model?: string
      provider?: string
      /** 轮次没有正常收尾（aborted / error / max-tokens…）。 */
      interrupted?: boolean
    }
  | { kind: 'error'; id: string; message: string }
  | { kind: 'notice'; id: string; text: string }

export interface ConversationView {
  readonly sessionId: SessionId
  readonly items: readonly ConversationItem[]
  readonly status: AgentStatus
  readonly pending?: PendingInteraction
  /** 还有更早的历史可以翻。 */
  readonly hasOlder: boolean
  /** 往前翻一页。`loadOlder` 的页不带 projections 块。 */
  loadOlder(): Promise<void>
  /**
   * 本地产生的反馈行（命令结果、RPC 失败原因等），**不走 host 事件流**。
   * 命令面板动词的成败回执从这里进会话视图——dispatch 吞 rejection，
   * 没有它「点了没反应」就回来了。
   */
  pushNotice(text: string): void
  subscribe(listener: () => void): Unsubscribe
}

/**
 * headless 的客户端模型：把两条帧流折叠成 UI 能直接渲染的东西。
 *
 * 投影按 **higher-seq-wins** 存一份泛型 per-session 值表，由 `session.history`
 * 尾页的 `projections` 块播种，之后由 `session/projection` 帧更新。标题是其中一个键。
 */
export interface DshrState {
  readonly sessions: ReadonlyMap<SessionId, SessionSummary>
  /** 按 host 的 durable 顺序。 */
  readonly workspaces: readonly WorkspaceSummary[]
  /** 整体变化通知（列表增删、状态翻转）。会话内部的流式增量走 ConversationView。 */
  subscribe(listener: () => void): Unsubscribe

  /** 打开（必要时创建 host 侧 agent）一个会话的视图。 */
  conversation(sessionId: SessionId): ConversationView

  /**
   * 泛型 per-session 投影值表的当前快照（higher-seq-wins 后的最新值）。
   * `title` / `contextPressure` / `contextBreakdown` 都是其中的键——状态行的
   * 上下文用量从这里读，不是只有标题。每次调用返回一份拷贝。
   */
  projections(sessionId: SessionId): ReadonlyMap<string, unknown>

  createWorkspace(path: string, title?: string): Promise<WorkspaceId>
  createSession(input: { cwd: string; workspaceId?: WorkspaceId; agentPreset?: string }): Promise<SessionId>
  prompt(sessionId: SessionId, text: string): Promise<void>
  cancel(sessionId: SessionId): Promise<void>

  answerApproval(sessionId: SessionId, outcome: ApprovalOutcome): Promise<void>
  answerQuestion(sessionId: SessionId, answers: unknown): Promise<void>

  // ---- E 批：设置 / 凭证 / provider / 目标 ----
  // 设计取向：dsh 自带 settings.openDocument / agentPreset.openDocument——
  // 上游的意图就是「用编辑器改配置文件」，所以这里**只读为主，不做设置编辑器**。
  // settings.update/replace/mutate 与 credentials.set/unset 会写用户真实的 ~/.dsh，
  // 这一层**故意不包它们**。

  /** `settings.describe`：全命名空间的脱敏分层值（secret 字段永不下线，上游保证）。 */
  describeSettings(): Promise<SettingsOverview>
  /** `settings.openDocument`：把设置文档交给系统编辑器。失败抛错（含 opener 不可用）。 */
  openSettingsDocument(): Promise<void>
  /** `llm.providers`：可配置 provider 目录 + 活跃状态。只读。 */
  listProviders(): Promise<readonly ProviderEntry[]>
  /** `llm.models`：host 级模型目录（不带会话选择）。只读。 */
  listModels(): Promise<ModelCatalog>
  /**
   * 已知 credential ref 的配置状态。ref 清单从 `settings.describe` + `llm.providers`
   * 的 `apiKeyEnv` 字段发现（credentials 域没有枚举方法，见 credentials.ts 的注释），
   * 状态来自 `credentials.describe`——**只读，值永不过线**。
   */
  describeCredentials(): Promise<readonly CredentialRefState[]>

  /** 当前目标（`goal` 投影的解析结果）；没有目标或形状不符时 undefined。 */
  goalOf(sessionId: SessionId): GoalInfo | undefined
  /** `goal.create`：载荷的键是 `objective`（实测逼出来的，不是 content）。 */
  createGoal(sessionId: SessionId, objective: string): Promise<void>
  /**
   * 四个人工干预动词。CAS ref（`{id, revision}`）在**调用那一刻**从投影现读——
   * 模型的自动轮次会一直推 revision，旧 ref 会撞 GOAL_STALE_REVISION（实测）。
   * 没有当前目标时抛错。
   */
  pauseGoal(sessionId: SessionId): Promise<void>
  resumeGoal(sessionId: SessionId): Promise<void>
  completeGoal(sessionId: SessionId): Promise<void>
  clearGoal(sessionId: SessionId): Promise<void>

  dispose(): Promise<void>
}

export interface CreateStateOptions {
  client: DshrClient
}
