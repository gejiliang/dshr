# dsh host 契约（实测，2026-08-15 首测 / 2026-08-20 在 rc.8 上复验）

> 版本戳：**dsh `0.1.0-rc.8`**（rc.6 于 2026-08-13 首发，developer preview，MIT）。
> 注意 rc.8 是 dsh 的 `next`，比 `latest`（rc.7）超前一个版本——**这是有意的**，理由见第九节。
> 本文是 dshr 全部代码的实现依据。**每一条都在本机跑通过或从安装包里逐字读出**，
> 没有一条来自推测。判据是 `curl` 的真实响应与 `node_modules/@deepseek-ai/*` 的构建产物，
> 不是文档措辞。
>
> 上游是 developer preview，**会漂**。改判据前先问：这条依赖上游的哪个行为、在哪个版本上验过。
>
> **rc.6 → rc.7 → rc.8 复验结论（2026-08-20）**：
>
> | 面 | 结论 |
> |---|---|
> | `RpcMethodMap` | **52 个方法，三版逐条 diff 零增零删** |
> | 已知会话事件 | rc.7 是 39，**rc.8 抬到 43**——新增 4 个 `team/*`，无删除 |
> | apiproxy 的 `static inject` | 11 个服务，rc.7 与 rc.8 **逐字相同**（所以 patch 不缺 host 行） |
> | in-process carrier | 仍然零监听端口（`lsof -a -p <pid> -iTCP -sTCP:LISTEN` 空） |
> | typert 网关 | 仍须用 `ctx.reflect.get('typertGateway', false)` 取；直接 `ctx.typertGateway` 照样抛 `cannot get property without inject` |
> | `settings.*` | schema／revision 形状不变，两级下钻在 rc.8 上实测可用 |
>
> 那 4 个新事件（`team/member`、`team/message/delivered`、`team/message/queued`、`team/task`）
> **目前没有任何代码发射**——在完整 rc.8 安装里只出现在 `dsh-session` 的名单文件里。
> 是提前占的名，别对着空气写 fold 分支。
>
> 正文里带日期的实测记录（「2026-08-1x 在 rc.6 上实测」）一律保持原样：
> 那说的是「那个形状是在那个版本上看到的」，现在依然为真，不是待更新的版本号。

## 一、为什么 dshr 是「client」而不是「fork」

dsh 是一张 cordis 插件图。一个 **profile** 是有序的 bundle patch 层栈，落在
`$DSH_HOME/profiles/<name>`。官方随包发两个 surface bundle，都直接盖在 `dsh-base` 上：

| bundle | 形态 | 有没有 host 平面 |
|---|---|---|
| `@deepseek-ai/dsh-headless` | 一次性任务，打印结果就退出 | 无 |
| `@deepseek-ai/dsh-web-app` | 常驻 HTTP server + React 浏览器 UI | **有，完整的一套** |

`dsh-web-app` 的 `cordis.patch.yml` 里插的那批 host 行，就是 dshr 要的服务端：

```
workspace                  # 工作区注册表（durable，带顺序）
api-gateway (dsh-host-apiproxy)
cordis-host-runner
webserver (dsh-host-webserver)
session-projection-cache
session-stats
plugin-inventory
storage / storage-json / storage-domain
```

**结论：常驻服务端不用写，它已经在了。** dshr 要做的是第三个 surface——
一个终端 client，加上 herdr 形状的壳。

### 上游给这条路留了两处明文路标

不是我们凑出来的解释，是官方文档里的原话：

1. `apps/cli` README 的 Entry modes 示例：
   ```
   dsh --profile tui --resume <id>     # example, assuming the tui profile is installed;
                                       # --resume belongs to the terminal app
   ```
2. `@deepseek-ai/dsh-api-remotes` README：
   > *"Its Client face can be reused by Web or **a future TUI** that provides the same
   > React-free `ctx.remote` contract."*

