/**
 * 会话视图：把 `session/event` 帧与 `session.history` 页折叠成
 * UI 能直接渲染的 `ConversationItem` 列表。
 *
 * 判据全部来自 host 的权威事件（见 docs/dsh-contract.md 第四、五节），
 * 不解析任何终端画面。
 */
import type { DshrClient, MuxFrame, ResponseValue } from '@dshr/protocol'
import type {
  AgentStatus,
  ConversationItem,
  ConversationView,
  PendingInteraction,
  SessionId,
  Unsubscribe,
} from './types.js'

type SessionEventFrame = Extract<MuxFrame, { type: 'session/event' }>
/** 上游 `SessionEvent`（`@deepseek-ai/dsh-session`），经帧类型结构取用，不新增依赖。 */
export type SessionEvent = SessionEventFrame['event']
/** host 算好的渲染意图，原样保留给 UI，本包不解释它。 */
export type ToolEventView = SessionEventFrame['view']

type HistoryPage = ResponseValue<'session.history'>
export type ProjectionsBlock = NonNullable<HistoryPage['projections']>

type StreamItem = Extract<ConversationItem, { kind: 'assistant' | 'reasoning' }>
type ToolItem = Extract<ConversationItem, { kind: 'tool' }>
type AssistantChunk = Extract<SessionEvent, { type: 'assistant/chunk' }>
type ContentBlock = Extract<SessionEvent, { type: 'assistant/message' }>['data']['message']['content'][number]

/**
 * 一趟顺序折叠。维护两类未决状态：
 * - `openBlocks`：流式块（`text-delta` / `reasoning-delta` 按 chunk.index 归并，`block-end` 收尾）
 * - `openCalls`：`tool/call` 与 `tool/result` 按 `callId` 配成一项
 *
 * 历史页与实时帧走同一个 fold——两者都是同一台 host 产生的同一事件流。
 */
class Fold {
  private openBlocks = new Map<number, StreamItem>()
  private openCalls = new Map<string, ToolItem>()
  /** 当前 step 里由 chunk 立起来的流式项；`assistant/message` 到达时收尾而不是重复建项。 */
  private streamedThisStep: StreamItem[] = []

  constructor(
    private readonly items: ConversationItem[],
    private readonly onChange: () => void,
  ) {}

  push(event: SessionEvent, view: ToolEventView | undefined): void {
    switch (event.type) {
      case 'turn/start':
      case 'step/start':
        this.openBlocks.clear()
        this.streamedThisStep = []
        break
      case 'turn/end':
        this.closeStreams()
        if (event.data.reason.kind === 'error') {
          this.items.push({ kind: 'error', id: `e-${event.seq}`, message: event.data.reason.error.message })
          this.onChange()
        }
        break
      case 'user/message':
        this.onUserMessage(event)
        break
      case 'assistant/chunk':
        this.onChunk(event)
        break
      case 'assistant/message':
        this.onAssistantMessage(event)
        break
      case 'tool/call':
        this.onToolCall(event, view)
        break
      case 'tool/result':
        this.onToolResult(event, view)
        break
      default:
        // 其余事件（todo/write、request/header、session/end-seed、插件扩展……）
        // 不产生会话视图项。
        break
    }
  }

  private closeStreams(): void {
    for (const item of this.openBlocks.values()) item.streaming = false
    this.openBlocks.clear()
    this.streamedThisStep = []
  }

  private onUserMessage(event: Extract<SessionEvent, { type: 'user/message' }>): void {
    const msg = event.data
    const source = msg.source
    if (source.kind === 'user') {
      // 人的提问（含 user-rpc 变体，kind 仍是 'user'）。图片块没有文本视图项，跳过。
      let text = ''
      for (const block of msg.content) {
        if (block.type === 'text') text = text === '' ? block.text : `${text}\n${block.text}`
      }
      this.items.push({ kind: 'user', id: msg.id, text })
      this.onChange()
    } else if (source.kind === 'plugin' && source.form === 'notice') {
      // 插件注入的一次性通告；instructions/catalog 等模型可见上下文不进会话视图。
      this.items.push({ kind: 'notice', id: msg.id, text: source.summary })
      this.onChange()
    }
  }

  private onChunk(event: AssistantChunk): void {
    const { turn, step, chunk } = event.data
    switch (chunk.type) {
      case 'text-delta':
        this.applyDelta(turn, step, chunk.index, 'assistant', chunk.text)
        break
      case 'reasoning-delta':
        this.applyDelta(turn, step, chunk.index, 'reasoning', chunk.text)
        break
      case 'block-end':
        this.applyBlockEnd(event.seq, chunk.index, chunk.block)
        break
      case 'block-start':
      case 'tool-call-delta':
      case 'usage':
      case 'finish':
        // tool-call-delta 不拼：`tool/call` 事件携带权威的整体调用。
        break
    }
  }

