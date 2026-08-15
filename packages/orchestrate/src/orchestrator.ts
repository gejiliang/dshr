/**
 * Orchestrator 实现：把 `DshrClient` 的调用与帧流折叠成六个动词。
 *
 * 这里**故意没有**的东西：角色、配对、评审、模板、流程。
 * 帧只被翻译成状态（working/idle/blocked/error），从不被解释出语义。
 */
import type {
  DshrClient,
  HostFrame,
  MuxFrame,
  RequestPayload,
  RpcId,
  Unsubscribe,
} from '@dshr/protocol'
import {
  ABSOLUTE_MAX_WORKERS,
  DEFAULT_MAX_WORKERS,
  OrchestratorCallError,
  WorkerLimitError,
} from './types.js'
import type {
  Orchestrator,
  OrchestratorOptions,
  PendingInteraction,
  SessionId,
  SettledWorker,
  SettleOutcome,
  SpawnInput,
  WorkerHandle,
  WorkerStatus,
} from './types.js'

interface Settle {
  outcome: SettleOutcome
  error?: string
}

interface WorkerRecord {
  workerId: string
  sessionId: SessionId
  cwd: string
  title: string | undefined
  purpose: string | undefined
  agentPreset: string | undefined
  spawnedAt: number
  running: boolean
  terminated: boolean
  errorMessage: string | null
  /** 未决交互，key 形如 `approval:<approvalId>` / `question:<rpcId>`。 */
  pending: Map<string, PendingInteraction>
  /** 首个 task 轮次是否已干净地跑完过（区分 done / idle）。 */
  completedInitialTask: boolean
  /** 未被 wait 收走的 settle。 */
  settle: Settle | null
  view: WorkerHandleView | null
}

class WorkerHandleView implements WorkerHandle {
  constructor(private readonly rec: WorkerRecord) {}
  get workerId(): string {
    return this.rec.workerId
  }
  get sessionId(): string {
    return this.rec.sessionId
  }
  get cwd(): string {
    return this.rec.cwd
  }
  get title(): string | undefined {
    return this.rec.title
  }
  get purpose(): string | undefined {
    return this.rec.purpose
  }
  get agentPreset(): string | undefined {
    return this.rec.agentPreset
  }
  get spawnedAt(): number {
    return this.rec.spawnedAt
  }
  get status(): WorkerStatus {
    if (this.rec.terminated) return 'terminated'
    if (this.rec.pending.size > 0) return 'blocked'
    if (this.rec.errorMessage !== null) return 'error'
    return this.rec.running ? 'working' : 'idle'
  }
  get pending(): readonly PendingInteraction[] {
    return [...this.rec.pending.values()]
  }
  get settled(): boolean {
    return this.rec.settle !== null
  }
}

function validateLimit(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > ABSOLUTE_MAX_WORKERS) {
    throw new RangeError(`worker limit must be an integer in 1..${ABSOLUTE_MAX_WORKERS}, got ${n}`)
  }
  return n
}

class DshrOrchestrator implements Orchestrator {
  private readonly client: DshrClient
  private readonly records = new Map<string, WorkerRecord>()
  private readonly waiters: Array<() => void> = []
  private readonly unsubs: Unsubscribe[]
  private limitValue: number
  private explicitLimitValue: number | null

  constructor(options: OrchestratorOptions) {
    this.client = options.client
    this.explicitLimitValue =
      options.maxWorkers !== undefined ? validateLimit(options.maxWorkers) : null
    this.limitValue = this.explicitLimitValue ?? DEFAULT_MAX_WORKERS
    this.unsubs = [
      this.client.onHostFrame((frame) => this.onHostFrame(frame)),
      this.client.onMuxFrame((frame, rpcId) => this.onMuxFrame(frame, rpcId)),
    ]
  }

  get limit(): number {
    return this.limitValue
  }

  get explicitLimit(): number | null {
    return this.explicitLimitValue
  }

  setLimit(n: number): void {
    const v = validateLimit(n)
    this.limitValue = v
    this.explicitLimitValue = v
  }

  async spawn(input: SpawnInput): Promise<WorkerHandle> {
    if (this.records.size >= this.limitValue) throw new WorkerLimitError(this.limitValue)

    const createPayload: RequestPayload<'session.create'> = { cwd: input.cwd }
    if (input.agentPreset !== undefined) createPayload.agentPreset = input.agentPreset
    const created = await this.client.call('session.create', createPayload)
    if (!created.ok) {
      throw new OrchestratorCallError('session.create', created.error.code, created.error.message)
    }
    const sessionId = created.value.sessionId

    const prompted = await this.client.call('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: input.task }],
    })
    if (!prompted.ok) {
      throw new OrchestratorCallError('session.prompt', prompted.error.code, prompted.error.message)
    }