3. 还有一处在 `dsh-web-app/cordis.patch.yml` 的注释里，说明了为什么 base 层保留整个 agent plane：
   > *"The base keeps them for the TUI, which is single-session and composes its agent
   > process-wide; the Web surface disables them here and lets each session mount a preset instead."*

→ **`dsh-base` 的 agent 平面本来就是给 TUI 留的。** dshr 的 profile 盖在 base 上，
tools / persona / plan-mode / subagent / workflow 全部现成可用，不需要像 web 那样逐行 disable。

## 二、线协议（实测通过）

### 载体

| 方向 | 载体 | 说明 |
|---|---|---|
| ClientRequest | `POST /api/<method>` 的 body | **必须** `Content-Type: application/json`，否则 415 |
| ServerResponse | 上面那个 POST 的响应 body | `rpcId` 原样回显 |
| ServerRequest | `/api/events.mux`、`/api/events.host` 两条下行流 | WebSocket（浏览器）／SSE（进程内 carrier） |
| ClientResponse | `POST /api/respond` 的 body | 回答审批/提问，`rpcId` 只回显不新铸 |

两条 WebSocket 都是**纯下行**，client 不往里写应用数据。任一条断掉，
当前 connection generation 失效并重建两条；readiness 要求两条都开 **且** `host.describe` 成功。
对这两个路径发普通 GET 返回 426，没有 SSE 回退。

### 信封

```ts
interface ClientRequest  { type: 'client-request';  rpcId: string; method: string; payload: unknown }
interface ServerResponse { type: 'server-response'; rpcId: string; result: RpcResult<unknown> }
interface ServerRequest  { type: 'server-request';  rpcId: string; method: string; payload: unknown }
interface ClientResponse { type: 'client-response'; rpcId: string; result: RpcResult<unknown> }

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }
```

**业务错误走 `result.error`，HTTP 状态只描述载体。** 别用状态码判业务成败。
错误码集合是封闭的（`RpcErrorDetailsMap` 的键），`switch (error.code)` 能收窄 `details`。

`/api/respond` 的响应不是 RpcMessage 而是一张回执：
`{accepted:true}` 或 `{accepted:false, reason:'not-pending'|'bad-response'}`。

### 实测记录

```console
$ curl -s -X POST http://127.0.0.1:39080/api/host.describe \
    -H 'Content-Type: application/json' \
    -d '{"type":"client-request","rpcId":"probe","method":"host.describe","payload":{}}'
{"type":"server-response","rpcId":"probe","result":{"ok":true,"value":{
  "version":"0.0.1","cwd":"/Users/gejiliang","provider":"deepseek-official",
  "model":"deepseek-v4-flash","attachedSessions":0,"canOpenPath":true}}}

$ ... /api/workspace.list  → {"ok":true,"value":{"items":[],"archivedSessionIds":[]}}
$ ... /api/session.list    → {"ok":true,"value":{"items":[]}}
```

服务端起法：`dsh web --port 39080`（`dsh web` 是 `--profile web` 的别名）。

### `/api` 信任栅栏（会咬人，先读）

node 半边在**桥接或 upgrade 之前**校验每一个 `/api` 下的入口：

- 请求的 `Host` 头必须是 loopback 权威，或者命中 `trustedHosts`
  （带端口的条目精确匹配，不带端口的条目任意端口都过；两边都过 WHATWG 规范化——这是防 DNS rebinding）。
- **没有「非浏览器请求走捷径」这回事**：明文 HTTP 下浏览器的图片/导航读取既不带 `Origin`
  也不带 Fetch-Metadata，所以未标记请求同样可能是被 rebind 的浏览器读取。`Host` 是 rebinding 伪造不了的那个头。
- 带标记时，`Origin` 必须等于 Host 权威；显式 `sec-fetch-site: cross-site` 直接拒。
- `trustedHosts` 条目必须是裸的规范 `host[:port]`，否则**插件加载期就大声失败**。

