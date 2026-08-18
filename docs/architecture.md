# dshr 架构

> 本文是架构真源。契约细节在 [`dsh-contract.md`](dsh-contract.md)，**先读那份**。
> 本文只回答：分几个包、每个包负责什么、包之间的接口长什么样。

## 一句话

**dshr 是 dsh 的第三个 surface：一个终端会话的 TUI，跑在 herdr 的 pane 里。**
服务端复用 dsh 自己的 host 平面（不重写），协议复用 dsh 的线协议（不 fork），
**工作区 / tab / pane / 活跃 agent 侧栏全部由 herdr 提供**（不复刻）。

> ⚠️ **曾经的方向性错误**：最初做了一个 `@dshr/shell` 把 herdr 的整套外壳
> （tab、pane、侧栏、键位、覆盖层）复刻了一遍——那是在 herdr 旁边造一个更差的 herdr。
> 2026-08-16 整包删除。要看它长什么样：`git log -- packages/shell`。
>
> 正确的形态是：**一个 herdr pane = 一个 dshr 进程 = 一个 dsh 会话**。
> 想让每个新 pane 都是 dsh 会话，改 herdr 自己的配置即可：
> ```toml
> [terminal]
> default_shell = "dshr"
> ```
> 再加一个 herdr 插件把 agent 状态报上去，侧栏就认得它了（见下）。

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
2. **不复刻 herdr，跑在它里面。** 工作区、tab、pane、活跃 agent 侧栏都是 herdr 的活，
   dshr 一律不做——**做了就是在 herdr 旁边造一个更差的 herdr**（试过，已删）。
   dshr 只负责一个 pane 内部的那个会话，另外出一个 herdr 插件把状态报上去。
   这条原来写的是「不依赖 herdr、两者是同类替代品」，方向错了，2026-08-16 改正。
3. **编排只提供动词，不提供语义。** 代码里出现 `Role` / `Workflow` / `Protocol` / `Template`
   这类**类型定义**就是越界；prompt 和 skill 里写满角色分工是正常的。
   这条是从 herdgent 搬过来的，理由见它的 AGENTS.md：SPQR v2 的 13k 行死在把语义固化成了类型。

## 包

单仓 pnpm workspace。**每个包的文件互不重叠**——这既是工程边界，也是并行开发的前提。

| 包 | 职责 | 依赖 |
|---|---|---|
| `@dshr/protocol` | dsh `/api` 线协议 carrier | 只依赖 `@deepseek-ai/dsh-host-apiproxy`（类型）与 `ws` |
| `@dshr/state` | headless 客户端模型：会话、工作区、状态、对话 | `@dshr/protocol` |
| `@dshr/tui` | **会话视图与输入框——照搬 opencode**（判据：`opencode-reference.md` 的实测截屏） | `@dshr/state`, ink |
| `@dshr/surface` | **把一个会话挂成终端界面**，与 carrier 无关（会话解析、raw mode 下的 0x03、收尾预算）。插件路与 `--connect` 路**共用这一份** | `@dshr/protocol` / `state` / `tui`, ink |
| `@dshr/bundle` | **cordis 插件行 `dshr-app`**：提供 `dshrRuntime`，`startSurface` 用**进程内 carrier** 把 TUI 挂起来（零端口零 socket） | `@dshr/protocol` / `@dshr/surface` |
| `dshr` (`packages/cli`) | `dshr` 可执行文件：一个 pane 一个会话的全屏 TUI | protocol / state / tui |

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

### 与 herdr 的关系：跑在它的 pane 里，并把状态报给它

**一个 herdr pane = 一个 dshr 进程 = 一个 dsh 会话。**
tab、pane、工作区、侧栏由 herdr 提供；`[terminal] default_shell = "dshr"`
就让每个新 pane 直接是一个 dsh 会话。

dshr 这边只需要把 agent 状态报上去，herdr 的侧栏就把它当一等公民 agent：

```sh
herdr pane report-agent --source <id> --agent dsh \
  --state idle|working|blocked|unknown [--message <text>] <PANE_ID>
```

**dshr 不需要 watcher，也不需要解析终端画面**——这是它相对
`herdr-openclaw` 那类插件的结构性优势：

- pane 身份直接来自环境变量（herdr 给每个 pane 注入 `HERDR_PANE_ID` / `HERDR_SOCKET_PATH`，实测）
- agent 状态来自 host 的**权威事件**（`host/session-status`、未决的 approval/question 帧），
  不是从画面上猜的，上游改了状态行也不会断

所以上报逻辑住在 dshr 进程内部，状态变化时**当场**报一次；插件清单只负责让 herdr 认识它。

### 编排不在这里（`@dshr/orchestrate` 已删，2026-08-17）

曾经有过一个 `@dshr/orchestrate`：`spawn` / `send` / `wait` / `cancel` / `list` +
可配置硬上限，555 行、13 个测试，**但没有任何入口调用它**。已删除
（要看它长什么样：`git log -- packages/orchestrate`）。

**理由是层次，不是重复。** dshr 是 dsh 的 TUI 客户端插件，客户端不该拥有编排动词：

- 编排是 [herdgent](https://github.com/gejiliang/herdgent) 的岗位，它已经在做
- **dsh 自己就把编排暴露成模型工具**——实测那 25 个工具里有
  `subagent` / `subagent_fork` / `workflow` / `ralph` / `list_agents` /
  `send_message` / `interrupt_agent`。客户端的本分是**把它们画出来**，不是另起一套

真正该补的是反过来那一半：`subagent.list` / `history` / `prompt` / `interrupt`
四个 RPC 还没接——现在能看见父会话里的 subagent 工具行，但**进不去子会话**。
前置障碍见 [`gap-shapes.md`](gap-shapes.md) §五。

## 运行形态

```sh
dshr                      # 在当前目录开一个新会话，全屏 TUI（host 没起就自己拉）
dshr --resume <sessionId> # 打开某个已存在的会话
dshr --connect <url>      # attach 到已在跑的 host
dshr --port 39080         # 指定 host 端口
dshr server               # 只起 host，不开 TUI
```

**通常你不会手敲这些**——把 herdr 的 `[terminal] default_shell` 设成 `dshr`，
每开一个 pane 就是一个 dsh 会话，这正是最初想要的效果。

会话强制落盘，所以关掉 pane 只是 detach；`dshr --resume <id>` 随时接回来。
会话按 **cwd** 归到 dsh 的工作区下，而 herdr 的 pane 本来就带 cwd——两边天然对齐。

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
