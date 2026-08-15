/**
 * 测试用的假 host：node:http + ws，完全在进程内。
 * 只复刻线协议载体（信封、回执、两条纯下行 WebSocket），不模拟任何业务语义。
 *
 * 注意：测试 import 的是构建产物 ../lib——先 `npx tsc --build packages/protocol` 再跑测试。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'

export interface CapturedPost {
  path: string
  contentType: string | undefined
  body: unknown
}

export interface FakeHostOptions {
  /** 按 method 定制 unary 响应的 result（默认回 ok:{}）。 */
  onUnary?: (method: string, payload: unknown) => unknown
  /** 定制 /api/respond 的回执（默认 {accepted:true}）。 */
  onRespond?: (rpcId: unknown, result: unknown) => unknown
  /** 定制 unary 的 HTTP 状态码与原始 body（测载体故障；默认 200 + JSON 信封）。 */
  unaryHttp?: { status: number; rawBody: string }
  /** unary 响应前挂起（测 close() 拒绝未决调用）。 */
  hangUnary?: boolean
}

export class FakeHost {
  readonly posts: CapturedPost[] = []
  readonly muxSockets: WebSocket[] = []
  readonly hostSockets: WebSocket[] = []
  private readonly server: http.Server
  private readonly wss: WebSocketServer
  private readonly pendingResponses: http.ServerResponse[] = []

  private constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res))
    this.wss = new WebSocketServer({ noServer: true })
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url === '/api/events.mux' || req.url === '/api/events.host') {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          ;(req.url === '/api/events.mux' ? this.muxSockets : this.hostSockets).push(ws)
        })
      } else {
        socket.destroy()
      }
    })
  }

  options: FakeHostOptions = {}

  static async start(options: FakeHostOptions = {}): Promise<FakeHost> {
    const host = new FakeHost()
    host.options = options
    await new Promise<void>((resolve) => host.server.listen(0, '127.0.0.1', resolve))
    return host
  }

  get baseUrl(): string {
    const { port } = this.server.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  /** 往一条下行流推一帧 ServerRequest 信封。 */
  pushMux(payload: unknown, rpcId = 'srv-push'): void {
    this.push(this.muxSockets, payload, rpcId)
  }

  pushHost(payload: unknown, rpcId = 'srv-push'): void {
    this.push(this.hostSockets, payload, rpcId)
  }

  private push(sockets: WebSocket[], payload: unknown, rpcId: string): void {
    const frame = JSON.stringify({ type: 'server-request', rpcId, method: 'events.push', payload })
    for (const ws of sockets) ws.send(frame)
  }

  /** 模拟断线：关掉当前两条流的所有 socket。 */
  dropStreams(): void {
    for (const ws of [...this.muxSockets, ...this.hostSockets]) ws.terminate()
  }

  async close(): Promise<void> {
    for (const res of this.pendingResponses.splice(0)) res.destroy()
    for (const ws of [...this.muxSockets, ...this.hostSockets]) ws.terminate()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    )
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        body = undefined
      }
      const url = req.url ?? ''
      if (url === '/api/respond') {
        const msg = body as { rpcId?: unknown; result?: unknown } | undefined
        const receipt = this.options.onRespond
          ? this.options.onRespond(msg?.rpcId, msg?.result)
          : { accepted: true }
        this.posts.push({ path: url, contentType: req.headers['content-type'], body })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(receipt))
        return
      }
      if (url.startsWith('/api/')) {
        const method = url.slice('/api/'.length)
        const msg = body as { rpcId?: unknown; payload?: unknown } | undefined
        this.posts.push({ path: url, contentType: req.headers['content-type'], body })
        if (this.options.hangUnary) {
          this.pendingResponses.push(res)
          return
        }
        if (this.options.unaryHttp) {
          res.writeHead(this.options.unaryHttp.status, { 'content-type': 'text/plain' })
          res.end(this.options.unaryHttp.rawBody)
          return
        }
        const result = this.options.onUnary
          ? this.options.onUnary(method, msg?.payload)
          : { ok: true, value: {} }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: msg?.rpcId, result }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  }
}

/** 等一个条件成立，超时即失败。 */
export async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5_000, intervalMs = 10, label = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`timed out waiting for: ${label}`)
}
