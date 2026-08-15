# dshr 架构

> 本文是架构真源。契约细节在 [`dsh-contract.md`](dsh-contract.md)，**先读那份**。
> 本文只回答：分几个包、每个包负责什么、包之间的接口长什么样。

## 一句话

**dshr 是 dsh 的第三个 surface：一个终端 client + herdr 形状的壳。**
服务端复用 dsh 自己的 host 平面（不重写），TUI 复用 dsh 的线协议（不 fork），
herdr 的形（工作区 / tab / pane / 活跃 agent 侧栏）由 dshr 自己实现。

```
┌─ dshr TUI (Ink) ────────────────────────────────┐
│  shell: tab bar / panes / sidebar / status line  │
│  tui:   conversation / composer / tool views     │   ← opencode 风格
├──────────────────────────────────────────────────┤
│  state:    会话与工作区的 headless 客户端模型      │
│  protocol: /api 线协议 carrier                    │
└───────────────────┬──────────────────────────────┘
                    │ POST /api/<method> + 两条下行流
┌───────────────────▼──────────────────────────────┐
│  dsh host 平面（**上游已有，dshr 不重写**）        │
│  workspace / sessions / subagents / approvals /   │
│  questions / jobs / projections / goals / skills  │
├──────────────────────────────────────────────────┤
│  dsh-base：agent loop / tools / sandbox / llm     │
└──────────────────────────────────────────────────┘
```

## 三条不可逆的形态纪律

1. **不 fork dsh，不改 dsh 本体。** dshr 的一切以 profile bundle + 插件的形式挂上去。
   上游是 developer preview，fork 的长期成本是跟它 diverge。
   每加一处能力先问：这能不能做成一个插件行、一个 host 服务、一个 client 包？
   能就不碰上游。确实缺原语时才考虑，且要留下证据。
2. **不依赖 herdr。** dshr 借 herdr 的**产品形状**，不借它的代码，也不做它的插件。
   两者是同类替代品，不是上下游。（herdr 是外部闭源依赖，herdgent 才是它的插件。）
3. **编排只提供动词，不提供语义。** 代码里出现 `Role` / `Workflow` / `Protocol` / `Template`
   这类**类型定义**就是越界；prompt 和 skill 里写满角色分工是正常的。
   这条是从 herdgent 搬过来的，理由见它的 AGENTS.md：SPQR v2 的 13k 行死在把语义固化成了类型。

## 包

单仓 pnpm workspace。**每个包的文件互不重叠**——这既是工程边界，也是并行开发的前提。

| 包 | 职责 | 依赖 |
|---|---|---|
| `@dshr/protocol` | dsh `/api` 线协议 carrier | 只依赖 `@deepseek-ai/dsh-host-apiproxy`（类型）与 `ws` |
| `@dshr/state` | headless 客户端模型：会话、工作区、状态、对话 | `@dshr/protocol` |
| `@dshr/tui` | 会话视图与输入框（opencode 风格） | `@dshr/state`, ink |
| `@dshr/shell` | tab / pane / 侧栏 / 状态行 | `@dshr/state`, `@dshr/tui`, ink |
| `@dshr/orchestrate` | 编排动词（dsh 工具插件） | dsh 插件 API |
| `@dshr/bundle` | dshr profile bundle（`cordis.patch.yml` + startup provider） | — |
| `dshr` (`packages/cli`) | `dshr` 可执行文件 | 以上全部 |

### `@dshr/protocol`

**唯一知道 HTTP 和 WebSocket 存在的地方。** 往上只暴露方法调用和异步帧流。

```ts
export interface DshrClientOptions {
  /** host 基址，例如 'http://127.0.0.1:39080' */
  baseUrl: string
  /** 可选：远程 attach 时的鉴权头。loopback 不需要。 */
  headers?: Record<string, string>
  /** 每次 unary 调用的超时，默认 30_000 */
  timeoutMs?: number
}

export type Unsubscribe = () => void

export interface DshrClient {
  /** 类型安全的 unary 调用。业务错误在返回值里，不 throw；只有载体故障才 throw。 */
  call<K extends keyof RpcMethodMap>(
    method: K,
    payload: RequestPayload<K>,
    signal?: AbortSignal,
  ): Promise<RpcResult<ResponseValue<K>>>

  /** 回答一个可应答的 ServerRequest（审批 / 提问）。 */
  respond(rpcId: RpcId, result: RpcResult<unknown>): Promise<RpcReceipt>

  /** 两条下行流。断线由 client 自己重建，消费者只看到帧。 */
  onHostFrame(listener: (frame: HostFrame, rpcId: RpcId) => void): Unsubscribe
  onMuxFrame(listener: (frame: MuxFrame, rpcId: RpcId) => void): Unsubscribe

  /** 连接代数。每次重建自增；消费者用它判断缓存是否作废。 */
  readonly generation: number
  onConnectionChange(listener: (s: ConnectionState) => void): Unsubscribe

  connect(): Promise<void>
  close(): Promise<void>
}

export type ConnectionState =
  | { status: 'connecting' }
  | { status: 'ready'; generation: number; host: HostDescription }
  | { status: 'lost'; generation: number; error?: RpcError }
  | { status: 'closed' }
```

必须做到的几条，每条都对应契约里一个已知行为：

- **readiness 握手**：两条下行流都开 **且** `host.describe` 成功，才算 `ready`。
  任一条流结束 → 当前 generation 失效 → 重建两条 → generation 自增。
- **重连不做对账**：重开流时 host 会重放每个会话的未决 `approval/requested`
  与 `question/requested`，且 `rpcId` 逐字复用。client 只要重开流 + 重取 history。
  **不要实现 `since` 续传**，v1 会忽略它。
