/**
 * `@dshr/protocol` 的公开契约。
 *
 * 这个文件是**跨包接口的真源**：`@dshr/state` 只认这里的形状，不认实现细节。
 * 实现可以换，这个文件的签名不能随手改——改了要同步改 docs/architecture.md。
 *
 * 线协议本身的判据在 docs/dsh-contract.md，全部实测过。
 */
import type {
  RpcMethodMap,
  RequestPayload,
  ResponseValue,
} from '@deepseek-ai/dsh-host-apiproxy/api/rpc-map'
import type { RpcError, RpcId, RpcResult, RpcReceipt } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { HostFrame, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api/events'

export type { RpcMethodMap, RequestPayload, ResponseValue, RpcError, RpcId, RpcResult, RpcReceipt }
export type { HostFrame, MuxFrame }

export type Unsubscribe = () => void

/** `host.describe` 的返回值，readiness 握手时拿到。 */
export interface HostDescription {
  version: string
  cwd: string
  provider: string
  model: string
  attachedSessions: number
  canOpenPath: boolean
}

/**
 * 连接状态。`generation` 每次重建下行流时自增——消费者用它判断缓存是否作废。
 *
 * readiness 的判据是三件事同时成立：`events.mux` 开、`events.host` 开、
 * `host.describe` 成功。任一条流结束都让当前 generation 失效。
 */
export type ConnectionState =
  | { status: 'connecting' }
  | { status: 'ready'; generation: number; host: HostDescription }
  | { status: 'lost'; generation: number; error?: RpcError }
  | { status: 'closed' }

export interface DshrClientOptions {
  /** host 基址，例如 `http://127.0.0.1:39080`。 */
  baseUrl: string
  /**
   * 远程 attach 时附加的请求头。loopback 不需要。
   *
   * ⚠️ dsh 的 `/api` 信任栅栏**不是认证**。远程 attach 的认证是 dshr 自己的责任，
   * 放宽 `trustedHosts` 不算认证。见 docs/dsh-contract.md 第二节。
   */
  headers?: Record<string, string>
  /** 单次 unary 调用超时，默认 30_000。 */
  timeoutMs?: number
  /** 下行流断开后的重连退避上界，默认 10_000。 */
  maxReconnectDelayMs?: number
}

/**
 * dsh host 的终端 client。
 *
 * **唯一知道 HTTP 与 WebSocket 存在的地方。** 往上只暴露方法调用与帧流。
 */
export interface DshrClient {
  /**
   * 类型安全的 unary 调用：`POST /api/<method>`。
   *
   * 业务错误落在返回值的 `result.error` 里，**不 throw**；只有载体故障
   * （网络断、超时、非 JSON 响应）才 throw。不要用 HTTP 状态判业务成败。
   */
  call<K extends keyof RpcMethodMap>(
    method: K,
    payload: RequestPayload<K>,
    signal?: AbortSignal,
  ): Promise<RpcResult<ResponseValue<K>>>

  /**
   * 回答一个可应答的 ServerRequest（审批 / 提问）：`POST /api/respond`。
   * `rpcId` 只回显，永不新铸。响应是回执而非 RpcMessage。
   */
  respond(rpcId: RpcId, result: RpcResult<unknown>): Promise<RpcReceipt>

  /** `events.host` 下行帧。 */
  onHostFrame(listener: (frame: HostFrame, rpcId: RpcId) => void): Unsubscribe
  /** `events.mux` 下行帧。 */
  onMuxFrame(listener: (frame: MuxFrame, rpcId: RpcId) => void): Unsubscribe

  onConnectionChange(listener: (state: ConnectionState) => void): Unsubscribe

  readonly state: ConnectionState
  readonly generation: number

  /** 建连并完成 readiness 握手。失败时 reject。 */
  connect(): Promise<void>
  close(): Promise<void>
}
