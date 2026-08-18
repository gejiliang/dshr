/**
 * `@dshr/state` 的实现：把 host 的两条下行帧流折叠成 UI 能直接渲染的模型。
 *
 * 每条行为都对应 docs/dsh-contract.md 里一个实测过的事实：
 * - 状态映射来自 host 的权威事件（`host/session-status` / 未决 requested / `host/agent-error`）
 * - `host/session-added` 的 `blank` 恒为 true，第一次 `running:true` 时翻掉；
 *   重连后以 `session.list` 的 `summary.blank` 为准
 * - 投影按 higher-seq-wins，由 history 尾页的 projections 块播种、`session/projection` 帧更新
 * - 未决交互保留 rpcId（应答只回显），重放帧 rpcId 逐字复用，用 rpcId 去重即天然幂等
 * - `client.generation` 变化 = 连接重建：per-session 对话缓存作废重取
 */
import type {
  ConnectionState,
  DshrClient,
  HostFrame,
  MuxFrame,
  RequestPayload,
  ResponseValue,
  RpcError,
  RpcId,
  Unsubscribe,
} from '@dshr/protocol'
import { Conversation, type ProjectionsBlock } from './conversation.js'
import { collectCredentialRefs } from './credentials.js'
import { parseGoalProjection } from './goal.js'
import type { ImageDraft } from './images.js'
import type {
  AgentPresetEntry,
  AgentStatus,
  ApprovalOutcome,
  ConversationView,
  CreateStateOptions,
  CredentialRefState,
  DshrState,
  GoalInfo,
  JobItem,
  ModelCatalog,
  PendingInteraction,
  ProviderEntry,
  QueuedMessage,
  SessionId,
  SessionListEntry,
  SessionModels,
  SessionSummary,
  SettingsNamespace,
  SettingsOverview,
  SettingsPathOp,
  SkillEntry,
  WorkspaceId,
  WorkspaceSummary,
} from './types.js'

type SessionListItem = ResponseValue<'session.list'>['items'][number]
type WorkspaceListValue = ResponseValue<'workspace.list'>
type QueueFrame = Extract<MuxFrame, { type: 'session/queue' }>