还有一档更严的：**一批特权方法被钉死在 loopback**，声明了 `trustedHosts` 也够不着——
`host.pickDirectory`、`host.openPath`、整个配置平面
（`settings.describe/openDocument/update/replace/mutate`、`credentials.describe/set/unset`）、
以及 agent-preset 的写作面（`agentPreset.read/copy/openDocument/remove`）。
理由是「一份 composition 指名了一个会话跑哪些插件，所以读它就是侦察」。
`agentPreset.list` / `select` 不在此列。

> **这条栅栏不是认证。** Web carrier 没有认证层，`dsh web --host 0.0.0.0` 是**故意**不支持的。
> dshr 要做远程 attach，**必须自己加认证**，不能靠把 `trustedHosts` 放宽——那只是可达性策略。

## 三、方法全表（`RpcMethodMap`，**52 个**）

> 这里原先写的是「51 个」，**数错了**——底下那张表自己列的就是 52 条，
> 上游 `RpcMethodMap` 也是 52 条。数字以类型为准，不以这行标题为准：
>
> ```sh
> sh tools/coverage.sh    # 从 rpc-map.d.ts 直接数，并算出 dshr 调到了几个
> ```

wire 路径就是 map 的键：`POST /api/session.list`。

```
session.list  session.search  session.create  session.history  session.models
session.selectModel  session.rename  session.fork  session.prompt
session.attachment  session.updateQueue  session.cancel

subagent.list  subagent.history  subagent.prompt  subagent.interrupt

host.describe  host.pickDirectory  host.listDirectory  host.createDirectory  host.openPath

workspace.list  workspace.create  workspace.rename  workspace.delete
workspace.insertBefore  workspace.insertSessionBefore  workspace.archiveSession

skill.list
agentPreset.list  agentPreset.select  agentPreset.read  agentPreset.copy
agentPreset.openDocument  agentPreset.remove
goal.create  goal.edit  goal.pause  goal.resume  goal.complete  goal.clear
settings.describe  settings.openDocument  settings.update  settings.replace  settings.mutate
credentials.describe  credentials.set  credentials.unset
llm.providers  llm.models  llm.discoverModels
```

**类型直接引，不要重抄。** `@deepseek-ai/dsh-host-apiproxy` 有 `./api` 与 `./api/*` 两个 subpath 导出，
那一层是**零 Node 依赖**的纯契约（类型 + zod schema），浏览器和 Node 都能 import：

```ts
import type { RpcMethodMap, RequestPayload, ResponseValue } from '@deepseek-ai/dsh-host-apiproxy/api/rpc-map'
import type { MuxFrame, HostFrame } from '@deepseek-ai/dsh-host-apiproxy/api/events'
import type { RpcResult, RpcError } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
```

zod schema 在同目录的 `*.schema.js`，解析分两级：先信封，再按方法分派业务载荷。

## 四、两条事件流的帧（herdr 的状态模型从这里来）

### `events.host` —— 主机级

```ts
type HostFrame =
  | { type:'host/session-added';   sessionId; blank; parentSessionId?; origin?:'subagent'; cwd?; agentPreset? }
  | { type:'host/session-removed'; sessionId }
  | { type:'host/session-status';  sessionId; running: boolean }     // ← idle / working
  | { type:'host/agent-error';     sessionId; message }
  | { type:'host/workspace-changed';       workspace: WorkspaceView }
  | { type:'host/workspace-removed';       workspaceId }
  | { type:'host/workspace-order-changed'; workspaceIds }
  | { type:'host/archived-sessions-changed'; archivedSessionIds }
  | { type:'host/remote-event'; event: string; args: JsonValue[] }
  | { type:'stream/error'; error: RpcError }
```

### `events.mux` —— 全会话聚合

```ts
type MuxFrame =
  | { type:'session/event';      sessionId; event: SessionEvent; view?: ToolEventView }
  | { type:'session/subscribed'; sessionId; lastSeq }
  | { type:'approval/requested'; sessionId; approvalId; toolName; callId?; reason? }  // ← blocked
  | { type:'approval/resolved';  sessionId; approvalId; outcome }
  | { type:'question/requested'; sessionId; questions: AskUserQuestionItem[] }        // ← blocked
  | { type:'question/resolved';  sessionId; questionRpcId; outcome }
  | { type:'session/queue';      sessionId; items: QueuedInboxItem[] }
  | { type:'session/jobs';       sessionId; jobs: JobView[] }
  | { type:'session/projection'; sessionId; key; value; seq }
  | { type:'stream/error';       error: RpcError }
```

