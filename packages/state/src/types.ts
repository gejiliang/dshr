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

/** 会话视图里的一项。工具调用**折叠成一行**，展开才看详情。 */
export type ConversationItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'reasoning'; id: string; text: string; streaming: boolean }
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

  createWorkspace(path: string, title?: string): Promise<WorkspaceId>
  createSession(input: { cwd: string; workspaceId?: WorkspaceId; agentPreset?: string }): Promise<SessionId>
  prompt(sessionId: SessionId, text: string): Promise<void>
  cancel(sessionId: SessionId): Promise<void>

  answerApproval(sessionId: SessionId, outcome: ApprovalOutcome): Promise<void>
  answerQuestion(sessionId: SessionId, answers: unknown): Promise<void>

  dispose(): Promise<void>
}

export interface CreateStateOptions {
  client: DshrClient
}
