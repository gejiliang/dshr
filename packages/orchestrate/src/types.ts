/**
 * `@dshr/orchestrate` 的公开契约 —— 多 agent 编排的**动词层**。
 *
 * 纪律（docs/architecture.md「编排只提供动词，不提供语义」）：
 * 这个文件里没有任何 Role / Workflow / Protocol / Template 概念。
 * `purpose` 之类的字段只是**不透明字符串**：原样存、原样吐回，
 * 本包绝不对它的内容做任何分支判断。谁是实现谁是评审、怎么配对、
 * 什么算验收，全部活在调用者的 prompt 里。
 *
 * 本包是纯库：只依赖 `DshrClient` 接口，不 import dsh 插件 API。
 */
import type { DshrClient, MuxFrame, ResponseValue, RpcId } from '@dshr/protocol'

/** dsh 的 SessionId（brand string），从 protocol 的方法签名推出，不引新依赖。 */
export type SessionId = ResponseValue<'session.create'>['sessionId']

/** 并发上限的默认值。可被构造参数与 setLimit 覆盖。 */
export const DEFAULT_MAX_WORKERS = 16
/**
 * 绝对上界：不管人怎么设都不许超过。并行会话失控是静默的，
 * 所以闸门必须有一个钉死的顶。
 */
export const ABSOLUTE_MAX_WORKERS = 50

export interface SpawnInput {
  /** 第一个 prompt 的全文。对worker 的一切期望都写在这里，本包不解析。 */
  task: string
  cwd: string
  title?: string
  /** 不透明字符串：原样挂在 handle 上，供调用者自己记账。本包不读。 */
  purpose?: string
  agentPreset?: string
}

/**
 * worker 的实时状态（由 host 权威事件驱动，不解析终端画面）：
 * - `working`：`host/session-status{running:true}`，或 spawn 后尚未看到任何状态帧
 * - `idle`：`running:false` 且无未决交互
 * - `blocked`：有未决的 approval / question——**不处理就永远不动**，这不是错误
 * - `error`：收到 `host/agent-error`（或会话从 host 消失）
 * - `terminated`：被 `cancel(mode:'terminate')` 除名（handle 还在，编排已不再认识它）
 */
export type WorkerStatus = 'working' | 'idle' | 'blocked' | 'error' | 'terminated'

/**
 * settle 的结果。settle ≠ 出错：一个 worker「落定」只意味着
 * 「不喂新输入它就会一直停在这里」。
 * - `done`：spawn 时那个 task 的轮次正常跑完
 * - `idle`：后续 send 的轮次正常跑完
 * - `blocked`：卡在审批或提问上，`pending` 里有原因
 * - `error`：`host/agent-error` 或会话消失
 */
export type SettleOutcome = 'done' | 'idle' | 'blocked' | 'error'

/** 一个未决审批。`rpcId` 是 host 铸造的（重放逐字复用），调用者拿它走 `client.respond` 应答。 */
export interface PendingApproval {
  kind: 'approval'
  rpcId: RpcId
  approvalId: string
  toolName: string
  reason?: string
}

/** 一个未决提问。`questions` 原样透传 mux 帧载荷。 */
export interface PendingQuestion {
  kind: 'question'
  rpcId: RpcId
  questions: Extract<MuxFrame, { type: 'question/requested' }>['questions']
}

export type PendingInteraction = PendingApproval | PendingQuestion

/**
 * 一个 worker 的句柄。一个 worker = 一个 dsh session。
 * v1 里 `workerId` 与 `sessionId` 同值；分开命名是给将来留的接缝。
 *
 * 句柄是**活视图**：`status` / `pending` 每次读都是当前值。
 * 可选字段一律是 `T | undefined`（exactOptionalPropertyTypes 下不靠「缺键」表达）。
 */