  private applyDelta(turn: number, step: number, index: number, kind: StreamItem['kind'], text: string): void {
    let item = this.openBlocks.get(index)
    if (item) {
      if (item.kind !== kind) return // 同一 index 的块类型错位（畸形流），忽略
    } else {
      const id = `s-${turn}-${step}-${index}`
      item = kind === 'assistant'
        ? { kind, id, text: '', streaming: true }
        : { kind, id, text: '', streaming: true }
      this.openBlocks.set(index, item)
      this.items.push(item)
      this.streamedThisStep.push(item)
    }
    item.text += text
    this.onChange()
  }

  private applyBlockEnd(seq: number, index: number, block: ContentBlock): void {
    const open = this.openBlocks.get(index)
    this.openBlocks.delete(index)
    if (block.type === 'text' || block.type === 'reasoning') {
      const kind: StreamItem['kind'] = block.type === 'text' ? 'assistant' : 'reasoning'
      if (open && open.kind === kind) {
        // block-end 携带组装好的整块，是权威终态。
        open.text = block.text
        open.streaming = false
      } else if (!open) {
        // delta-only 协议的兜底：没见过 delta 就直接用组装块建项。
        const id = `b-${seq}`
        const item: StreamItem = kind === 'assistant'
          ? { kind, id, text: block.text, streaming: false }
          : { kind, id, text: block.text, streaming: false }
        this.items.push(item)
      } else {
        open.streaming = false
      }
    } else if (open) {
      open.streaming = false
    }
    this.onChange()
  }

  private onAssistantMessage(event: Extract<SessionEvent, { type: 'assistant/message' }>): void {
    const hadStreamed = this.streamedThisStep.length > 0
    // 组装消息是这一步的终态：chunk 立起来的项收尾，不重复建项。
    this.closeStreams()
    if (!hadStreamed) {
      let i = 0
      for (const block of event.data.message.content) {
        if (block.type === 'text') {
          this.items.push({ kind: 'assistant', id: `a-${event.seq}-${i++}`, text: block.text, streaming: false })
        } else if (block.type === 'reasoning') {
          this.items.push({ kind: 'reasoning', id: `r-${event.seq}-${i++}`, text: block.text, streaming: false })
        }
        // tool-call 块由独立的 tool/call 事件镜像，这里跳过。
      }
    }
    this.onChange()
  }

  private onToolCall(event: Extract<SessionEvent, { type: 'tool/call' }>, view: ToolEventView | undefined): void {
    const { callId, name, arguments: args } = event.data
    const item: ToolItem = {
      kind: 'tool',
      id: `t-${callId}`,
      callId,
      name,
      status: 'running',
      args,
      ...(view && view.for === 'call' ? { view } : {}),
    }
    this.openCalls.set(callId, item)
    this.items.push(item)
    this.onChange()
  }

  private onToolResult(event: Extract<SessionEvent, { type: 'tool/result' }>, view: ToolEventView | undefined): void {
    const block = event.data.message.content[0]
    if (!block) return
    const callId = block.toolCallId
    const failed = event.data.error !== undefined || block.isError === true
    const open = this.openCalls.get(callId)
    if (open) {
      this.openCalls.delete(callId)
      open.status = failed ? 'error' : 'ok'
      open.result = block.content
      if (view && view.for === 'result') open.view = view
    } else {
      // 页边界外的孤儿 result（fold 范围内没见过它的 call）：补一条已完成项。
      this.items.push({
        kind: 'tool',
        id: `t-${callId}`,
        callId,
        name: '',
        status: failed ? 'error' : 'ok',
        result: block.content,
        ...(view && view.for === 'result' ? { view } : {}),
      })
    }
    this.onChange()
  }
}

export interface ConversationDeps {
  getStatus(): AgentStatus
  getPending(): PendingInteraction | undefined
  /** history 尾页（只有尾页）携带的投影基线块，交给 state 按 higher-seq-wins 播种。 */
  onProjections(block: ProjectionsBlock): void
}

export class Conversation implements ConversationView {
  readonly sessionId: SessionId

  private itemsArr: ConversationItem[] = []
  private fold = new Fold(this.itemsArr, () => this.notify())
  private listeners = new Set<() => void>()
  private initialized = false
  private disposed = false
  private buffered: { event: SessionEvent; view: ToolEventView | undefined }[] = []
  private lastSeq = -1
  private oldestSeq: number | null = null
  private hasOlderFlag = false
  private loadingOlder = false
  private resetEpoch = 0
  private hostErrorCount = 0