**开流时它会做重放**：先给每个已挂载会话发一帧 `session/subscribed`，
然后把每个会话**仍未决**的 approval / question `requested` 帧重放一遍，
**`rpcId` 逐字复用**——这就是刷新恢复的基线。所以 client 重连不需要额外的对账逻辑。

`since` 参数是 v1 未实现的续传钩子，**传了会被忽略**；重连的正确做法是重开流 + 重取 history。

### → dshr 的 agent 状态映射

herdr 侧栏那三个状态，在 dsh 这边是白送的，不需要像 herdr-openclaw 那样去解析状态行：

| dshr 状态 | 判据 |
|---|---|
| `working` | 收到 `host/session-status{running:true}` |
| `idle` | 收到 `host/session-status{running:false}` |
| `blocked` | 该会话有未决的 `approval/requested` 或 `question/requested` |
| `error` | `host/agent-error` |

**这是 dshr 相对 herdr 的结构性优势**：herdr 只能从终端画面上猜 agent 状态
（herdr-openclaw 就是靠解析 OpenClaw 的状态行，上游一改格式就断），
而 dshr 的状态来自 host 的权威事件。

## 五、会话与投影

- **会话强制落盘**，落在 `$DSH_HOME/sessions/<cwd 转义>/session-<uuid>/`，
  形态是多帧 zstd 事件流。**这就是 `--resume` 的依据**——
  「headless 无 resume」只是 headless 那个 surface 一次性而已，会话本身一直是持久的。
- `session.history` 能读**内存里挂着的**会话，也能**不 resume、不发布 Agent** 地检查冷日志，
  然后按 append 来源的消息边界分页。
- history 的**尾页**（不传 `beforeSeq`）额外带一个 `projections` 块：
  每个注册投影单元的水位快照，`asOfSeq` 是这些值反映到的最后一个事件 seq（空日志为 -1）。
  之后的变化由 `session/projection` 帧推送，**client 按 higher-seq-wins 存一份泛型 per-session 值表**。
  `loadOlder` 的页**不带**这个块。
- gateway 自己拥有两个投影单元：`sessionListMetadata`（`session.list` 用的空白→非空白跃迁与最近人类提问时间）
  和 `imageLimits`（每次启动的常量，client 用它在提交前就拒掉超限图片）。
- 会话标题走的就是这套泛型投影，不是单独的帧。

## 五之二、会话事件的**实际**形状（实测 2026-08-15）

类型联合在 `@deepseek-ai/dsh-session/types` 里，但真正会出现哪些、字段怎么套，
读类型不如打一遍。下面是一次最简单对话（一句提问、一句回答，无工具）的真实直方图：

```
  3  user/message          2  agent/inbox/spliced     2  assistant/chunk
  1  permission/preset     1  sandbox/mode            1  approval/policy
  1  turn/start            1  step/start              1  step/end        1  turn/end
  1  request/header        1  request/context
  1  session/title         1  session/title-llm-request
```

（`session/title-llm-request` 就是第五节说的那次额外 LLM 调用。）

### 三个容易搞错的地方

**① `session.history` 的条目包了一层，mux 帧没有。**

```ts
history.value.events[i]   // HistoryEntry = { event: SessionEvent }  → 类型在 entry.event.type
muxFrame.event            // SessionEvent 本身                        → 类型在 frame.event.type
```

**② 助手文本不是 `text-delta` 事件，是 `assistant/chunk`，原始 chunk 在 `data.chunk` 里。**

