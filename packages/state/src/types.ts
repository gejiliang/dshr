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
  /** 当前模型选择。`session.models` 的 `current` 播种、`session.selectModel` 成功后更新。 */
  model?: string
  /** 同 `model` 一对。 */
  provider?: string
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
  /** `session/queue` 帧的排队消息快照（placement === 'queued'）；空时不设。 */
  queue?: readonly QueuedMessage[]
  /**
   * 会话事件流里见过 `plan/mode`。它的载荷形状**还没打到**（docs/gap-shapes.md §七），
   * 所以这里只有「发生过」这一个比特，**不知道方向**（是进是出 plan 模式不得而知）。
   */
  planModeSeen?: true
}

export interface WorkspaceSummary {
  workspaceId: WorkspaceId
  title: string
  path: string
  /** host 的 durable 顺序。 */
  sessionIds: readonly SessionId[]
}

/** `todo/write` 快照里的一条。形状照抄上游 `TodoItem`（dsh-session types.d.ts）。 */
export interface TodoEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** `session/queue` 帧里的一条排队消息（只留渲染要的：id + 纯文本）。 */
export interface QueuedMessage {
  id: string
  text: string
}

/** `session.models` 的返回——直接就是模型对话框的数据结构，不转译（docs/gap-shapes.md §八）。 */
export type SessionModels = ResponseValue<'session.models'>
/** `agentPreset.list` 的一行（dsh 实际只有 standard/code/minimal/cordis 四个）。 */
export type AgentPresetEntry = ResponseValue<'agentPreset.list'>['presets'][number]

/** 会话选择对话框的一行（`session.list` 映射而来，按 updatedAt 降序）。 */
export interface SessionListEntry {
  sessionId: SessionId
  /** 投影里的标题；还没有时缺省。 */
  title?: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  agentPreset?: string
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
  /**
   * 一次 LLM 重试（`llm/retry`，退避结束时 `llm/retry-started` 用 retryId 配对置 started）。
   * 字段名照抄实测载荷（docs/gap-shapes.md §二）；`code` 是 `failure.code` 分类，
   * 原始报文 `failure.message` 不进这行。孤儿 retry-started 没有 code/maxRetries。
   */
  | {
      kind: 'retry'
      id: string
      retryId: string
      attempt: number
      maxRetries?: number
      code?: string
      started: boolean
    }
  /** `todo/write` 的整表快照；last-write-wins，视图里永远只有一份（原地换新对象）。 */
  | { kind: 'todo'; id: string; todos: readonly TodoEntry[] }
  /** 一次斜杠命令的执行痕迹：`command/run` 开、`command/done` 按 commandId 收尾。 */
  | {
      kind: 'command'
      id: string
      commandId: string
      name: string
      args?: string
      status: 'running' | 'ok' | 'error'
      text?: string
    }
  /**
   * 居中标题横线（`──── Compaction ────`）。
   * `compaction/*` 的载荷形状**还没打到**（docs/gap-shapes.md §七），这里只认 `type`，
   * 一段连续的 compaction 事件折成一条线。
   */
  | { kind: 'divider'; id: string; label: string }

export interface ConversationView {
  readonly sessionId: SessionId
  readonly items: readonly ConversationItem[]
  readonly status: AgentStatus
  readonly pending?: PendingInteraction
  /** 还有更早的历史可以翻。 */
  readonly hasOlder: boolean
  /** 往前翻一页。`loadOlder` 的页不带 projections 块。 */
  loadOlder(): Promise<void>
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

  /** 拉这个会话的模型目录（同时用 `current` 播种 summary 的 model/provider）。 */
  listModels(sessionId: SessionId): Promise<SessionModels>
  /** 切模型。成功后 summary 的 model/provider 跟着变。 */
  selectModel(sessionId: SessionId, provider: string, model: string): Promise<void>

  /** 部署的预设名册（root-precedence 顺序，上游原样）。 */
  listPresets(): Promise<readonly AgentPresetEntry[]>
  /**
   * 切预设。⚠️ 载荷键是 `agentPreset`，**不是 `presetId`**（实测，docs/gap-shapes.md §八）；
   * 且只在会话 blank（还没跑过一轮）时允许，否则 host 回 `agent-preset-locked`。
   */
  selectPreset(sessionId: SessionId, agentPreset: string): Promise<void>

  /**
   * 重命名。返回的 `{ title, seq }` 直接落进 title 投影格
   * （上游注释明说这就是给调用方 settle 用的），不等推送帧。
   */
  renameSession(sessionId: SessionId, title: string): Promise<void>
  /**
   * 从最近一个已完成轮分叉出一个新会话，返回新 sessionId。
   * 没有已完成轮时 host 回 `fork-unavailable`（错误原样抛出，调用方负责可读提示）。
   */
  forkSession(sessionId: SessionId): Promise<SessionId>

  /** 会话选择对话框的列表——**走 `session.list`**（search 可能被部署关掉，不能依赖）。 */
  listSessions(): Promise<readonly SessionListEntry[]>
  /**
   * `session.search` 的增强过滤：返回匹配内容的 sessionId 集合。
   * **部署关掉 search 时返回 undefined**（实测：openAt "never" 的部署直接报错），
   * 调用方据此退回本地过滤——没有它必须照样能用。
   */
  searchSessions(query: string): Promise<readonly SessionId[] | undefined>

  answerApproval(sessionId: SessionId, outcome: ApprovalOutcome): Promise<void>
  answerQuestion(sessionId: SessionId, answers: unknown): Promise<void>

  dispose(): Promise<void>
}

export interface CreateStateOptions {
  client: DshrClient
}