  constructor(
    private readonly client: DshrClient,
    sessionId: SessionId,
    private readonly deps: ConversationDeps,
  ) {
    this.sessionId = sessionId
    void this.init()
  }

  get items(): readonly ConversationItem[] {
    return this.itemsArr
  }

  get hasOlder(): boolean {
    return this.hasOlderFlag
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** state 侧的状态/未决交互变化，同步字段并通知本视图的订阅者。 */
  syncStatus(status: AgentStatus, pending: PendingInteraction | undefined): void {
    this.status = status
    if (pending === undefined) {
      delete this.pending
    } else {
      this.pending = pending
    }
    this.notify()
  }

  /** mux 的 `session/event` 帧。初始化完成前先缓冲，之后按 seq 去重放行。 */
  onEvent(event: SessionEvent, view: ToolEventView | undefined): void {
    if (this.disposed) return
    if (!this.initialized) {
      this.buffered.push({ event, view })
      return
    }
    // history 尾页已含此刻的 in-flight partial；seq 不高于水位的帧是重复的。
    if (event.seq <= this.lastSeq) return
    this.trackSeq(event.seq)
    this.fold.push(event, view)
  }

  /** `host/agent-error` 是没有轮次位置的实时失败的唯一出口，进会话视图。 */
  onHostError(message: string): void {
    if (this.disposed) return
    this.itemsArr.push({ kind: 'error', id: `host-err-${this.hostErrorCount++}`, message })
    this.notify()
  }

  /** generation 失效：流式拼接状态是脏的，整段作废重取（host 会重放未决交互）。 */
  reset(): void {
    if (this.disposed) return
    this.resetEpoch++
    this.itemsArr = []
    this.fold = new Fold(this.itemsArr, () => this.notify())
    this.buffered = []
    this.initialized = false
    this.lastSeq = -1
    this.oldestSeq = null
    this.hasOlderFlag = false
    void this.init()
  }

  async loadOlder(): Promise<void> {
    if (this.disposed || !this.initialized || this.loadingOlder || !this.hasOlderFlag || this.oldestSeq === null) {
      return
    }
    this.loadingOlder = true
    const epoch = this.resetEpoch
    try {
      const res = await this.client.call('session.history', {
        sessionId: this.sessionId,
        beforeSeq: this.oldestSeq,
      })
      if (this.disposed || epoch !== this.resetEpoch) return
      if (!res.ok) return // 保持 hasOlder 原状，调用方可以重试
      // loadOlder 的页不带 projections 块——这里只折事件，不碰投影。
      const pageItems: ConversationItem[] = []
      const pageFold = new Fold(pageItems, () => {})
      for (const entry of res.value.events) {
        if (this.oldestSeq === null || entry.event.seq < this.oldestSeq) this.oldestSeq = entry.event.seq
        pageFold.push(entry.event, entry.view)
      }
      if (pageItems.length > 0) this.itemsArr.unshift(...pageItems)
      this.hasOlderFlag = res.value.hasMore
      this.notify()
    } finally {
      this.loadingOlder = false
    }
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  private async init(): Promise<void> {
    const epoch = this.resetEpoch
    const generation = this.client.generation
    let res: Awaited<ReturnType<DshrClient['call']>> | undefined
    try {
      res = await this.client.call('session.history', { sessionId: this.sessionId })
    } catch {
      res = undefined
    }
    if (this.disposed || epoch !== this.resetEpoch) return
    // 等待期间连接又重建了：这次拉取基于旧连接，作废；generation 变化会触发 reset 重取。
    if (generation !== this.client.generation) return
    this.initialized = true
    if (res && res.ok) {
      for (const entry of res.value.events) {
        this.trackSeq(entry.event.seq)
        this.fold.push(entry.event, entry.view)
      }
      if (res.value.projections) this.deps.onProjections(res.value.projections)
      this.hasOlderFlag = res.value.hasMore
    } else {
      const message = res && !res.ok ? `${res.error.code}: ${res.error.message}` : 'history request failed'
      this.itemsArr.push({ kind: 'error', id: 'history-error', message })
    }
    const buffered = this.buffered
    this.buffered = []
    for (const frame of buffered) {
      if (frame.event.seq <= this.lastSeq) continue
      this.trackSeq(frame.event.seq)
      this.fold.push(frame.event, frame.view)
    }
    this.notify()
  }

  private trackSeq(seq: number): void {
    if (seq > this.lastSeq) this.lastSeq = seq
    if (this.oldestSeq === null || seq < this.oldestSeq) this.oldestSeq = seq
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
