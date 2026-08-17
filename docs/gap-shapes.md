# 缺口事件与方法的**实测**载荷形状

> 2026-08-17，dsh **0.1.0-rc.6**，用 `tools/probe-gaps.mjs` 打出来的。
> 配套 [`coverage.md`](coverage.md)（缺口清单）与 [`dsh-contract.md`](dsh-contract.md)（核心协议）。
>
> **为什么必须打而不是读类型**：`compaction/*`、`plan/mode`、`hook/*`、`schedule/change`
> 这几个**不在核心 `SessionEventMap` 里**——它们由插件做模块增强声明，
> 而那些插件随 dsh CLI 走，**没有作为依赖装进 dshr**，所以本地根本没有它们的 `.d.ts`。
> `known-event-types.js` 里只有名字，没有形状。
>
> 重打：
> ```sh
> node tools/mock-llm.mjs --port 8100 --sequence <行为>   # 造出想要的事件
> node tools/probe-gaps.mjs http://127.0.0.1:39081 "<提示>"
> ```

## 一、每个事件都套在 `{ type, seq, time, data }` 里

会话事件**统一是这个信封**，业务载荷在 `data`。（mux 帧里 `frame.event` 就是它本身；
history 那边还要多剥一层——见 `dsh-contract.md` §五之二。）

## 二、重试 —— `llm/retry` + `llm/retry-started`

造法：`--sequence rate_limit,server_error,success`

```json
{
  "type": "llm/retry",
  "seq": 17,
  "time": 1786956133827,
  "data": {
    "retryId": "c0513ee5-5970-4e71-84a0-785901e5eefe",
    "turn": 1,
    "step": 1,
    "provider": "mock",
    "mode": "normal",
    "policyKey": "[\"normal\",2,[\"EMPTY_RESPONSE\",\"RATE_LIMIT\",\"SERVER\",\"TIMEOUT\",\"TRANSPORT\"],500,10000,0.1]",
    "retry": 1,
    "maxRetries": 2,
    "delayMs": 545.5821455856733,
    "failure": { "message": "429: {…}", "code": "RATE_LIMIT" }
  }
}
```

```json
{
  "type": "llm/retry-started",
  "seq": 18,
  "data": { "retryId": "…", "turn": 1, "step": 1, "retry": 1 }
}
```

- `llm/retry` = **决定要重试**（带失败原因与退避时长），`llm/retry-started` = **退避结束、真的开打**
- 两者用 `retryId` 配对
- `data.retry` 是第几次（1 起），`data.maxRetries` 是上限
- `data.failure.code` 是分类（`RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE`），
  `data.failure.message` 是原始报文——**渲染取 code，`message` 留给展开**

渲染（照 opencode）：`↳ Retrying (attempt 1/2) · RATE_LIMIT`，整行 `error` 色。

## 三、待办 —— `todo/write`

造法：`--sequence tool_call_success,success --tool-name todo_write --tool-arguments '{"todos":[…]}'`

```json
{
  "type": "todo/write",
  "seq": 24,
  "data": {
    "todos": [
      { "content": "读契约",   "status": "completed" },
      { "content": "实现渲染", "status": "in_progress" },
      { "content": "补测试",   "status": "pending" }
    ]
  }
}
```

**整表快照，最后一次写覆盖前面的**（`last-write-wins`，上游注释写明了：
条目没有 id，因为整表替换，不需要稳定身份）。

渲染（照 opencode `todo-item.tsx`）：
`[✓] 内容`（completed，muted）／`[•] 内容`（in_progress，**warning**）／`[ ] 内容`（pending，muted）。

## 四、斜杠命令 —— `command/run` + `command/done`

形状从 `@deepseek-ai/dsh-commands/lib/types/types.d.ts` 读到（这个包**装得到**）：

```ts
'command/run':  { commandId: CommandId; name: string; args?: string; source: CommandSource }
'command/done': { commandId: CommandId; kind: 'success' | 'error'; text?: string; sourceEventSeq?: number }
```

用 `commandId` 配对；`kind` 决定成功/失败着色。

## 五、子 agent —— 不靠 `subagent/descriptor`

**实测：派一个子 agent 时，父会话的事件流上不会出现 `subagent/descriptor`。**
那个事件写在**子会话自己的日志**里（它描述"这个会话是什么"）。

父会话上真正能看到的是：