    const rec: WorkerRecord = {
      workerId: sessionId,
      sessionId,
      cwd: input.cwd,
      title: input.title,
      purpose: input.purpose,
      agentPreset: input.agentPreset,
      spawnedAt: Date.now(),
      running: true,
      terminated: false,
      errorMessage: null,
      pending: new Map(),
      completedInitialTask: false,
      settle: null,
      view: null,
    }
    this.records.set(rec.workerId, rec)
    return this.viewOf(rec)
  }

  async send(workerId: string, text: string): Promise<{ submitted: boolean }> {
    const rec = this.records.get(workerId)
    if (!rec) return { submitted: false }
    const res = await this.client.call('session.prompt', {
      sessionId: rec.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    })
    if (!res.ok) return { submitted: false }
    // 新指令已入队：还没结算的 clean settle 作废（blocked 由未决交互驱动，不在这里清）。
    if (rec.settle !== null && rec.settle.outcome !== 'blocked') rec.settle = null
    if (rec.pending.size === 0) rec.errorMessage = null
    return { submitted: true }
  }

  async wait(workerIds?: string[]): Promise<SettledWorker[]> {
    const filter = workerIds !== undefined ? new Set(workerIds) : null
    for (;;) {
      const out: SettledWorker[] = []
      for (const rec of this.records.values()) {
        if (rec.settle === null) continue
        if (filter !== null && !filter.has(rec.workerId)) continue
        const settle = rec.settle
        rec.settle = null
        out.push({
          workerId: rec.workerId,
          sessionId: rec.sessionId,
          outcome: settle.outcome,
          pending: [...rec.pending.values()],
          error: settle.error,
          handle: this.viewOf(rec),
        })
      }
      if (out.length > 0) return out
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
      })
    }
  }

  async cancel(workerId: string, mode: 'interrupt' | 'terminate'): Promise<void> {
    const rec = this.records.get(workerId)
    if (!rec) throw new Error(`unknown worker: ${workerId}`)
    const res = await this.client.call('session.cancel', { sessionId: rec.sessionId })
    if (!res.ok) {
      throw new OrchestratorCallError('session.cancel', res.error.code, res.error.message)
    }
    if (mode === 'interrupt') {
      // 只中止当前轮：worker 仍在编排里、还占额度、还能 send。
      if (rec.settle !== null && rec.settle.outcome !== 'blocked') rec.settle = null
      return
    }
    // terminate：除名、释放额度。会话本身不删——那是人的记录。
    rec.terminated = true
    rec.settle = null
    this.records.delete(workerId)
  }

  list(): WorkerHandle[] {
    return [...this.records.values()].map((rec) => this.viewOf(rec))
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub()
    this.records.clear()
    this.signal()
  }

  // ---- 帧 → 状态 ----

  private bySession(sessionId: SessionId): WorkerRecord | undefined {
    return this.records.get(sessionId)
  }

  private onHostFrame(frame: HostFrame): void {
    switch (frame.type) {
      case 'host/session-status': {
        const rec = this.bySession(frame.sessionId)
        if (!rec) return
        rec.running = frame.running
        if (frame.running) {
          // 新一轮开始：作废还没被收走的 clean settle，清掉旧的 error。
          if (rec.settle !== null && rec.settle.outcome !== 'blocked') rec.settle = null
          rec.errorMessage = null
        } else {
          this.settleStopped(rec)
        }
        return
      }
      case 'host/agent-error': {
        const rec = this.bySession(frame.sessionId)
        if (!rec) return
        rec.errorMessage = frame.message
        this.applySettle(rec, { outcome: 'error', error: frame.message })
        return
      }
      case 'host/session-removed': {
        const rec = this.bySession(frame.sessionId)
        if (!rec) return
        rec.errorMessage = 'session removed from host'
        this.applySettle(rec, { outcome: 'error', error: 'session removed from host' })
        return
      }
      default:
        return
    }
  }

  private onMuxFrame(frame: MuxFrame, rpcId: RpcId): void {
    switch (frame.type) {
      case 'approval/requested': {
        const rec = this.bySession(frame.sessionId)
        if (!rec) return
        rec.pending.set(`approval:${frame.approvalId}`, {
          kind: 'approval',
          rpcId,
          approvalId: frame.approvalId,
          toolName: frame.toolName,
          ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
        })
        // blocked 是 settle 状态：不处理就永远不动，调用者必须现在就知道。
        this.applySettle(rec, { outcome: 'blocked' })
        return
      }
      case 'approval/resolved': {
        const rec = this.bySession(frame.sessionId)
        if (!rec) return
        rec.pending.delete(`approval:${frame.approvalId}`)
        this.maybeUnblock(rec)
        return
      }
      case 'question/requested': {
        const rec = this.bySession(frame.sessionId)
        if (!rec) return
        rec.pending.set(`question:${rpcId}`, { kind: 'question', rpcId, questions: frame.questions })
        this.applySettle(rec, { outcome: 'blocked' })
        return
      }
      case 'question/resolved': {
        const rec = this.bySession(frame.sessionId)
        if (!rec) return
        rec.pending.delete(`question:${frame.questionRpcId}`)
        this.maybeUnblock(rec)
        return
      }
      default:
        return
    }
  }

  /** 轮次停下（running:false）：有未决交互则 blocked，否则 done/idle。 */
  private settleStopped(rec: WorkerRecord): void {
    if (rec.pending.size > 0) {
      this.applySettle(rec, { outcome: 'blocked' })
      return
    }
    const outcome: SettleOutcome = rec.completedInitialTask ? 'idle' : 'done'
    rec.completedInitialTask = true
    this.applySettle(rec, { outcome })
  }

  /** 未决交互清空：若之前是按 blocked 结算的，撤销它，让 worker 回到「还会再动」。 */
  private maybeUnblock(rec: WorkerRecord): void {
    if (rec.pending.size > 0) return
    if (rec.settle !== null && rec.settle.outcome === 'blocked') rec.settle = null
    // running:false 可能先于 resolved 到达；此时直接补一个 clean settle。
    if (!rec.running) this.settleStopped(rec)
  }

  private applySettle(rec: WorkerRecord, settle: Settle): void {
    rec.settle = settle
    this.signal()
  }

  private signal(): void {
    const waiters = this.waiters.splice(0)
    for (const wake of waiters) wake()
  }

  private viewOf(rec: WorkerRecord): WorkerHandleView {
    if (rec.view === null) rec.view = new WorkerHandleView(rec)
    return rec.view
  }
}

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  return new DshrOrchestrator(options)
}
