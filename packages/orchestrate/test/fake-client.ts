/**
 * 测试用假 DshrClient：不碰 HTTP/WebSocket，帧由测试手动喂入。
 *
 * 本文件只被 node --test 直接执行（Node 内建 type stripping），
 * 所以只用可擦除语法；对 '@dshr/protocol' 全部是 import type（运行期零解析）。
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
  RpcMethodMap,
  RpcReceipt,
  RpcResult,
  Unsubscribe,
} from '@dshr/protocol'

export interface RecordedCall {
  method: string
  payload: unknown
}

let rpcCounter = 0
export function fakeRpcId(label?: string): RpcId {
  rpcCounter += 1
  return `rpc-${label ?? 'x'}-${rpcCounter}` as RpcId
}

export class FakeDshrClient implements DshrClient {
  readonly calls: RecordedCall[] = []
  /** method → 下一次调用返回的业务错误（用一次即消耗）。 */
  private readonly failNext = new Map<string, RpcError>()
  private readonly hostListeners = new Set<(frame: HostFrame, rpcId: RpcId) => void>()
  private readonly muxListeners = new Set<(frame: MuxFrame, rpcId: RpcId) => void>()
  private readonly connListeners = new Set<(state: ConnectionState) => void>()
  private sessionCounter = 0

  readonly state: ConnectionState = {
    status: 'ready',
    generation: 1,
    host: {
      version: 'fake',
      cwd: '/tmp',
      provider: 'fake',
      model: 'fake',
      attachedSessions: 0,
      canOpenPath: false,
    },
  }
  readonly generation = 1

  /** 让下一次对 `method` 的调用返回业务错误。 */
  failCall(method: string, message: string): void {
    this.failNext.set(method, {
      code: 'internal',
      message,
      details: {},
    })
  }

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method)
  }

  call<K extends keyof RpcMethodMap>(
    method: K,
    payload: RequestPayload<K>,
    _signal?: AbortSignal,
  ): Promise<RpcResult<ResponseValue<K>>> {
    this.calls.push({ method, payload })
    const err = this.failNext.get(method)
    if (err) {
      this.failNext.delete(method)
      return Promise.resolve({ ok: false, error: err })
    }
    switch (method as string) {
      case 'session.create': {
        const p = payload as { cwd?: string; agentPreset?: string }
        this.sessionCounter += 1
        const sessionId = `sess-${this.sessionCounter}`
        const value = {
          sessionId,
          ...(p.agentPreset !== undefined ? { agentPreset: p.agentPreset } : {}),
        }
        return Promise.resolve({ ok: true, value: value as ResponseValue<K> })
      }
      case 'session.prompt':
      case 'session.cancel':
        return Promise.resolve({ ok: true, value: { accepted: true } as ResponseValue<K> })
      default:
        return Promise.reject(new Error(`fake client: unexpected call ${String(method)}`))
    }
  }

  respond(_rpcId: RpcId, _result: RpcResult<unknown>): Promise<RpcReceipt> {
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

  connect(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  // ---- 测试驱动面 ----

  emitHost(frame: HostFrame, rpcId?: RpcId): void {
    const id = rpcId ?? fakeRpcId('host')
    for (const l of this.hostListeners) l(frame, id)
  }

  emitMux(frame: MuxFrame, rpcId?: RpcId): void {
    const id = rpcId ?? fakeRpcId('mux')
    for (const l of this.muxListeners) l(frame, id)
  }
}