1. `tool/call` —— `name: 'subagent'`，args 里有 `subagent_type` / `description` / `prompt`
2. `«host» host/session-added` —— 子会话建立：
   ```json
   { "type": "host/session-added", "sessionId": "session-3454…",
     "blank": true, "cwd": "…", "agentPreset": "standard" }
   ```
3. `«host» host/session-removed` —— 子会话结束

> ⚠️ 契约文档 §四 写的 `host/session-added` 带 `parentSessionId` 与 `origin:'subagent'`，
> **本次实测这两个字段没出现**（只有 `sessionId`/`blank`/`cwd`/`agentPreset`）。
> 做父子关联前**先重验这两个字段在你那个版本上到底给不给**，别照着契约写死。

`subagent/descriptor` 的类型（`@deepseek-ai/dsh-subagent/lib/types/descriptor.d.ts`，`version = 2`）：

```ts
type SubagentDescriptorData =
  | { version: number; mode: 'one-shot';    provider: string; label?: string }
  | { version: number; mode: 'continuable'; provider: string; label: string
      agentProvider?: string; agentModel?: string; persona?: string; toolFilter?: ToolRestriction }
```

渲染（照 opencode）：工具行 `✓ General Task — <描述>`（未完 `│`，完成 `✓`），
下面挂 `↳` 子行——当前工具／`N toolcalls`／完成时 `N toolcalls · 2.1s`。

## 六、队列 —— `session/queue`（mux 帧，不是会话事件）

```json
{
  "type": "session/queue",
  "sessionId": "session-0a3f…",
  "items": [
    { "id": "209c045a-…", "placement": "queued",
      "message": { "id": "209c045a-…", "role": "user",
                   "content": [{ "type": "text", "text": "说一句话" }],
                   "source": { "kind": "user", "rpcId": "4b2dd9de-…" } } }
  ]
}
```

渲染（照 opencode）：反色徽章 ` QUEUED `，底色用 agent 色。

## 七、`compaction/*` 与 `plan/mode` —— 还没打到

`known-event-types.js` 里有名字（`compaction/start` `end` `summary` `prune`、`plan/mode`），
但：

- 声明它们的插件**没装进 dshr**，读不到类型
- **本轮没造出来**：压缩要撑爆上下文（131072 tokens，mock 造不出来）；
  plan 模式要先进计划态，`exit_plan_mode` 工具单独调不触发

**动它们之前必须先打到一次真事件**。在没有实测样本之前：

- 可以先按「收到 `compaction/*` 就画一条居中横线 `──── Compaction ────`」实现，
  **只依赖 `type`，不碰 `data` 里任何字段**——这样形状未知也不会写错
- `plan/mode` 同理，**先只认 type**，具体字段等打到再说
- **不要凭猜写字段名**。写了就是假的，而假的东西比缺口更贵

## 八、C/D/E 批要用的方法（实测返回形状）

### `session.models` —— 直接就是模型对话框的数据结构

```json
{
  "current": { "provider": "mock", "model": "mock-model" },
  "routable": true,
  "groups": [
    { "id": "deepseek-official", "name": "DeepSeek",
      "models": [
        { "id": "deepseek-v4-flash", "name": "DeepSeek-V4-Flash",
          "reasoning": { "efforts": [{ "id": "off", "name": "Off" },
                                     { "id": "high", "name": "High" },
                                     { "id": "max", "name": "Max" }],
                         "defaultEffort": "high" } }
      ] }
  ]
}
```

`groups` → opencode 模型对话框的分类，`current` → `●` 标记。**同构，不用转译。**

### `agentPreset.list` —— dsh 只有四个预设

```json
{
  "presets": [
    { "id": "standard", "trust": "system", "isDefault": true,  "name": "标准模式", "description": "…" },
    { "id": "code",     "trust": "system", "isDefault": false, "name": "PTC 模式", "description": "…" },
    { "id": "minimal",  "trust": "system", "isDefault": false, "name": "极简模式", "description": "…" },
    { "id": "cordis",   "trust": "system", "isDefault": false, "name": "创造模式", "description": "…" }
  ],
  "authorable": true,
  "hasDocument": true
}
```

opencode 的 `tab` 就地循环（`Build` ↔ `Plan`）在 dshr 这边就是在这四个之间循环。

### `llm.providers`

```json
{ "providers": [ { "provider": "deepseek-official", "displayName": "DeepSeek",
                   "settingsNs": "llm-deepseek", "settingsPath": [], "active": true },
                 { "provider": "anthropic", "displayName": "anthropic",
                   "settingsNs": "llm-pi-ai", "settingsPath": ["providers","anthropic"],
                   "active": false, "declared": false } ] }
```

