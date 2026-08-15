/**
 * 测试夹具：一个假的 `DshrClient`（手工喂帧，不连真 host），
 * 加上 SessionEvent / 帧的构造器。品牌 id 用 `as` 铸造——与上游自己的
 * 工厂函数一样，品牌只是编译期标记，运行时就是字符串。
 */
import type {
  ConnectionState,
  DshrClient,
  HostFrame,
  MuxFrame,
  RequestPayload,
  ResponseValue,
  RpcId,
  RpcMethodMap,
  RpcResult,
  RpcReceipt,
  Unsubscribe,
} from '@dshr/protocol'
import type { SessionId } from '@dshr/state'

export type SessionEvent = Extract<MuxFrame, { type: 'session/event' }>['event']
export type ToolEventView = Extract<MuxFrame, { type: 'session/event' }>['view']
export type HistoryEntry = ResponseValue<'session.history'>['events'][number]
export type ProjectionsBlock = NonNullable<ResponseValue<'session.history'>['projections']>
export type SessionListItem = ResponseValue<'session.list'>['items'][number]
export type WorkspaceViewItem = ResponseValue<'workspace.list'>['items'][number]

export const sid = (raw: string): SessionId => raw as SessionId
export const rid = (raw: string): RpcId => raw as RpcId
export const ok = <T>(value: T): RpcResult<T> => ({ ok: true, value })

/** 等 fake 里所有已 resolve 的 promise 链沉底。 */
export async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve))
}

export class FakeClient implements DshrClient {
  state: ConnectionState = { status: 'connecting' }
  generation = 0
  readonly calls: { method: string; payload: unknown }[] = []
  readonly responses: { rpcId: RpcId; result: RpcResult<unknown> }[] = []

  private readonly handlers = new Map<string, (payload: unknown) => unknown>()
  private readonly hostListeners = new Set<(frame: HostFrame, rpcId: RpcId) => void>()
  private readonly muxListeners = new Set<(frame: MuxFrame, rpcId: RpcId) => void>()
  private readonly connListeners = new Set<(state: ConnectionState) => void>()

  onCall<K extends keyof RpcMethodMap>(
    method: K,
    handler: (payload: RequestPayload<K>) => RpcResult<ResponseValue<K>>,
  ): void {
    this.handlers.set(String(method), handler as (payload: unknown) => unknown)
  }

  /** 两条重连基线一起打桩。 */
  stubBaseline(sessions: SessionListItem[] = [], workspaces: WorkspaceViewItem[] = []): void {
    this.onCall('session.list', () => ok({ items: sessions }))
    this.onCall('workspace.list', () => ok({ items: workspaces, archivedSessionIds: [] }))
  }

  call<K extends keyof RpcMethodMap>(
    method: K,
    payload: RequestPayload<K>,
    _signal?: AbortSignal,
  ): Promise<RpcResult<ResponseValue<K>>> {
    this.calls.push({ method: String(method), payload })
    const handler = this.handlers.get(String(method))
    if (!handler) return Promise.reject(new Error(`FakeClient: no handler for ${String(method)}`))
    return Promise.resolve(handler(payload) as RpcResult<ResponseValue<K>>)
  }

  respond(rpcId: RpcId, result: RpcResult<unknown>): Promise<RpcReceipt> {
    this.responses.push({ rpcId, result })
    return Promise.resolve({ accepted: true })
  }

  onHostFrame(listener: (frame: HostFrame, rpcId: RpcId) => void): Unsubscribe {
    this.hostListeners.add(listener)
    return () => this.hostListeners.delete(listener)
  }

  onMuxFrame(listener: (frame: MuxFrame, rpcId: RpcId) => void): Unsubscribe {
    this.muxListeners.add(listener)
    return () => this.muxListeners.delete(listener)
  }

  onConnectionChange(listener: (state: ConnectionState) => void): Unsubscribe {
    this.connListeners.add(listener)
    return () => this.connListeners.delete(listener)
  }

  emitHost(frame: HostFrame, rpcId: RpcId = rid('host-push')): void {
    for (const listener of this.hostListeners) listener(frame, rpcId)
  }

  emitMux(frame: MuxFrame, rpcId: RpcId = rid('mux-push')): void {
    for (const listener of this.muxListeners) listener(frame, rpcId)
  }

  /** 连接重建：generation 自增并宣布 ready。 */
  setReady(generation: number): void {
    this.generation = generation
    this.state = {
      status: 'ready',
      generation,
      host: { version: '0.0.1', cwd: '/tmp', provider: 'mock', model: 'mock', attachedSessions: 0, canOpenPath: false },
    }
    for (const listener of this.connListeners) listener(this.state)
  }

  connect(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

// ---- SessionEvent 构造器 ----

export function userMessage(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 1_000 + seq,
    data: {
      id: `m-${seq}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  } as SessionEvent
}

export function chunk(seq: number, turn: number, step: number, c: Record<string, unknown>): SessionEvent {
  return { type: 'assistant/chunk', seq, time: 1_000 + seq, data: { turn, step, chunk: c } } as SessionEvent
}

export function textDelta(seq: number, text: string, index = 0, turn = 1, step = 1): SessionEvent {
  return chunk(seq, turn, step, { type: 'text-delta', index, text })
}

export function reasoningDelta(seq: number, text: string, index = 1, turn = 1, step = 1): SessionEvent {
  return chunk(seq, turn, step, { type: 'reasoning-delta', index, text })
}

export function blockEnd(seq: number, index: number, block: Record<string, unknown>, turn = 1, step = 1): SessionEvent {
  return chunk(seq, turn, step, { type: 'block-end', index, block })
}

export function assistantMessage(seq: number, blocks: Record<string, unknown>[], turn = 1, step = 1): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: 1_000 + seq,
    data: {
      turn,
      step,
      message: { id: `m-${seq}`, role: 'assistant', content: blocks, source: { kind: 'model', provider: 'mock', model: 'mock' } },
    },
  } as SessionEvent
}

export function toolCall(seq: number, callId: string, name: string, args: string): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: 1_000 + seq,
    data: { turn: 1, step: 1, callId, name, arguments: args },
  } as SessionEvent
}

export function toolResult(seq: number, callId: string, text: string, withError = false): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: 1_000 + seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `m-${seq}`,
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], ...(withError ? { isError: true } : {}) }],
        source: { kind: 'tool', callId },
      },
      ...(withError ? { error: { name: 'ToolError', code: 'FAILED' } } : {}),
    },
  } as SessionEvent
}

/** mux 的 session/event 帧。 */
export function eventFrame(sessionId: SessionId, event: SessionEvent, view?: ToolEventView): MuxFrame {
  return { type: 'session/event', sessionId, event, ...(view ? { view } : {}) } as MuxFrame
}

export function entry(event: SessionEvent, view?: ToolEventView): HistoryEntry {
  return { event, ...(view ? { view } : {}) } as HistoryEntry
}

export function listItem(sessionId: SessionId, over: Partial<SessionListItem> = {}): SessionListItem {
  return { sessionId, updatedAt: 1, running: false, blank: true, ...over } as SessionListItem
}