```json
{ "type": "assistant/chunk", "seq": 14, "time": 1786810207580,
  "data": { "turn": 1, "step": 1,
            "chunk": { "type": "usage", "usage": { "inputTokens": 0, "outputTokens": 0 } } } }
```

`data.chunk` 是 `dsh-llm` 的原始 StreamChunk 联合：
`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`。

→ **不要自己写拼装。** `@deepseek-ai/dsh-llm` 导出 `BlockAssembler`，README 原文说它是
"the single shared implementation that assembles chunks into blocks/messages"。
那个包只有一个依赖（`@deepseek-ai/schemastery`），Node 里直接可用。

**③ projections 块整块只有一个 `asOfSeq`。**

```json
{ "asOfSeq": 17,
  "values": {
    "title": "Reply with exactly one short",
    "sessionStats":      { "turns":1, "steps":1, "llmMs":0, "toolMs":0, "ttftMs":0, ... },
    "tokenUsage":        { "uncachedInputTokens":0, "outputTokens":0, "cacheReadTokens":0, "cacheWriteTokens":0 },
    "contextPressure":   { "pressureTokens":0, "projectedTokens":0, "contextWindow":131072 },
    "contextBreakdown":  { "systemTokens":1011, "toolsTokens":6556, "messageTokens":406 },
    "goal": null, "subagent": null, "subagentTiming": {...}, "permissions": {...}
  } }
```

播种时给每个 key 打上这一个 `asOfSeq` 当初始水位，之后 `session/projection{key,value,seq}`
逐 key 按 higher-seq-wins 更新。`contextPressure` 与 `contextBreakdown` 就是状态行
上下文用量的数据源——**别只挑 `title` 出来，整张表按泛型暴露**。

### 自己打一遍

仓库里两个工具，需要一台 host（`docs/profile.md` 有零凭据起法）：

```sh
node tools/e2e.mjs http://127.0.0.1:39081                  # 建会话 + 发提示 + 看流
node tools/probe-events.mjs                                # 直方图 + 真实形状 + projections
PROBE_MARKER=assistant/chunk node tools/probe-events.mjs   # 只看某类事件
```

## 五之三、`session.create` 的互斥参数（实测踩过）

**`session.create` 接受 `workspaceId` 或 `cwd`，不能两个都给。**

```console
$ ... payload:{"cwd":"/tmp/x"}                                    → ok
$ ... payload:{"workspaceId":"d11d8851-…"}                        → ok
$ ... payload:{"cwd":"/tmp/x","workspaceId":"d11d8851-…"}
{"ok":false,"error":{"code":"bad-request",
 "details":{"issues":[{"message":"session.create accepts workspaceId or cwd, not both"}]}}}
```

工作区自己记得路径，所以**有 `workspaceId` 时就只发它**。

这条只有跨进程打真 host 才会暴露——用假 client 的单测怎么写都是绿的。
它也是 `tools/e2e.mjs` 与 `packages/cli/test/e2e.test.ts` 存在的理由。

## 六、模型选择

`host.describe` 返回的 `provider`/`model` 是**部署默认**，由 `dsh-agent-default-model` 服务在
`agent-default-model` settings 段里维护。一个会话的模型按三层解析，**每次访问都重算**：

1. 本进程内做过的选择
2. 否则该会话日志里最近的 `request/header`
3. 否则上面那个部署默认

`session.selectModel` **同时**把接受的切换存成部署默认——没有第二个手势。
存的是解析后的 `ModelSelection`（含适配器物化的默认 effort）。

**存的选择与 catalog 成员资格无关**：默认值指向一个当前不可用的 provider 时，
它照样会作为该会话的 `current` 出现在 `session.models` 里，好让选择器**请求替换**
而不是静默换一个模型。

## 七、Provider 配置

适配器是 `@deepseek-ai/dsh-llm-pi-ai`，settings 命名空间 `llm-pi-ai`，
真源 `$DSH_HOME/settings.yaml`。`providers` 是 dict，与 composition base **按 provider 逐个合并**，
改完**下一个请求就生效，不用重启**。

