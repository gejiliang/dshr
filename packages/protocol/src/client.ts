/**
 * `@dshr/protocol` 的实现：dsh host `/api` 线协议的 Node carrier。
 *
 * 判据是 docs/dsh-contract.md（全部实测）与上游 `dsh-client-connection` 的浏览器
 * carrier（`WebApiClient` / `ConnectionController`）——本文件是那套行为在 Node 上
 * 的对应物：unary/respond 走 fetch，两条下行流走 `ws`，信封用 apiproxy 自带的
 * zod schema 做两级解析的第一级（信封级）。
 */
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type {
  RpcMethodMap,
  RequestPayload,
  ResponseValue,
} from '@deepseek-ai/dsh-host-apiproxy/api/rpc-map'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type {
  ClientRequest,
  ClientResponse,
  RpcError,
  RpcReceipt,
  RpcResult,
  ServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import {
  rpcReceiptSchema,
  serverRequestSchema,
  serverResponseSchema,
} from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import type { HostFrame, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api/events'
import type {
  ConnectionState,
  DshrClient,
  DshrClientOptions,
  HostDescription,
  Unsubscribe,
} from './types.js'

/**
 * 载体故障。`call` / `respond` / `connect` 只以它 reject——业务错误永远落在
 * `result.error` 里返回，不 throw。HTTP 状态码只描述载体（非 2xx → CarrierError）。
 */
export class CarrierError extends Error {
  override readonly name = 'CarrierError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RECONNECT_DELAY_MS = 10_000
const BACKOFF_BASE_MS = 500
const BACKOFF_FACTOR = 2

type StreamKind = 'mux' | 'host'
type MuxListener = (frame: MuxFrame, rpcId: RpcId) => void
type HostListener = (frame: HostFrame, rpcId: RpcId) => void
type ConnectionListener = (state: ConnectionState) => void

/** 一条下行流的运行句柄。`opened` 用 boolean 而不用 rejection，避免竞态下未观察的拒绝。 */
interface StreamHandle {
  readonly kind: StreamKind
  /** WS 握手完成 → true；开流前就结束了 → false。 */
  readonly opened: Promise<boolean>
  /** 流结束（close / 传输 error / `stream/error` 帧），带上游给的业务错误（若有）。 */
  readonly ended: Promise<{ error?: RpcError }>
  close(): void
}

interface ConnectSettlement {
  resolve(): void
  reject(error: unknown): void
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

/**
 * 创建 dsh host 的终端 client。readiness 握手与自动重连的语义见
 * `DshrClient` 与 docs/architecture.md 的「`@dshr/protocol`」节。
 */
export function createDshrClient(options: DshrClientOptions): DshrClient {
  return new DshrProtocolClient(options)
}

class DshrProtocolClient implements DshrClient {
  private readonly base: string
  private readonly headers: Record<string, string> | undefined
  private readonly timeoutMs: number
  private readonly maxReconnectDelayMs: number

  private readonly muxListeners = new Set<MuxListener>()
  private readonly hostListeners = new Set<HostListener>()
  private readonly connectionListeners = new Set<ConnectionListener>()

  /** close() 时 abort——所有未决 unary 调用随之以 CarrierError reject。 */
  private readonly closeController = new AbortController()

  private currentState: ConnectionState = { status: 'connecting' }
  private currentGeneration = 0
  private running = false
  private closed = false
  private everReady = false
  private connectPromise: Promise<void> | undefined
  private settlement: ConnectSettlement | undefined
  /** 当前 generation 的拆除闸：abort 即关掉这一代的两条流。 */
  private generationTeardown: AbortController | undefined
  private streams: StreamHandle[] = []
  /** 去重：同一 (status, generation) 的状态只通知一次。 */
  private lastEmittedKey = ''

  constructor(options: DshrClientOptions) {
    // new URL('/api/x', base) 要求 base 以 / 结尾，否则丢掉路径末段。
    this.base = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`
    this.headers = options.headers
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS
  }

  get state(): ConnectionState {
    return this.currentState
  }

  get generation(): number {
    return this.currentGeneration
  }

  async call<K extends keyof RpcMethodMap>(
    method: K,
    payload: RequestPayload<K>,
    signal?: AbortSignal,
  ): Promise<RpcResult<ResponseValue<K>>> {
    this.assertOpen()
    const rpcId = RpcId(randomUUID())
    const message: ClientRequest = { type: 'client-request', rpcId, method, payload }
    const body = await this.postJson(`/api/${method}`, message, signal)
    let full: ServerResponse
    try {
      full = serverResponseSchema.parse(body)
    } catch (cause) {
      throw new CarrierError(`malformed server-response for ${method}`, { cause })
    }
    if (full.rpcId !== rpcId) {
      throw new CarrierError(`rpcId mismatch for ${method}: sent ${rpcId}, got ${full.rpcId}`)
    }
    // 信封已校验；业务值的第二级解析留给消费方（上游契约的 payload 槽本来就是 unknown，
    // 对 developer preview 的漂移保持宽容是刻意的）。
    return full.result as RpcResult<ResponseValue<K>>
  }

  async respond(rpcId: RpcId, result: RpcResult<unknown>): Promise<RpcReceipt> {
    this.assertOpen()
    // rpcId 只回显，永不新铸。
    const message: ClientResponse = { type: 'client-response', rpcId, result }
    const body = await this.postJson('/api/respond', message)
    try {
      return rpcReceiptSchema.parse(body) as RpcReceipt
    } catch (cause) {
      throw new CarrierError('malformed respond receipt from /api/respond', { cause })
    }
  }

  onMuxFrame(listener: MuxListener): Unsubscribe {
    this.muxListeners.add(listener)
    return () => this.muxListeners.delete(listener)
  }

  onHostFrame(listener: HostListener): Unsubscribe {
    this.hostListeners.add(listener)
    return () => this.hostListeners.delete(listener)
  }

  onConnectionChange(listener: ConnectionListener): Unsubscribe {
    this.connectionListeners.add(listener)
    return () => this.connectionListeners.delete(listener)
  }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new CarrierError('client is closed'))
    this.connectPromise ??= new Promise<void>((resolve, reject) => {
      this.settlement = { resolve, reject }
      this.running = true
      void this.loop()
    })
    return this.connectPromise
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.running = false
    // 未决 unary 以载体故障 reject；当前 generation 的两条流拆掉。
    this.closeController.abort()
    this.generationTeardown?.abort()
    for (const stream of this.streams) stream.close()
    this.settlement?.reject(new CarrierError('client closed before ready'))
    this.settlement = undefined
    this.setState({ status: 'closed' })
  }

  // ── unary 载体 ──────────────────────────────────────────────

  private assertOpen(): void {
    if (this.closed) throw new CarrierError('client is closed')
  }

  /**
   * 两条 C→S 通道共用的 POST 腿：JSON body、必带 Content-Type（缺了 host 回 415）、
   * 默认超时与外部 signal 合并、非 2xx 一律视为载体故障 throw。
   */
  private async postJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const signals = [AbortSignal.timeout(this.timeoutMs), this.closeController.signal]
    if (signal) signals.push(signal)
    const merged = AbortSignal.any(signals)
    let response: Response
    try {
      response = await fetch(new URL(path, this.base), {
        method: 'POST',
        headers: { ...this.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: merged,
      })
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      throw new CarrierError(`transport failure for ${path}: ${reason}`, { cause })
    }
    if (!response.ok) {
      throw new CarrierError(`transport failure for ${path}: HTTP ${response.status}`)
    }
    try {
      return await response.json()
    } catch (cause) {
      throw new CarrierError(`non-JSON response body for ${path}`, { cause })
    }
  }

  // ── 下行流与连接代数 ─────────────────────────────────────────

  /**
   * connect → 握手 → pump → 断线重连的主循环。connect() 的 promise 在第一次
   * ready 时 resolve；首次握手失败则 reject 并停循环（之后可再调 connect()）。
   * ready 之后的断线进入指数退避重连，直到 close()。
   */
  private async loop(): Promise<void> {
    const settlement = this.settlement
    let attempt = 0
    while (this.running) {
      const teardown = new AbortController()
      this.generationTeardown = teardown
      try {
        const host = await this.handshake(teardown.signal)
        if (!this.running || teardown.signal.aborted) return
        this.currentGeneration += 1
        this.everReady = true
        attempt = 0
        this.setState({ status: 'ready', generation: this.currentGeneration, host })
        settlement?.resolve()
        // 任一条流结束都作废当前 generation。
        const loss = await Promise.race(this.streams.map((s) => s.ended))
        if (!this.running) return
        this.setState(
          loss.error
            ? { status: 'lost', generation: this.currentGeneration, error: loss.error }
            : { status: 'lost', generation: this.currentGeneration },
        )
      } catch (error) {
        if (!this.running) {
          settlement?.reject(error instanceof Error ? error : new CarrierError(String(error)))
          return
        }
        if (!this.everReady) {
          // 首次握手失败：reject connect() 并停下，不擅自重试。
          this.running = false
          settlement?.reject(error instanceof Error ? error : new CarrierError(String(error)))
          return
        }
        this.setState({ status: 'lost', generation: this.currentGeneration })
      } finally {
        teardown.abort()
        for (const stream of this.streams) stream.close()
        this.streams = []
      }
      attempt += 1
      await sleep(this.backoffDelay(attempt), this.closeController.signal)
    }
  }

  /**
   * readiness 握手：两条下行流都 open **且** `host.describe` 成功。
   * 不重传 `since`——v1 会忽略它，host 重开流时自动重放未决帧。
   */
  private async handshake(signal: AbortSignal): Promise<HostDescription> {
    const mux = this.openStream('mux', signal)
    const host = this.openStream('host', signal)
    this.streams = [mux, host]
    const [describe, muxOpened, hostOpened] = await Promise.all([
      this.call('host.describe', {}, signal),
      mux.opened,
      host.opened,
    ])
    if (!muxOpened || !hostOpened) {
      throw new CarrierError('event stream ended before readiness handshake completed')
    }
    if (!describe.ok) {
      const { code, message } = describe.error
      throw new CarrierError(`host.describe failed during readiness handshake: ${code}: ${message}`)
    }
    if (signal.aborted) throw new CarrierError('generation torn down during readiness handshake')
    return describe.value
  }

  /**
   * 开一条纯下行 WebSocket。每帧是 ServerRequest 信封（两级解析的第一级），
   * 业务帧在 `payload` 槽里过对应的 frame schema；解析不过的帧丢弃（一条坏帧
   * 不杀死整条流）。`stream/error` 帧是 host 判的流终止——按结束处理并带上错误。
   */
  private openStream(kind: StreamKind, signal: AbortSignal): StreamHandle {
    const path = kind === 'mux' ? '/api/events.mux' : '/api/events.host'
    const url = new URL(path, this.base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url, this.headers ? { headers: this.headers } : {})

    let settleOpened!: (opened: boolean) => void
    const opened = new Promise<boolean>((resolve) => {
      settleOpened = resolve
    })
    let settleEnded!: (result: { error?: RpcError }) => void
    const ended = new Promise<{ error?: RpcError }>((resolve) => {
      settleEnded = resolve
    })
    let isOpen = false
    let isEnded = false

    const end = (result: { error?: RpcError }) => {
      if (isEnded) return
      isEnded = true
      if (!isOpen) {
        isOpen = true
        settleOpened(false)
      }
      settleEnded(result)
    }
    const close = () => {
      if (isEnded) return
      if (socket.readyState === WebSocket.OPEN) socket.close()
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
    }

    socket.on('open', () => {
      if (isEnded) return
      isOpen = true
      settleOpened(true)
    })
    // ws 的 error 之后必跟 close，统一在 close 里结算；这里只吸收事件防止抛出。
    socket.on('error', () => {})
    socket.on('close', () => end({}))
    socket.on('message', (data: unknown) => {
      if (this.closed || isEnded) return
      let envelope
      try {
        const text =
          typeof data === 'string'
            ? data
            : Buffer.isBuffer(data)
              ? data.toString('utf8')
              : Array.isArray(data)
                ? Buffer.concat(data).toString('utf8')
                : null
        if (text === null) throw new Error('binary WebSocket frame')
        envelope = serverRequestSchema.parse(JSON.parse(text))
      } catch (error) {
        console.error(`[dshr/protocol] dropping malformed ${kind} envelope:`, error)
        return
      }
      let frame: MuxFrame | HostFrame
      try {
        frame = (kind === 'mux' ? muxFrameSchema : hostFrameSchema).parse(envelope.payload)
      } catch (error) {
        console.error(`[dshr/protocol] dropping malformed ${kind} frame:`, error)
        return
      }
      if (frame.type === 'stream/error') {
        end({ error: frame.error })
        close()
        return
      }
      this.dispatch(kind, frame, envelope.rpcId)
    })
    signal.addEventListener('abort', close, { once: true })

    return { kind, opened, ended, close }
  }

  /** 帧投递：监听者异常隔离，一个坏监听者不拖垮泵与重连语义。 */
  private dispatch(kind: StreamKind, frame: MuxFrame | HostFrame, rpcId: RpcId): void {
    if (this.closed) return
    const listeners = kind === 'mux' ? this.muxListeners : this.hostListeners
    for (const listener of listeners) {
      try {
        ;(listener as (frame: MuxFrame | HostFrame, rpcId: RpcId) => void)(frame, rpcId)
      } catch (error) {
        console.error('[dshr/protocol] frame listener threw:', error)
      }
    }
  }

  private setState(state: ConnectionState): void {
    if (this.closed && state.status !== 'closed') return
    const key = `${state.status}:${'generation' in state ? state.generation : '-'}`
    this.currentState = state
    if (key === this.lastEmittedKey) return
    this.lastEmittedKey = key
    for (const listener of this.connectionListeners) {
      try {
        listener(state)
      } catch (error) {
        console.error('[dshr/protocol] connection listener threw:', error)
      }
    }
  }

  /** 指数退避：base 500ms × 2^(attempt-1)，封顶 maxReconnectDelayMs，加 50% 抖动。 */
  private backoffDelay(attempt: number): number {
    const cap = Math.min(
      this.maxReconnectDelayMs,
      BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(0, attempt - 1),
    )
    return cap / 2 + Math.random() * (cap / 2)
  }
}