export interface WorkerHandle {
  readonly workerId: string
  readonly sessionId: string
  readonly cwd: string
  readonly title: string | undefined
  /** 不透明，原样返回 spawn 时给的值。 */
  readonly purpose: string | undefined
  readonly agentPreset: string | undefined
  readonly spawnedAt: number
  readonly status: WorkerStatus
  /** 当前未决的审批 / 提问（`blocked` 的原因）。 */
  readonly pending: readonly PendingInteraction[]
  /** 是否有一个未被 wait 收走的 settle。 */
  readonly settled: boolean
}

/** 一次被 wait 收走的 settle。 */
export interface SettledWorker {
  readonly workerId: string
  readonly sessionId: string
  readonly outcome: SettleOutcome
  /** outcome === 'blocked' 时非空：卡住的原因。 */
  readonly pending: readonly PendingInteraction[]
  /** outcome === 'error' 时给出。 */
  readonly error: string | undefined
  readonly handle: WorkerHandle
}

/** spawn 超限：直接拒绝，不静默排队。 */
export class WorkerLimitError extends Error {
  readonly limit: number
  constructor(limit: number) {
    super(`worker limit reached (${limit}); spawn refused, nothing was queued`)
    this.name = 'WorkerLimitError'
    this.limit = limit
  }
}

/** 一次 unary 调用的业务错误（`result.error`）。载体故障由 client 自己 throw，不在此类。 */
export class OrchestratorCallError extends Error {
  readonly method: string
  readonly code: string
  constructor(method: string, code: string, message: string) {
    super(`${method} failed: [${code}] ${message}`)
    this.name = 'OrchestratorCallError'
    this.method = method
    this.code = code
  }
}

export interface OrchestratorOptions {
  client: DshrClient
  /**
   * 覆盖 `DEFAULT_MAX_WORKERS`。构造参数算「人显式设过的值」。
   * 范围 1..`ABSOLUTE_MAX_WORKERS`，超出抛 RangeError。
   */
  maxWorkers?: number
}

/**
 * 编排动词，仅此而已。
 *
 * 关于上限的持久化纪律（herdgent 踩出来的坑）：
 * 读回时**必须**用 `explicitLimit` 而不是 `limit`——前者为 null 表示
 * 「人从没设过，有效值来自默认值」，持久化层这时应该**不写盘**；
 * 把启动时读到的 `limit` 写回去，会导致改默认值对所有跑过的实例静默无效。
 */
export interface Orchestrator {
  /** 超上限直接抛 WorkerLimitError，不排队。业务错误抛 OrchestratorCallError。 */
  spawn(input: SpawnInput): Promise<WorkerHandle>
  /** 给一个还活着的 worker 追加输入（queue 模式）。worker 不存在或已 terminate → { submitted: false }。 */
  send(workerId: string, text: string): Promise<{ submitted: boolean }>
  /**
   * 阻塞到至少一个 worker settle 就返回（收走所有当前已 settle 的）。
   * 由事件帧驱动，无轮询。给 workerIds 则只看这些 worker。
   */
  wait(workerIds?: string[]): Promise<SettledWorker[]>
  /**
   * 两个 mode 都**不删会话**（会话是人的记录）：
   * - `interrupt`：只中止当前轮，worker 仍在编排里、还占额度、还能 send
   * - `terminate`：中止当前轮，并从编排里除名、释放并发额度
   */
  cancel(workerId: string, mode: 'interrupt' | 'terminate'): Promise<void>
  /** 当前在编排里的所有 worker（terminate 除名后不再出现）。 */
  list(): WorkerHandle[]
  /** 运行时调整上限。范围 1..`ABSOLUTE_MAX_WORKERS`，超出抛 RangeError。 */
  setLimit(n: number): void
  /** 有效上限（explicitLimit ?? 默认值）。**只读快照，别把它当成人设过的值去持久化。** */
  readonly limit: number
  /** 人显式设过的上限；从未设过为 null。持久化层只应存这个值（null 就不写）。 */
  readonly explicitLimit: number | null
  /** 退订帧流。之后所有动词失效。 */
  dispose(): void
}
