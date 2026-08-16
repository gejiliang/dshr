/**
 * 会话视图：把 `session/event` 帧与 `session.history` 页折叠成
 * UI 能直接渲染的 `ConversationItem` 列表。
 *
 * 判据全部来自 host 的权威事件（见 docs/dsh-contract.md 第四、五节），
 * 不解析任何终端画面。
 */
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
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

type TextLikeBlock = Extract<ContentBlock, { type: 'text' | 'reasoning' }>

/**
 * 一趟顺序折叠。维护两类未决状态：
 * - 流式块：`assistant/chunk` 的 `data.chunk` 是原始 StreamChunk，拼装**不重写**——
 *   交给上游的 `BlockAssembler`（dsh-llm 导出的唯一共享实现），本类只做
 *   「块位置 → 视图项」的增量映射与 `streaming` 位维护
 * - `openCalls`：`tool/call` 与 `tool/result` 按 `callId` 配成一项
 *
 * 历史页与实时帧走同一个 fold——两者都是同一台 host 产生的同一事件流。
 */
class Fold {
  private openCalls = new Map<string, ToolItem>()
  /** 当前 step 的流式拼装状态；step/turn 边界重置。 */
  private assembler: BlockAssembler | null = null
  /** chunk.index 的首次出现顺序，与 BlockAssembler.blocks() 的位置一一对应。 */
  private indexOrder: number[] = []
  /** 与 blocks() 位置平行的视图项；tool-call 位置为 null（由 tool/call 事件镜像）。 */
  private streamItems: (StreamItem | null)[] = []

  constructor(
    private readonly items: ConversationItem[],
    private readonly onChange: () => void,
  ) {}

  push(event: SessionEvent, view: ToolEventView | undefined): void {
    switch (event.type) {
      case 'turn/start':
      case 'step/start':
        this.resetStepAssembly()
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

  /**
   * 把 `old` 换成 `next`——**换对象，不原地改**。
   *
   * ⚠️ 这条是踩出来的：UI 的行组件用 `React.memo` 按 `item` 做浅比较，
   * 原地改字段时对象引用不变，memo 直接跳过重渲染，画面永远停在第一次渲染的样子
   * （助手消息只剩一个流式光标，文字一个字都出不来）。**视图项必须当不可变值用。**
   */
  private replaceItem(old: StreamItem, next: StreamItem): void {
    const i = this.items.indexOf(old)
    if (i >= 0) this.items[i] = next
    const s = this.streamItems.indexOf(old)
    if (s >= 0) this.streamItems[s] = next
  }

  /** 轮次中止/结束时，未完的流式项定格（streaming 归假），拼装状态作废。 */
  private closeStreams(): void {
    for (const item of this.streamItems) {
      if (item && item.streaming) this.replaceItem(item, { ...item, streaming: false })
    }
    this.resetStepAssembly()
  }

  private resetStepAssembly(): void {
    this.assembler = null
    this.indexOrder = []
    this.streamItems = []
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
    // usage / finish 是账本与终止信号，不产生视图项（turn/end 负责终态）。
    if (chunk.type === 'usage' || chunk.type === 'finish') return
    const assembler = this.assembler ?? (this.assembler = new BlockAssembler())
    assembler.push(chunk)
    if (!this.indexOrder.includes(chunk.index)) this.indexOrder.push(chunk.index)
    const closedPos = chunk.type === 'block-end' ? this.indexOrder.indexOf(chunk.index) : -1
    const blocks = assembler.blocks()
    let changed = false
    for (let pos = 0; pos < blocks.length; pos++) {
      const block = blocks[pos]
      if (!block || (block.type !== 'text' && block.type !== 'reasoning')) continue
      const kind: StreamItem['kind'] = block.type === 'text' ? 'assistant' : 'reasoning'
      let item = this.streamItems[pos]
      if (!item) {
        const id = `s-${turn}-${step}-${pos}`
        item = kind === 'assistant'
          ? { kind, id, text: block.text, streaming: true }
          : { kind, id, text: block.text, streaming: true }
        this.streamItems[pos] = item
        this.items.push(item)
        changed = true
      } else if (item.text !== block.text) {
        const next = { ...item, text: block.text }
        this.replaceItem(item, next)
        item = next
        changed = true
      }
      if (pos === closedPos && item.streaming) {
        const next = { ...item, streaming: false }
        this.replaceItem(item, next)
        item = next
        changed = true
      }
    }
    if (changed) this.onChange()
  }

  private onAssistantMessage(event: Extract<SessionEvent, { type: 'assistant/message' }>): void {
    // 组装消息是这一步的终态：chunk 流立起来的项以它为权威收尾，不重复建项。
    const streamed = this.streamItems.filter((item): item is StreamItem => item !== null)
    if (streamed.length > 0) {
      const finals = event.data.message.content.filter(
        (block): block is TextLikeBlock => block.type === 'text' || block.type === 'reasoning',
      )
      for (let i = 0; i < streamed.length; i++) {
        const item = streamed[i]
        const final = finals[i]
        if (!item) continue
        const text =
          final && item.kind === (final.type === 'text' ? 'assistant' : 'reasoning')
            ? final.text
            : item.text
        if (item.streaming || text !== item.text) {
          this.replaceItem(item, { ...item, text, streaming: false })
        }
      }
    } else {
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
    this.resetStepAssembly()
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
      // 同样换对象而不是原地改——理由见 replaceItem 的注释。
      const next: ToolItem = {
        ...open,
        status: failed ? 'error' : 'ok',
        result: block.content,
        ...(view && view.for === 'result' ? { view } : {}),
      }
      const i = this.items.indexOf(open)
      if (i >= 0) this.items[i] = next
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

  /**
   * `status` / `pending` 由 state 在每次变化时同步进来（`syncStatus`）。
   * 它们是数据属性而不是 getter：exactOptionalPropertyTypes 下，
   * 返回 `T | undefined` 的 getter 实现不了可选属性 `pending?: T`。
   */
  status: AgentStatus = 'idle'
  pending?: PendingInteraction

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
