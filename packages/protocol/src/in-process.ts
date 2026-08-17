/**
 * 进程内 carrier —— **不碰网络**。
 *
 * dshr 是 dsh 的 TUI 插件：默认形态是 `dsh --profile dshr` 一个进程、零端口，
 * host plane 与 TUI 在同一棵 cordis 树里。那种形态下没有 HTTP 也没有 WebSocket，
 * 但 `@dshr/state` 往上只认识 {@link DshrClient}，所以这里提供同一个接口的另一种实现。
 *
 * **上游把这条路铺好了，我们不自己造轮子**（2026-08-18 逐项核对）：
 *
 * - `toFetchHandler(ctx.apiProxy)` 把 host 的 dispatch 面包成一个 `fetch` 形状的函数
 * - `InProcessApiClient extends AbstractApiClient`，只覆盖 `doFetch`，其余全继承。
 *   上游注释原话：*"the isomorphic point: `new InProcessApiClient(toFetchHandler(api))`
 *   never touches the network"*
 * - ⚠️ **下行流不是 WebSocket**：`AbstractApiClient` 的 `openMux` / `openHost` 是
 *   **有默认实现的虚方法**，默认走 `readSse`（流式 fetch + `\n\n` 分帧）。
 *   `dsh-contract.md` 说的「两条 downlink WebSocket」是 web-app 那个部署的选择，
 *   不是客户端抽象的唯一形态。
 * - ⚠️ `callUnary(method, payload, signal)` 收的是**扁平方法名**（`'session.list'`），
 *   跟 `DshrClient.call` 同形。它是 `protected`，所以这里开一个子类把它暴露出来——
 *   **这样就不需要一张 52 条的「扁平名 → 分组方法」映射表**。
 */
import { InProcessApiClient, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { HostFrame, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api/events'
import type { RpcId, RpcReceipt, RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { RequestPayload, ResponseValue, RpcMethodMap } from '@deepseek-ai/dsh-host-apiproxy/api/rpc-map'
import type { ConnectionState, DshrClient, Unsubscribe } from './types.js'

/**
 * 把 `protected callUnary` 抬成公开方法。
 *
 * 唯一的存在理由就是这个——别往里加别的东西，加了就等于在客户端里长逻辑。
 */
class FlatApiClient extends InProcessApiClient {
  call<K extends keyof RpcMethodMap>(
    method: K,
    payload: RequestPayload<K>,
    signal?: AbortSignal,
  ): Promise<{ result: RpcResult<ResponseValue<K>> }> {
    return this.callUnary(method, payload, signal) as Promise<{ result: RpcResult<ResponseValue<K>> }>
  }
}

export interface InProcessClientOptions {
  /** host 的 dispatch 面。插件里就是 `ctx.apiProxy`（由 `api-gateway` 行提供）。 */
  readonly api: ApiProxy
  /** 单次 unary 调用超时，默认 30_000。 */
  readonly timeoutMs?: number
}

/**
 * 建一个进程内的 {@link DshrClient}。
 *
 * 与 `createDshrClient`（HTTP + WebSocket）是**平行的两个 carrier**，
 * 上层（`@dshr/state` 及以上）看不出区别——这正是 `--connect` 那条远程路
 * 能与插件形态共存的原因。
 */
export function createInProcessClient(options: InProcessClientOptions): DshrClient {
  const api = new FlatApiClient(toFetchHandler(options.api), options.timeoutMs)

  const hostListeners = new Set<(frame: HostFrame, rpcId: RpcId) => void>()
  const muxListeners = new Set<(frame: MuxFrame, rpcId: RpcId) => void>()
  const stateListeners = new Set<(state: ConnectionState) => void>()

  let state: ConnectionState = { status: 'connecting' }
  let generation = 0
  let downlinks: AbortController | null = null

  function setState(next: ConnectionState): void {
    state = next
    for (const listener of stateListeners) listener(next)
  }

  /**
   * 把一条下行 AsyncIterable 抽干，逐帧派发。
   *
   * 进程内没有「断线」这回事——迭代器结束就是 host 那边关了流（收尾中），
   * 所以**不重连**：重连是网络 carrier 的语义，在这里模拟它只会掩盖真实的收尾。
   */
  function pump<F>(
    stream: AsyncIterable<{ rpcId: RpcId; payload: F }>,
    dispatch: (frame: F, rpcId: RpcId) => void,
  ): void {
    void (async () => {
      try {
        for await (const request of stream) dispatch(request.payload, request.rpcId)
      } catch (error) {
        if (downlinks?.signal.aborted === true) return
        setState({ status: 'lost', generation, error: toRpcError(error) })
      }
    })()
  }

  function toRpcError(error: unknown): { code: 'internal'; message: string; details: {} } {
    return { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} }
  }

  return {
    async call(method, payload, signal) {
      const response = await api.call(method, payload, signal)
      return response.result
    },

    async respond(rpcId: RpcId, result: RpcResult<unknown>): Promise<RpcReceipt> {
      return api.respond({ type: 'client-response', rpcId, result } as never)
    },

    onHostFrame(listener) {
      hostListeners.add(listener)
      return (): void => void hostListeners.delete(listener)
    },

    onMuxFrame(listener) {
      muxListeners.add(listener)
      return (): void => void muxListeners.delete(listener)
    },

    onConnectionChange(listener): Unsubscribe {
      stateListeners.add(listener)
      return (): void => void stateListeners.delete(listener)
    },

    get state(): ConnectionState {
      return state
    },

    get generation(): number {
      return generation
    },

    async connect(): Promise<void> {
      if (downlinks !== null) return
      const controller = new AbortController()
      downlinks = controller
      generation += 1

      // 先把两条下行挂上再问 host.describe：反过来的话，握手到订阅之间的帧会漏。
      pump(api.events.host({}, controller.signal), (frame, rpcId) => {
        for (const listener of hostListeners) listener(frame, rpcId)
      })
      pump(api.events.mux({}, controller.signal), (frame, rpcId) => {
        for (const listener of muxListeners) listener(frame, rpcId)
      })

      const described = await api.call('host.describe', {})
      if (!described.result.ok) {
        controller.abort()
        downlinks = null
        setState({ status: 'lost', generation, error: described.result.error })
        throw new Error(`host.describe failed: ${described.result.error.code}: ${described.result.error.message}`)
      }
      setState({ status: 'ready', generation, host: described.result.value })
    },

    async close(): Promise<void> {
      downlinks?.abort()
      downlinks = null
      hostListeners.clear()
      muxListeners.clear()
      setState({ status: 'closed' })
      stateListeners.clear()
    },
  }
}