```yaml
llm-pi-ai:
  providers:
    quota-proxy:
      apiKeyEnv: QP_API_KEY          # 凭据是「引用」，每次请求解析，密钥不进这个文件
      api: openai-completions
      baseURL: https://<gateway>/v1
      models:
        - id: deepseek-v4-flash
```

要点：

- `apiKeyEnv` 是**引用**。配了但解析不到值 → 请求以 `MISSING_CREDENTIAL` 失败，
  **不会**回退到环境里碰巧存在的别的 key。完全不配 `apiKeyEnv` 才走 pi-ai 的环境发现。
- `models` 列表**替换**该路由的自带 catalog（不是扩展）；只想改一个模型用 `modelOverrides`。
- 私有网关的 URL 认不出思考方言，需要时用 `compat.thinkingFormat`（只在 `openai-completions` 上有）。
- 写坏的 profile 在**写入处**就被拒（`settings.mutate` 回 `settings-rejected`），不会存进去再静默禁用整个命名空间。

**开发期不需要真 provider**：`@deepseek-ai/dsh-llm-mock-server` 是一个假的 OpenAI 兼容
HTTP/SSE 端点（**不是 dsh 插件**，也不随 `@deepseek-ai/dsh` 一起装——它在 devDependencies 里）。
起它再把 provider 的 `baseURL` 指过去，就能零密钥跑完整条链路。接法与行为表见
[`profile.md`](profile.md) 末节。

## 八、profile 怎么组合

profile 目录里两个文件：

- `package.json` —— out-of-tree 插件依赖 + `dsh.profile` 清单（有序的 `bundles` 列表）
- `cordis.patch.yml` —— 用户自己的 patch 层

组合顺序（盖在空根上）：

```
dsh.profile.bundles 里每个 bundle 的 patch（按序）
  → profile 自己的 cordis.patch.yml
  → $DSH_HOME/cordis.patch.yml
  → --patch 覆盖层
```

`bundles` 里的名字**先**从 dsh 安装目录解析（`dsh-base` / `dsh-web-app` / `dsh-headless`），
**再**从 profile 自己的 `node_modules`（`dsh plugin` 用 pnpm 装到那里）。
→ **dshr 的 bundle 就装在这一层，不需要改 dsh 本体。**

patch 的语义要记住两条，都踩过：

- **一条 patch 替换目标行的整个 `config`**，所以每一行要把自己拥有的键全部重述一遍。
- **改已有条目用 `id`，加新插件用 `insert`。写错 id 只在 stderr 印一行就照常启动**——
  必须用 `--dump-config` 复核，别信它没报错。

其它可用旗标：`--dump-default-config` / `--dump-config` 只组合不启动。
launcher 自己的旗标必须写在前面，**第一个它不认识的 token 开始就是 app 的参数**。

## 九、装包：两个 dist-tag 都不能跟（首测 2026-08-15，rc.7 / rc.8 上各复验一次）

**dshr 当前钉 `0.1.0-rc.8`，那是 dsh 的 `next`——比 `latest`（rc.7）超前一个版本。**
这是有意的：库包那条线只发到 `next`，跟着 `latest` 会拿到一年前的 `0.0.1-rc.1`。

```console
# 2026-08-20 实测
$ npm view @deepseek-ai/dsh dist-tags
{ next: '0.1.0-rc.8', latest: '0.1.0-rc.7' }

$ npm view @deepseek-ai/dsh-host-apiproxy dist-tags
{ latest: '0.0.1-rc.1', next: '0.1.0-rc.8' }      # ← latest 差了一整条线

$ npm view @deepseek-ai/dsh-llm dist-tags
{ latest: '0.0.1-rc.1', next: '0.1.0-rc.8' }
```

### 为什么说「两个都不能跟」

- **库包的 `latest` 停在 `0.0.1-rc.1`**，0.1.x 那条线只挂在 `next` 上。
  这个错位 rc.6 / rc.7 / rc.8 一路都在，别指望它自己好。