/** 从 `session/queue` 的 message.content 抠纯文本（只认 `{type:'text'}` 块）。 */
function queueText(item: QueueFrame['items'][number]): string {
  const parts: string[] = []
  for (const block of item.message.content) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

/** 一个会话的全部内部状态。summary 是每次变化时从它重建的不可变快照。 */
interface SessionRecord {
  sessionId: SessionId
  running: boolean
  blank: boolean
  cwd?: string
  parentSessionId?: SessionId
  origin?: 'subagent'
  agentPreset?: string
  /** `host/agent-error` 的最近一条消息；下一条 `host/session-status` 帧到来时清除。 */
  error?: string
  /** 未决的审批/提问，**按 rpcId 去重**——host 重放时 rpcId 逐字复用，Map.set 即幂等。 */
  pending: Map<RpcId, PendingInteraction>
  /** 泛型投影值表，higher-seq-wins。 */
  projections: Map<string, { value: unknown; seq: number }>
  /** `session/queue` 的最近一份快照（只留 placement === 'queued' 的）。 */
  queue: QueuedMessage[]
  /** `session/jobs` 的最近一份整份快照。 */
  jobs: JobItem[]
  /** 会话事件流里见过 `plan/mode`（形状未知，只有这一个比特）。 */
  planModeSeen: boolean
  /** 当前模型选择；`session.models` 播种、`session.selectModel` 成功后更新。 */
  model?: { provider: string; model: string }
}

function rpcFailure(method: string, error: RpcError): Error {
  return new Error(`${method} failed: ${error.code}: ${error.message}`)
}

class DshrStateImpl implements DshrState {
  private readonly records = new Map<SessionId, SessionRecord>()
  private readonly summaries = new Map<SessionId, SessionSummary>()
  private workspaceOrder: WorkspaceId[] = []
  private readonly workspaceViews = new Map<WorkspaceId, WorkspaceSummary>()
  private readonly conversations = new Map<SessionId, Conversation>()
  private readonly listeners = new Set<() => void>()
  private readonly remoteEventListeners = new Set<(event: string, args: readonly unknown[]) => void>()
  private readonly unsubs: Unsubscribe[] = []
  private baselinedGeneration = -1
  private disposed = false

  constructor(private readonly client: DshrClient) {
    this.unsubs.push(
      client.onHostFrame((frame) => this.onHostFrame(frame)),
      client.onMuxFrame((frame, rpcId) => this.onMuxFrame(frame, rpcId)),
      client.onConnectionChange((state) => this.onConnectionChange(state)),
    )
    // 构造时连接可能已经 ready（先连后建 state 的用法）。
    if (client.state.status === 'ready') void this.rebaseline(client.state.generation)
  }

  get sessions(): ReadonlyMap<SessionId, SessionSummary> {
    return this.summaries
  }

  get workspaces(): readonly WorkspaceSummary[] {
    const out: WorkspaceSummary[] = []
    for (const id of this.workspaceOrder) {
      const view = this.workspaceViews.get(id)
      if (view) out.push(view)
    }
    return out
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onRemoteEvent(listener: (event: string, args: readonly unknown[]) => void): Unsubscribe {
    this.remoteEventListeners.add(listener)
    return () => {
      this.remoteEventListeners.delete(listener)
    }
  }

  conversation(sessionId: SessionId): ConversationView {
    let conv = this.conversations.get(sessionId)
    if (!conv) {
      const record = this.ensureRecord(sessionId)
      conv = new Conversation(this.client, sessionId, {
        onProjections: (block) => {
          this.seedProjections(record, block)
          this.refreshSummary(record)
        },
        onPlanMode: () => {
          if (!record.planModeSeen) {
            record.planModeSeen = true
            this.refreshSummary(record)
          }
        },
      })
      conv.syncStatus(this.statusOf(record), this.pendingOf(record))
      this.conversations.set(sessionId, conv)
      this.refreshSummary(record)
    }
    return conv
  }

  projections(sessionId: SessionId): ReadonlyMap<string, unknown> {
    const record = this.records.get(sessionId)
    const out = new Map<string, unknown>()
    if (!record) return out
    for (const [key, cell] of record.projections) out.set(key, cell.value)
    return out
  }

  /**
   * 按路径拿工作区，没有就建。**幂等**——这一点是踩出来的。
   *
   * host 对同一路径重复 `workspace.create` 会**返回已有工作区且不改它的标题**
   * （`created: false`）。所以只有**真的新建出来**时才去 rename：
   * 无条件 rename 会在第二次调用时撞上别处那个同名工作区，
   * 报 `workspace-name-conflict` 让整个调用失败——而调用方要的工作区其实好端端地存在。
   */
  async createWorkspace(path: string, title?: string): Promise<WorkspaceId> {
    const res = await this.client.call('workspace.create', { path })
    if (!res.ok) throw rpcFailure('workspace.create', res.error)
    const workspace = res.value.workspace
    this.upsertWorkspace(workspace)
    const isNew = res.value.created
    if (isNew && title !== undefined && title !== workspace.title) {
      const renamed = await this.client.call('workspace.rename', { workspaceId: workspace.workspaceId, title })
      if (!renamed.ok) throw rpcFailure('workspace.rename', renamed.error)
      this.upsertWorkspace(renamed.value.workspace)
    }
    this.notify()
    return workspace.workspaceId
  }

  async createSession(input: { cwd: string; workspaceId?: WorkspaceId; agentPreset?: string }): Promise<SessionId> {
    // ⚠️ host 侧的校验是 **workspaceId 或 cwd，不能两个都给**（实测：两个都传会回
    // bad-request "session.create accepts workspaceId or cwd, not both"）。
    // 工作区自己记得路径，所以有 workspaceId 时就只发它。
    const payload: RequestPayload<'session.create'> = {
      ...(input.workspaceId !== undefined
        ? { workspaceId: input.workspaceId }
        : { cwd: input.cwd }),
      ...(input.agentPreset !== undefined ? { agentPreset: input.agentPreset } : {}),
    }
    const res = await this.client.call('session.create', payload)
    if (!res.ok) throw rpcFailure('session.create', res.error)
    const record = this.ensureRecord(res.value.sessionId)
    if (record.cwd === undefined) record.cwd = input.cwd
    this.refreshSummary(record)
    return res.value.sessionId
  }

  async prompt(sessionId: SessionId, text: string, images: readonly ImageDraft[] = []): Promise<void> {
    // 图片没有单独的上传 RPC：字节随 content 一起发，host 收下后自己转成持久引用
    // （docs/gap-shapes.md §八）。限额自查在调用方（images.ts 的 checkImageLimits）。
    const content: RequestPayload<'session.prompt'>['content'] = [{ type: 'text', text }]
    for (const image of images) {
      content.push({ type: 'image', mediaType: image.mediaType, data: image.data, name: image.name })
    }
    const res = await this.client.call('session.prompt', {
      sessionId,
      mode: 'queue',
      content,
    })
    if (!res.ok) throw rpcFailure('session.prompt', res.error)
  }

  async removeQueuedMessage(sessionId: SessionId, itemId: string): Promise<void> {
    // `session.updateQueue` 的 action 是判别联合 edit/remove/steer（zod 报错逼出来的，
    // docs/gap-shapes.md §八）；edit 的其余字段还没打到，这里只做 remove。
    const res = await this.client.call('session.updateQueue', {
      sessionId,
      itemId: itemId as RequestPayload<'session.updateQueue'>['itemId'],
      action: { kind: 'remove' },
    })
    if (!res.ok) throw rpcFailure('session.updateQueue', res.error)
  }

  async listSkills(sessionId: SessionId): Promise<SkillEntry[]> {
    const res = await this.client.call('skill.list', { sessionId })
    if (!res.ok) throw rpcFailure('skill.list', res.error)
    return res.value.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      modelInvocable: skill.modelInvocable,
    }))
  }

  async cancel(sessionId: SessionId): Promise<void> {
    const res = await this.client.call('session.cancel', { sessionId })
    if (!res.ok) throw rpcFailure('session.cancel', res.error)
  }

  async listModels(sessionId: SessionId): Promise<SessionModels> {
    const res = await this.client.call('session.models', { sessionId })
    if (!res.ok) throw rpcFailure('session.models', res.error)
    // `current` 是这个会话模型选择的权威读数——顺手播种，footer/composer 立刻有数。
    const record = this.ensureRecord(sessionId)
    record.model = { provider: res.value.current.provider, model: res.value.current.model }
    this.refreshSummary(record)
    return res.value
  }

  async selectModel(sessionId: SessionId, provider: string, model: string): Promise<void> {
    const res = await this.client.call('session.selectModel', { sessionId, provider, model })
    if (!res.ok) throw rpcFailure('session.selectModel', res.error)
    const record = this.ensureRecord(sessionId)
    record.model = { provider: res.value.selected.provider, model: res.value.selected.model }
    this.refreshSummary(record)
  }

  async listPresets(): Promise<readonly AgentPresetEntry[]> {
    const res = await this.client.call('agentPreset.list', {})
    if (!res.ok) throw rpcFailure('agentPreset.list', res.error)
    return res.value.presets
  }

  async selectPreset(sessionId: SessionId, agentPreset: string): Promise<void> {
    // ⚠️ 载荷键是 `agentPreset`，不是 `presetId`——猜错过一次，实测确认（docs/gap-shapes.md §八）。
    const res = await this.client.call('agentPreset.select', { sessionId, agentPreset })
    if (!res.ok) throw rpcFailure('agentPreset.select', res.error)
    const record = this.ensureRecord(sessionId)
    record.agentPreset = res.value.agentPreset
    this.refreshSummary(record)
  }

  async renameSession(sessionId: SessionId, title: string): Promise<void> {
    const res = await this.client.call('session.rename', { sessionId, title })
    if (!res.ok) throw rpcFailure('session.rename', res.error)
    const record = this.ensureRecord(sessionId)
    // 上游注释：返回的 title/seq 就是给调用方 settle 投影格用的，不等 `session/projection` 推送帧。
    this.applyProjection(record, 'title', res.value.title, res.value.seq)
    this.refreshSummary(record)
  }

  async forkSession(sessionId: SessionId): Promise<SessionId> {
    const res = await this.client.call('session.fork', { sessionId })
    if (!res.ok) throw rpcFailure('session.fork', res.error)
    return res.value.sessionId
  }

  async listSessions(): Promise<readonly SessionListEntry[]> {
    const res = await this.client.call('session.list', {})
    if (!res.ok) throw rpcFailure('session.list', res.error)
    const entries: SessionListEntry[] = []
    for (const item of res.value.items) {
      // 顺手把记录刷到最新（与 rebaseline 同一条路径），再从记录里取标题。
      this.applyListItem(item)
      const record = this.records.get(item.sessionId)
      const titleCell = record?.projections.get('title')
      entries.push({
        sessionId: item.sessionId,
        updatedAt: item.updatedAt,
        running: item.running,
        blank: item.blank,
        ...(titleCell !== undefined && typeof titleCell.value === 'string'
          ? { title: titleCell.value }
          : {}),
        ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
        ...(item.agentPreset !== undefined ? { agentPreset: item.agentPreset } : {}),
      })
    }
    return entries
  }

  async searchSessions(query: string): Promise<readonly SessionId[] | undefined> {
    const res = await this.client.call('session.search', { query })
    // 部署关掉 search 时（实测 openAt "never"）返回业务错误而不是抛——
    // 两种都归一为 undefined：不可用，退回本地过滤。
    if (!res.ok) return undefined
    return res.value.items.map((item) => item.sessionId)
  }

  async answerApproval(sessionId: SessionId, outcome: ApprovalOutcome): Promise<void> {
    const record = this.records.get(sessionId)
    if (!record) return
    const entry = this.findPending(record, 'approval')
    if (!entry) return
    // 回显未决帧的 rpcId，绝不新铸；approvalId 是 host 侧审计关联。
    const receipt = await this.client.respond(entry.rpcId, {
      ok: true,
      value: { sessionId, approvalId: entry.approvalId, outcome },
    })
    if (receipt.accepted) {
      record.pending.delete(entry.rpcId)
      this.refreshSummary(record)
    }
  }

  async answerQuestion(sessionId: SessionId, answers: unknown): Promise<void> {
    const record = this.records.get(sessionId)
    if (!record) return
    const entry = this.findPending(record, 'question')
    if (!entry) return
    const receipt = await this.client.respond(entry.rpcId, {
      ok: true,
      value: { sessionId, answer: answers },
    })
    if (receipt.accepted) {
      record.pending.delete(entry.rpcId)
      this.refreshSummary(record)
    }
  }

  // ---- E 批：设置 / 凭证 / provider / 目标 ----

  async describeSettings(): Promise<SettingsOverview> {
    const res = await this.client.call('settings.describe', {})
    if (!res.ok) throw rpcFailure('settings.describe', res.error)
    return res.value
  }

  async openSettingsDocument(): Promise<void> {
    const res = await this.client.call('settings.openDocument', {})
    if (!res.ok) throw rpcFailure('settings.openDocument', res.error)
  }

  async mutateSetting(
    ns: string,
    ops: readonly SettingsPathOp[],
    expectedRevision: number,
  ): Promise<SettingsNamespace> {
    const res = await this.client.call('settings.mutate', { ns, ops: [...ops], expectedRevision })
    if (!res.ok) throw rpcFailure('settings.mutate', res.error)
    return res.value
  }

  // ⚠️ value 只在这一行越线（上游契约：credentials 域唯一的值通道）。
  // 不许 log、不许拼进错误消息——rpcFailure 只带 host 的 code/message，不含载荷。
  async setCredential(ref: string, value: string): Promise<void> {
    const res = await this.client.call('credentials.set', { ref, value })
    if (!res.ok) throw rpcFailure('credentials.set', res.error)
  }

  async unsetCredential(ref: string): Promise<void> {
    const res = await this.client.call('credentials.unset', { ref })
    if (!res.ok) throw rpcFailure('credentials.unset', res.error)
  }

  async listProviders(): Promise<readonly ProviderEntry[]> {
    const res = await this.client.call('llm.providers', {})
    if (!res.ok) throw rpcFailure('llm.providers', res.error)
    return res.value.providers
  }

  async listModelCatalog(): Promise<ModelCatalog> {
    const res = await this.client.call('llm.models', {})
    if (!res.ok) throw rpcFailure('llm.models', res.error)
    return res.value
  }

  async describeCredentials(): Promise<readonly CredentialRefState[]> {
    const [settings, providers] = await Promise.all([
      this.client.call('settings.describe', {}),
      this.client.call('llm.providers', {}),
    ])
    if (!settings.ok) throw rpcFailure('settings.describe', settings.error)
    if (!providers.ok) throw rpcFailure('llm.providers', providers.error)
    const refs = collectCredentialRefs(settings.value, providers.value.providers)
    if (refs.size === 0) return []
    const described = await this.client.call('credentials.describe', { refs: [...refs.keys()] })
    if (!described.ok) throw rpcFailure('credentials.describe', described.error)
    const out: CredentialRefState[] = []
    for (const [ref, holders] of refs) {
      const view = described.value.credentials[ref]
      out.push({
        ref,
        configured: view?.configured ?? false,
        ...(view?.source !== undefined ? { source: view.source } : {}),
        writable: view?.writable ?? false,
        holders,
      })
    }
    return out
  }

  goalOf(sessionId: SessionId): GoalInfo | undefined {
    const record = this.records.get(sessionId)
    const cell = record?.projections.get('goal')
    return parseGoalProjection(cell?.value)
  }

  async createGoal(sessionId: SessionId, objective: string): Promise<void> {
    const res = await this.client.call('goal.create', { sessionId, objective })
    if (!res.ok) throw rpcFailure('goal.create', res.error)
  }

  async pauseGoal(sessionId: SessionId): Promise<void> {
    await this.goalVerb('pause', sessionId)
  }

  async resumeGoal(sessionId: SessionId): Promise<void> {
    await this.goalVerb('resume', sessionId)
  }

  async completeGoal(sessionId: SessionId): Promise<void> {
    await this.goalVerb('complete', sessionId)
  }

  async clearGoal(sessionId: SessionId): Promise<void> {
    await this.goalVerb('clear', sessionId)
  }

  /**
   * ref 现读：revision 被模型的自动轮次持续推进，调用方存下来的任何旧 ref
   * 都会撞 GOAL_STALE_REVISION（实测，见 goal.ts 的注释）。
   */
  private async goalVerb(verb: 'pause' | 'resume' | 'complete' | 'clear', sessionId: SessionId): Promise<void> {
    const goal = this.goalOf(sessionId)
    if (goal === undefined) throw new Error(`goal.${verb}: 当前会话没有目标`)
    const payload = { sessionId, ref: { id: goal.id, revision: goal.revision } }
    const res =
      verb === 'pause'
        ? await this.client.call('goal.pause', payload)
        : verb === 'resume'
          ? await this.client.call('goal.resume', payload)
          : verb === 'complete'
            ? await this.client.call('goal.complete', payload)
            : await this.client.call('goal.clear', payload)
    if (!res.ok) throw rpcFailure(`goal.${verb}`, res.error)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const unsub of this.unsubs) unsub()
    for (const conv of this.conversations.values()) conv.dispose()
    this.listeners.clear()
  }

  // ---- 连接与基线 ----

  private onConnectionChange(state: ConnectionState): void {
    if (state.status === 'ready' && state.generation !== this.baselinedGeneration) {
      void this.rebaseline(state.generation)
    }
  }

  /**
   * generation 变化 = 连接重建。重连不做对账：
   * - 未决交互由 host 用同一 rpcId 重放，先清空等重放即可
   * - `blank` 与投影以 `session.list` 为权威基线
   * - 工作区以 `workspace.list` 为基线
   * - 打开着的会话视图流式状态是脏的，整段 reset 重取 history
   */
  private async rebaseline(generation: number): Promise<void> {
    this.baselinedGeneration = generation
    for (const record of this.records.values()) {
      if (record.pending.size > 0) {
        record.pending.clear()
        this.refreshSummary(record)
      }
    }
    for (const conv of this.conversations.values()) conv.reset()
    const [sessions, workspaces] = await Promise.all([
      this.client.call('session.list', {}),
      this.client.call('workspace.list', {}),
    ])
    if (this.disposed || generation !== this.baselinedGeneration) return
    if (sessions.ok) {
      for (const item of sessions.value.items) this.applyListItem(item)
    }
    if (workspaces.ok) {
      this.applyWorkspaceList(workspaces.value)
    }
    this.notify()
  }

  /** `session.list` 行是重连后的权威基线：`blank`、running、投影都按它播种。 */
  private applyListItem(item: SessionListItem): void {
    const record = this.ensureRecord(item.sessionId)
    record.blank = item.blank
    record.running = item.running
    delete record.error // list 基线是权威的，取代断线前粘住的 error
    if (item.cwd !== undefined) record.cwd = item.cwd
    if (item.parentSessionId !== undefined) record.parentSessionId = item.parentSessionId
    if (item.origin !== undefined) record.origin = item.origin
    if (item.agentPreset !== undefined) record.agentPreset = item.agentPreset
    if (item.projections) this.seedProjections(record, item.projections)
    this.refreshSummary(record)
  }

  private applyWorkspaceList(value: WorkspaceListValue): void {
    this.workspaceViews.clear()
    this.workspaceOrder = []
    for (const workspace of value.items) {
      this.workspaceOrder.push(workspace.workspaceId)
      this.workspaceViews.set(workspace.workspaceId, {
        workspaceId: workspace.workspaceId,
        title: workspace.title,
        path: workspace.path,
        sessionIds: workspace.sessionIds,
      })
    }
  }

  // ---- host 流 ----

  private onHostFrame(frame: HostFrame): void {
    switch (frame.type) {
      case 'host/session-added': {
        const record = this.ensureRecord(frame.sessionId)
        // 帧在 session/created 时就发，blank 恒为 true——原样收下，等 running:true 翻掉。
        record.blank = frame.blank
        if (frame.cwd !== undefined) record.cwd = frame.cwd
        if (frame.parentSessionId !== undefined) record.parentSessionId = frame.parentSessionId
        if (frame.origin !== undefined) record.origin = frame.origin
        if (frame.agentPreset !== undefined) record.agentPreset = frame.agentPreset
        this.refreshSummary(record)
        break
      }
      case 'host/session-removed': {
        this.records.delete(frame.sessionId)
        this.summaries.delete(frame.sessionId)
        const conv = this.conversations.get(frame.sessionId)
        if (conv) {
          conv.dispose()
          this.conversations.delete(frame.sessionId)
        }
        this.notify()
        break
      }
      case 'host/session-status': {
        const record = this.ensureRecord(frame.sessionId)
        record.running = frame.running
        delete record.error // 新的权威运行状态取代旧的 error
        if (frame.running) record.blank = false // blank 的会话从没跑过；跑过就不再 blank
        this.refreshSummary(record)
        break
      }
      case 'host/agent-error': {
        const record = this.ensureRecord(frame.sessionId)
        record.error = frame.message
        this.refreshSummary(record)
        this.conversations.get(frame.sessionId)?.onHostError(frame.message)
        break
      }
      case 'host/workspace-changed':
        this.upsertWorkspace(frame.workspace)
        this.notify()
        break
      case 'host/workspace-removed':
        this.workspaceViews.delete(frame.workspaceId)
        this.workspaceOrder = this.workspaceOrder.filter((id) => id !== frame.workspaceId)
        this.notify()
        break
      case 'host/workspace-order-changed': {
        const known = new Set(this.workspaceViews.keys())
        const ordered = frame.workspaceIds.filter((id) => known.has(id))
        const rest = this.workspaceOrder.filter((id) => known.has(id) && !frame.workspaceIds.includes(id))
        this.workspaceOrder = [...ordered, ...rest]
        this.notify()
        break
      }
      case 'host/archived-sessions-changed':
      case 'stream/error':
        // 归档集合不在 v1 的模型面内。
        break
      case 'host/remote-event':
        // host 转发的 cordis 事件（如 `commands/change`）：原样转给订阅者，
        // state 层不消费——它不属于会话模型面，属于「命令表变了，重取」这类信号。
        for (const listener of this.remoteEventListeners) listener(frame.event, frame.args)
        break
    }
  }

  // ---- mux 流 ----

  private onMuxFrame(frame: MuxFrame, rpcId: RpcId): void {
    switch (frame.type) {
      case 'session/event':
        this.conversations.get(frame.sessionId)?.onEvent(frame.event, frame.view)
        break
      case 'approval/requested': {
        const record = this.ensureRecord(frame.sessionId)
        record.pending.set(rpcId, {
          kind: 'approval',
          rpcId,
          approvalId: frame.approvalId,
          toolName: frame.toolName,
          ...(frame.callId !== undefined ? { callId: frame.callId } : {}),
          ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
        })
        this.refreshSummary(record)
        break
      }
      case 'approval/resolved': {
        const record = this.records.get(frame.sessionId)
        if (!record) break
        for (const [id, entry] of record.pending) {
          if (entry.kind === 'approval' && entry.approvalId === frame.approvalId) {
            record.pending.delete(id)
          }
        }
        this.refreshSummary(record)
        break
      }
      case 'question/requested': {
        const record = this.ensureRecord(frame.sessionId)
        record.pending.set(rpcId, { kind: 'question', rpcId, questions: frame.questions })
        this.refreshSummary(record)
        break
      }
      case 'question/resolved': {
        const record = this.records.get(frame.sessionId)
        if (!record) break
        record.pending.delete(frame.questionRpcId)
        this.refreshSummary(record)
        break
      }
      case 'session/projection': {
        const record = this.ensureRecord(frame.sessionId)
        if (this.applyProjection(record, frame.key, frame.value, frame.seq)) {
          this.refreshSummary(record)
        }
        break
      }
      case 'session/queue': {
        const record = this.ensureRecord(frame.sessionId)
        // 整份快照收敛：enqueue/mutation/claim/断线重连都靠同一份权威值。
        record.queue = frame.items
          .filter((item) => item.placement === 'queued')
          .map((item) => ({ id: item.id, text: queueText(item) }))
        this.refreshSummary(record)
        break
      }
      case 'session/jobs': {
        const record = this.ensureRecord(frame.sessionId)
        // 与 queue 同一条纪律：整份快照收敛，host 每次推的是全量视图。
        record.jobs = frame.jobs.map((job) => ({
          id: job.id,
          kind: job.kind,
          label: job.label,
          status: job.status,
          ...(job.detail !== undefined ? { detail: job.detail } : {}),
          startedAt: job.startedAt,
          ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
        }))
        this.refreshSummary(record)
        break
      }
      case 'session/subscribed':
      case 'stream/error':
        break
    }
  }

  // ---- 内部 ----

  private ensureRecord(sessionId: SessionId): SessionRecord {
    let record = this.records.get(sessionId)
    if (!record) {
      record = {
        sessionId,
        running: false,
        blank: true,
        pending: new Map(),
        projections: new Map(),
        queue: [],
        jobs: [],
        planModeSeen: false,
      }
      this.records.set(sessionId, record)
    }
    return record
  }

  private statusOf(record: SessionRecord): AgentStatus {
    // blocked 压过 working/idle：会话在跑又在等人时，UI 要显示它在等人。
    if (record.pending.size > 0) return 'blocked'
    if (record.error !== undefined) return 'error'
    return record.running ? 'working' : 'idle'
  }

  private pendingOf(record: SessionRecord): PendingInteraction | undefined {
    return record.pending.values().next().value
  }

  private findPending(record: SessionRecord, kind: 'approval'): Extract<PendingInteraction, { kind: 'approval' }> | undefined
  private findPending(record: SessionRecord, kind: 'question'): Extract<PendingInteraction, { kind: 'question' }> | undefined
  private findPending(record: SessionRecord, kind: PendingInteraction['kind']): PendingInteraction | undefined {
    for (const entry of record.pending.values()) {
      if (entry.kind === kind) return entry
    }
    return undefined
  }

  /** higher-seq-wins：旧 seq（含相等）不许覆盖新值。返回是否有变化。 */
  private applyProjection(record: SessionRecord, key: string, value: unknown, seq: number): boolean {
    const current = record.projections.get(key)
    if (current && current.seq >= seq) return false
    record.projections.set(key, { value, seq })
    return true
  }

  private seedProjections(record: SessionRecord, block: ProjectionsBlock): void {
    for (const key of Object.keys(block.values)) {
      this.applyProjection(record, key, (block.values as Record<string, unknown>)[key], block.asOfSeq)
    }
  }

  private refreshSummary(record: SessionRecord): void {
    const pending = this.pendingOf(record)
    const titleCell = record.projections.get('title')
    const title = titleCell && typeof titleCell.value === 'string' ? titleCell.value : undefined
    const summary: SessionSummary = {
      sessionId: record.sessionId,
      status: this.statusOf(record),
      blank: record.blank,
      ...(title !== undefined ? { title } : {}),
      ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
      ...(record.parentSessionId !== undefined ? { parentSessionId: record.parentSessionId } : {}),
      ...(record.origin !== undefined ? { origin: record.origin } : {}),
      ...(record.agentPreset !== undefined ? { agentPreset: record.agentPreset } : {}),
      ...(record.model !== undefined ? { model: record.model.model, provider: record.model.provider } : {}),
      ...(pending !== undefined ? { pending } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.queue.length > 0 ? { queue: record.queue } : {}),
      ...(record.jobs.length > 0 ? { jobs: record.jobs } : {}),
      ...(record.planModeSeen ? { planModeSeen: true as const } : {}),
    }
    this.summaries.set(record.sessionId, summary)
    this.notify()
    this.conversations.get(record.sessionId)?.syncStatus(summary.status, pending)
  }

  private upsertWorkspace(workspace: {
    workspaceId: WorkspaceId
    title: string
    path: string
    sessionIds: SessionId[]
  }): void {
    if (!this.workspaceViews.has(workspace.workspaceId)) this.workspaceOrder.push(workspace.workspaceId)
    this.workspaceViews.set(workspace.workspaceId, {
      workspaceId: workspace.workspaceId,
      title: workspace.title,
      path: workspace.path,
      sessionIds: workspace.sessionIds,
    })
  }

  private notify(): void {
    if (this.disposed) return
    for (const listener of this.listeners) listener()
  }
}

export function createState(options: CreateStateOptions): DshrState {
  return new DshrStateImpl(options.client)
}