### 写方法的载荷与返回（`tools/probe-methods.mjs` 实测）

| 方法 | 载荷 | 返回 |
|---|---|---|
| `session.selectModel` | `{ sessionId, provider, model }` | `{ selected: { provider, model } }` |
| `agentPreset.select` | `{ sessionId, agentPreset }` ⚠️ | `{ agentPreset }` |
| `session.rename` | `{ sessionId, title }` | `{ title, seq }` |
| `session.fork` | `{ sessionId }` | 需要**已完成的一轮**，否则 `fork-unavailable` |
| `session.search` | `{ query }` | ⚠️ 见下，本部署是关的 |
| `session.updateQueue` | `{ sessionId, itemId, action: { kind: 'edit' \| 'remove' \| 'steer', … } }` | `action` 是判别联合 |
| `session.attachment` | `{ sessionId, attachmentId }` | ⚠️ 见下，不是上传 |
| `skill.list` | `{ sessionId }` | `{ skills: [{ name, description, modelInvocable }] }` |
| `goal.create` | `{ objective: string, … }` | — |
| `session.prompt` | `{ sessionId, mode:'queue', content:[{type:'text',text}] }` | 已在 `packages/state/src/state.ts` 验证 |

三个会咬人的地方：

1. **`agentPreset.select` 的键是 `agentPreset`，不是 `presetId`。** 猜错过一次。
2. **`session.search` 可能被部署关掉。** 实测这台报：
   `session search is disabled: this deployment configures the session-query index with openAt "never"`。
   **所以切会话的列表要走 `session.list`，把 `search` 当增强而不是依赖**——
   没有它也要能用。
3. **`session.attachment` 不是上传接口，是读回接口。** 传一个不存在的 id 报的是
   `ATTACHMENT_NOT_REFERENCED`（"Image is not referenced by this session"）。
   上传走 `session.prompt`，见下。

### 图片怎么进会话（D 批用）

`@deepseek-ai/dsh-host-apiproxy/api/sessions` 里的 `PromptContentPart`：

```ts
type PromptContentPart =
  | { type: 'text';  text: string }
  | { type: 'image'; mediaType: ImageMediaType; data: string; name?: string }

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
```

流程是三段：

1. **发**：`session.prompt` 的 `content` 数组里直接塞 `{type:'image', mediaType, data}`，
   `data` 是字符串（base64）。上游注释：**"the host promotes image bytes to durable references"**
   ——字节由 host 收下并转成持久引用，客户端不需要先上传。
2. **自查**：`imageLimits` 投影给出这台部署的限额，客户端**提交前**就该拒掉超限的：
   ```ts
   interface ImageAttachmentLimits {
     maxImageBytes: number; maxImagesPerMessage: number
     maxMessageImageBytes: number; maxImagePixels: number
     mediaTypes: readonly ImageMediaType[]
   }
   ```
3. **读回**：`session.attachment` → `{ sessionId, attachmentId }`，
   只有该会话日志里引用过这个 id 才给读（否则 `ATTACHMENT_NOT_REFERENCED`）。

> 顺带：`ModelSelection` 除了 `provider`/`model` 还有可选的 `reasoningEffort`——
> `session.models` 的 `models[].reasoning.efforts` 就是给它选的。C 批可以先不做，
> 但结构上留好位置。

> **打形状的通用招式**：随便传一个空对象过去，`result.error.details.issues` 就是 zod
> 逐字段列出来的说明书。比翻文档快，而且不会过期。
> `session.updateQueue` 的 `action.kind` 三个取值就是这么问出来的
> （`No matching discriminator … Expected 'edit' | 'remove' | 'steer'`）。

## 九、dsh 自带的工具（25 个，来自 `request/header`）

```
ask_user_question  bash  create_goal  edit  exit_plan_mode  get_goal  glob  grep
interrupt_agent  job_kill  job_list  job_output  list_agents  ralph  read  read_image
send_message  skill  subagent  subagent_fork  todo_write  update_goal  web_search
workflow  write
```

⚠️ **注意 `subagent` / `subagent_fork` / `workflow` / `ralph` / `list_agents` /
`send_message` / `interrupt_agent`——dsh 自己就带编排原语。**
这与 `@dshr/orchestrate` 的去留直接相关：那个包在重复 dsh 已经有的东西。