- 每个 `/api` POST 必须带 `Content-Type: application/json`，否则 415。
- 业务错误在 `result.error`，**不要用 HTTP 状态判业务成败**。
- `rpcId` 由发起方铸造；应答只回显，永不新铸。

### `@dshr/state`

把帧流折叠成 UI 能直接渲染的模型。**不 import ink，不 import react。**
这条是硬边界：state 必须能在 node:test 里单测。

```ts
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'error'

export interface SessionSummary {
  sessionId: SessionId
  title?: string          // 来自 session/projection，不是单独的帧
  cwd?: string
  status: AgentStatus
  blank: boolean
  parentSessionId?: SessionId
  origin?: 'subagent'
  agentPreset?: string
  pending?: PendingInteraction   // blocked 的原因
}

export interface WorkspaceSummary {
  workspaceId: string
  title: string
  path: string
  sessionIds: SessionId[]
}

export interface DshrState {
  readonly sessions: ReadonlyMap<SessionId, SessionSummary>
  readonly workspaces: readonly WorkspaceSummary[]   // 按 host 的 durable 顺序
  conversation(sessionId: SessionId): ConversationView
  subscribe(listener: () => void): Unsubscribe

  createSession(input: { cwd: string; workspaceId?: string }): Promise<SessionId>
  prompt(sessionId: SessionId, text: string): Promise<void>
  cancel(sessionId: SessionId): Promise<void>
  answerApproval(sessionId: SessionId, outcome: ApprovalOutcome): Promise<void>
  answerQuestion(sessionId: SessionId, answers: unknown): Promise<void>
}
```

状态映射（**判据来自 host 的权威事件，不解析终端画面**）：

| `AgentStatus` | 判据 |
|---|---|
| `working` | `host/session-status{running:true}` |
| `idle` | `host/session-status{running:false}` |
| `blocked` | 该会话有未决的 `approval/requested` 或 `question/requested` |
| `error` | `host/agent-error` |

投影按 **higher-seq-wins** 存一份泛型 per-session 值表，由 `session.history` 尾页的
`projections` 块播种，之后由 `session/projection` 帧更新。标题就是其中一个键。

`host/session-added` 的 `blank` **恒为 true**（帧在 `session/created` 时就发），
client 在该会话第一次 `host/session-status{running:true}` 时把它翻掉；
重连时以 `session.list` 的 `summary.blank` 为准。

### `@dshr/tui` —— opencode 风格

视觉参照 opencode，**要点是克制**：

- 消息流用左侧竖线区分角色，不画框、不用背景色块
- 工具调用折叠成一行摘要（名字 + 关键参数 + 结果状态），展开才看详情
- 输入框在底部，一条细边框；`/` 触发命令，`@` 触发引用
- 状态行放模型、上下文用量、耗时——信息密度高，装饰为零
- 流式输出逐 token 追加，不整屏重绘

`ToolEventView` 是 host 算好的渲染意图（`for: 'call' | 'result'`），**优先用它**；
没有 view 时才回退到通用 JSON 卡片。

### `@dshr/shell` —— herdr 的形

- **一个 pane = 一个 dsh session。** 这是 dshr 与 herdr 的根本区别：
  herdr 的 pane 是任意终端，dshr 的 pane 是一个有身份、有状态、可寻址的 agent 会话。
- tab 承载一组 pane；工作区（`workspace`）承载一组 tab。
- 侧栏列工作区与活跃 agent，带实时 idle/working/blocked。
- **新建 tab 或 pane 默认就开一个 dsh 会话**（GG 的原始要求）。

### `@dshr/orchestrate`

动词，仅此而已：`spawn` / `send` / `wait` / `cancel` / `list`，加一个**可配置的硬上限**
（默认值可覆盖，运行时可调，工具里再钉一个绝对上界）。

上限这条是踩出来的教训（herdgent）：并行会话失控是静默的，所以闸门不能没有；
但每次编排规模不同，写死会挡住合理的大扇出。**存「人显式设过的值」，别把启动时写回的值
当成人设的**——两者无法区分会导致改默认值对所有跑过的仓库静默无效。

## 运行形态

```sh
dshr                      # 起（或连上）本机常驻 host，打开 TUI
dshr --port 39080         # 指定 host 端口
dshr --connect <url>      # attach 到已在跑的 host
dshr --resume <sessionId> # 直接打开某个会话
dshr server               # 只起 host，不开 TUI
```

会话强制落盘，所以 detach / attach / `--resume` 都是 host 那边天然就有的能力。

## 安全边界（不要越过）

- dsh 的 `/api` 信任栅栏**不是认证**，Web carrier 没有认证层，
  `--host 0.0.0.0` 是上游**故意**不支持的。
- **dshr 要做远程 attach 就必须自己加认证**，不能靠放宽 `trustedHosts`——那只是可达性策略。
  在认证层落地之前，dshr 的 host 只绑 loopback。
- 一批特权方法被钉死在 loopback，声明 `trustedHosts` 也够不着（见契约文档第二节）。
  远程 attach 的能力面天然就比本地小，UI 要如实反映，不要假装能用。

## 技术选型

- TypeScript，ESM（`"type": "module"`），`moduleResolution: NodeNext`
- Node **≥ 22**（`fetch` 与 `WebSocket` 都是内建；开发在 26 上）
- 渲染 Ink（React for terminal）——选它是因为 dsh 的 client 平面本来就是 React 心智，
  slot / store 那套能平移，而真正绑浏览器的只有 `dsh-client-ui-primitives`（react-dom/shiki/katex），
  那层正是我们要换掉的
- 测试用 node 内建 `node:test`，不引第三方框架
- 开发期不需要真 provider：把 `@deepseek-ai/dsh-llm-mock-server` 插进 profile 即可跑通全链路