- **`next` 也不能跟**——理由不是它现在错，是**没有任何东西保证两条 tag 同步**。
  实测到的两个时刻：

  | 时刻 | 本体 `latest` | 本体 `next` | 库包 `next` | 「本体 latest + 库包 next」会得到 |
  |---|---|---|---|---|
  | rc.7 发布时 | rc.7 | rc.8 | rc.8 | ❌ rc.8 的库配 rc.7 的宿主 |
  | 现在 | rc.7 | rc.8 | rc.8 | ✅ 碰巧对上（因为我们改钉 rc.8 了） |

  同一组 tag，隔一次发布就从错位变成对上。**碰巧对上不是保证**——
  下次发布它可以再错开，而错开的时候 npm 不会吭一声。

### 所以

- **依赖一律钉精确版本**，且**钉的那个版本要等于你实际启动的宿主版本**。
  **同一个数字散在 5 处，升级时一起改，漏一处就是库和宿主错版**：

  | 文件 | 钉的东西 |
  |---|---|
  | `packages/cli/src/profile.ts` | `DEFAULT_DSH_COMMAND` —— **实际启动的宿主**，以它为准 |
  | `packages/bundle/package.json` | `@deepseek-ai/dsh-cmdline` |
  | `packages/protocol/package.json` | `@deepseek-ai/dsh-host-apiproxy` |
  | `packages/state/package.json` | `@deepseek-ai/dsh-llm` |
  | 根 `package.json` | `@deepseek-ai/dsh-llm-mock-server`（开发期假 provider） |

  一句话查漏：`grep -rn '0\.1\.0-rc\.' --include=package.json . | grep -v node_modules`
  再加上 `profile.ts` 那一行，5 处版本号必须一致。
- **升级前先确认那 5 个包在目标版本上都发了**，别升到一半发现某个库缺号：
  `npm view @deepseek-ai/<pkg>@<版本> version` 逐个问一遍。
- **跟 `next` 就会撞上 pnpm 的「最短发布年龄」防护**（`minimumReleaseAge`，默认 24 小时）。
  rc.8 发布于 `2026-08-19T15:41Z`，隔天装它整批被拦。解法是 `pnpm install` 自动写进
  `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 逐名豁免——**照单提交，
  不要图省事把 `minimumReleaseAge` 关掉**：关掉是对所有依赖失去防护，列名只对这一批开口子。
- 不要写 `^0.1.0-rc.8`：预发布版本的 semver range 语义本来就绕，加上 dist-tag 错位，
  写范围几乎必然装错。
- 精确版本装得到，已验证：`npm view @deepseek-ai/dsh-host-apiproxy@0.1.0-rc.8 version` → `0.1.0-rc.8`。
- 库包**没有**随 `@deepseek-ai/dsh` 一起装到顶层的保证——`dsh` 的 `devDependencies`
  （含 `dsh-llm-mock-server`、`dsh-agent`、`dsh-session` 等）在装published 包时**不会**被装。
  要用就自己声明依赖。

## 十、已知会咬人的地方

- **`workspace-write` 沙箱不约束「读」。** macOS 用 Seatbelt，profile 只写了 `(deny file-write*)`。
  实测 agent 在 workspace-write 下用 bash 把父目录整棵树 grep 了一遍，读到了隔壁目录里
  另一个 harness 的会话文件。只读要用 `DSH_PERMISSION_MODE=read-only`（那一档实测挡得住，
  且明令绕过也没绕成）。
- **每个会话多花一次 LLM 调用**生成标题（`session-title-first-prompt-llm`，`max_completion_tokens: 64`）。
- **`/api` 桥把每个请求体整个缓进内存**，`maxRequestBodyBytes` 默认 160 MiB，
  所以那也是单请求的常驻内存上界。
- **history 打开一个未挂载会话会真的创建 host 侧 agent**，首次打开有延迟；没有「只读持久化」路径。
- 沙箱在平台不支持或运行器不可用时以 `SANDBOX_UNAVAILABLE` **fail closed**，绝不静默退回无约束执行。
