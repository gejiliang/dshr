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
- **本轮没造出来**，试过的办法与结果（别再试一遍）：

| 试法 | 结果 |
|---|---|
| 让 mock 发 `exit_plan_mode` 工具调用 | **事件流里连 `tool/call` 都没有**——该工具多半不在 `standard` preset 的可用集里，host 直接丢了。没有 `plan/mode` |
| `agentPreset.list` 里找 plan 预设 | 没有。dsh 只有 `standard`/`code`/`minimal`/`cordis` 四个，**plan 不是一个 preset** |
| 撑爆上下文造压缩 | 没试——`request/context` 报 `contextWindow: 131072`，mock 造不出这个量 |

  > ~~所以 plan 模式在 dsh 里怎么进，目前是未知的。~~
  >
  > **✅ 2026-08-19 找到了：入口是斜杠命令 `/plan`**（"Enter or leave plan mode"）。
  > 它是 host 的 `CommandRuntime` 命令之一，走 typert `commands.execute`——
  > 所以当初怎么试都触发不了：**它根本不是工具，也不是 preset，是一条客户端斜杠命令**，
  > 而那时候 `/` 还没做。实测在跑过一轮的会话上执行 `/plan`，composer 的模式行
  > 立刻变成 `Standard · plan/mode · <model>`，`plan/mode` 事件确实到了。
  >
  > **载荷形状仍未打**（现在只认 type）。要打的话现在有路了：起插件形态、跑一轮、
  > 执行 `/plan`，同时用 `tools/probe-gaps.mjs` 接同一台 host 抓 `plan/mode` 的
  > 原始 JSON。做之前别猜字段名。

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

### E 批补测（2026-08-17 晚，`tools/probe-config.mjs` / `tools/probe-goal.mjs`）

- **`settings.describe`**：返回 `{ writable, hasDocument, namespaces[] }`；每个命名空间带
  `ns` / `schema`（schemastery 序列化封套）/ `value`（**已脱敏**，`role('secret')` 字段不下线）/
  `applies: 'live'|'restart'` / `secrets: [{path, set}]` / `revision`（写回时的 CAS）。
- **credential ref 的发现**：credentials 域**故意没有枚举方法**——ref 从设置里读：
  字段名就是 `apiKeyEnv`（schema 里标 `role: 'credential-ref'`），值是 ref 名
  （如 `MOCK_API_KEY`）。provider 的 profile 在 `settingsNs` 的 `value` 里按 `settingsPath` 指进去。
  `credentials.describe` 必填 `refs: string[]`，空对象撞 zod（`expected array`）。
- **`goal` 投影就是 goal 的读侧**（goals.d.ts 写明的）：`session/projection` 帧与 history
  尾页投影块里都带，形状 = `{ goal: {id, revision, objective, phase, maxGoalRounds, blockedReason?},
  roundsStarted, createdAt, updatedAt }`，clear 后是 `null`。`goal/change` **事件**的 data 同测到
  create 与 block 两个操作（与 dsh-goal 的 `GoalChangeMeta` 一致），但其余操作没全打——
  **用投影做读侧就够了，事件继续只认 type**。
- **goal 的 CAS 是真的会咬**：goal 活着时模型会自动跑轮次，revision 一直被推；
  拿创建时的 ref 去 pause 撞 `stale goal ref … revision 1; current is … revision 2`。
  **动词必须在派发那一刻从投影现读 ref。** 另外 phase 在 pause 按下前翻成 blocked 也会撞
  `cannot pause goal … from phase "blocked"`——所以动词的失败必须**有可读回执**，不能吞。
- `goal.create` 不给 `maxGoalRounds` 时服务默认 **256 轮**（实测投影里看到的）。

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

D 批实测又踩到的三个（2026-08-17，`tools/verify-batch-d.mjs`）：

4. **bash 工具的 `description` 是必填参数。** mock 发 `tool_call_success` 只带
   `command` + `run_in_background` 时，host 回 `ToolArgsError: missing required property "description"`——
   连 `session/jobs` 帧都不会有（任务根本没起来）。
5. **模型不声明 `input: [text, image]` 模态，带图的 `session.prompt` 在准入时就被拒**：
   `attachment-error: Model "…" does not support image input.`（`settings.yaml` 的 models 条目里加 `input`）。
6. **标题生成会消费 mock 的行为序列**：第一轮结束后 `session-title` 插件自己发一次 LLM 请求。
   用 `--sequence` 编排多轮行为时要把这一格算进去（或像 verify-batch-d 一样用
   `mock.requests.length` 等它落定），否则 stall/success 落不到你以为的轮次上。

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
**这是 `@dshr/orchestrate` 被删掉的判据之一**（2026-08-17）：编排是 dsh 自己的能力，
以模型工具的形式暴露；dshr 是 TUI 客户端插件，本分是**把这些画出来**，不是另起一套动词。
反过来那一半才是该补的——`subagent.list` / `history` / `prompt` / `interrupt` 还没接，
所以现在看得见 subagent 的工具行，却进不去它的会话。

## 十、后台任务 —— `session/jobs`（mux 帧）

`@deepseek-ai/dsh-host-apiproxy/api/jobs` 里的 `JobView`：

```ts
interface JobView {
  id: JobId
  kind: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  detail?: string
  startedAt: number
  finishedAt?: number
}
```

帧是 `{ type:'session/jobs', sessionId, jobs: JobView[] }`。

**现状：`packages/state/src/state.ts` 收到这个 case 直接 `break`，什么都不存。**
dsh 自带 `job_list` / `job_kill` / `job_output` 三个工具——后台任务是真实存在的，
只是 dshr 一个都不显示。

渲染建议：底部栏一个计数 chip（有 running 的时候才画），命令面板一条
`View background jobs` 开 `DialogSelect` 列出来（`label` 作标题、`kind`+耗时作 muted 说明、
`status` 决定颜色）。**`job_kill` 是模型的工具，不是 RPC——dshr 这层只做展示，不要造杀任务的 RPC。**

## 十一、设置的写侧与 schema（2026-08-18 实测）

> 起因是一次真实的设计错误：`Open settings` 走 `settings.openDocument`，
> 它在**宿主机的桌面**上弹一个文本编辑器。dshr 是终端工具，常常是从别的机器
> SSH 过来用的——**编辑器弹在你看不见的那台机器上，人完全不知道发生了什么**。
> 上游给 `openDocument` 是为本机跑 web UI 的形态设的，照搬到终端 surface 是错的。
> 结论：**设置必须能在 TUI 里改完**。

### 写侧三个方法（`@deepseek-ai/dsh-host-apiproxy/api/settings`）

```ts
update  ({ ns, patch: object,             expectedRevision? }) → SettingsNamespaceView
replace ({ ns, section: object,           expectedRevision? }) → SettingsNamespaceView
mutate  ({ ns, ops: SettingsPathOpView[], expectedRevision? }) → SettingsNamespaceView

type SettingsPathOpView =
  | { op: 'set';   path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }
```

**表单要用 `mutate`**：它是按**字段路径**改的，一次编辑 = 一个 `set` op，
`expectedRevision` 做 CAS，返回值直接带回新的 `revision`——不用再 describe 一次。
`update`（合并 patch）与 `replace`（整段替换）粒度太粗，改一个字段会把并发的别处改动盖掉。

### 读侧一个命名空间长这样

```ts
interface SettingsNamespaceView {
  ns: string
  schema: unknown          // schemastery 序列化：{ uid, refs: { <id>: { type, meta, dict?, inner? } } }
  value: unknown           // **已脱敏**：role 为 secret 的字段不下线
  base?: unknown; user?: unknown
  applies: 'live' | 'restart'
  secrets: { path: string[]; set: boolean }[]
  revision: number         // 写回时的 CAS
}
```

### schema 的全部词汇（11 个命名空间统计出来的，不是猜的）

| `type` | 出现次数 | TUI 控件 |
|---|---|---|
| `const` | 57 | 与 `union` 配对出现——**枚举是主导模式** |
| `union` | 18 | union of const → 选择列表；含非 const 分支时退回文本 |
| `number` | 32 | 数字输入，`meta.min` / `max` / `step` 做校验 |
| `string` | 25 | 文本输入 |
| `object` | 23 | 分组，可下钻 |
| `array` | 6 | `{ inner: <refId> }`，元素同构 |
| `dict` | 4 | 键→值映射（provider 名这类） |
| `boolean` | 1 | 开关 |

`meta` 只有六个键：`default` / `required` / `min` / `max` / `step` / `role`。
`role` 只有两种：

- **`secret`**（1 处）：值**不下线**，`secrets[]` 只告诉你 `set: true|false`。
  TUI 里显示「已配置 / 未配置」，**不要显示值，也不要提供明文输入**。
- **`credential-ref`**（3 处）：值是**环境变量名**（如 `MOCK_API_KEY`），不是密钥本身。
  这个可以正常当文本编辑——它本来就该是明文。

### 写侧的前提已经排过险（`tools/probe-settings-write.mjs` 实测）

「在 TUI 里改设置」这件事的前提是 `settings.mutate` 从客户端调得通。实测结论：

```
目标: agent-loop  revision=0  applies=live  writable=true
字段 maxParallelToolCalls 当前 = 10
mutate → ✅ ok，新 revision=1
CAS 用过期 revision → ✅ 被拒: settings-conflict: settings namespace "agent-loop"
                       changed since it was read (expected revision 0, now 1)
```

- **没有信任栅栏挡**（不像 `agentPreset.read/copy/...` 那批写作面方法）
- **CAS 是真的**：过期 `expectedRevision` 被拒，错误码 `settings-conflict`，消息可读到能直接展示给人
- 返回值带新 `revision`，**拿它更新本地状态即可，不用再 describe 一次**

⚠️ 这个探针**会真的写**（虽然刻意「把字段设回当前值」，仍然会让 revision 前进）。
**只对隔离的 DSH_HOME 用。**

### 斜杠命令：客户端的活，不是发给模型

实测：`session.prompt` 发 `/help` **只是当普通文本发给了模型**，事件流里没有 `command/run`。
上游 web patch 的注释说明了分工：

> *"Input triggers: the `/` | `@` pipeline (ui-input-trigger), the command surface over it
> (ui-commands), and the two reference sources (ui-skill / ui-subagent)."*

`/` 与 `@` 都在**客户端**实现；`@` 的引用来源是 skills 与 subagents。

命令表怎么拿：`CommandRuntime`（`@deepseek-ai/dsh-commands`）是 **typert remote service**，
**不在那 52 个 RPC 里**。两条路：

- **插件形态（默认）**：`ctx.typertGateway.invoke({ namespace, method, args })` 一个通用入口，
  `typert-gateway` 行本来就在 base 组合里。**进程内直接可用**，跟 `ctx.commands` 一样。
- **`--connect` 形态**：typert 没走 `/api`，客户端要自己实现那套协议——暂不做，
  这条路上 `/` 只出 dshr 自己的命令。

命令表变化会推 `«host» host/remote-event { event: 'commands/change', args: [] }`，
收到就重取（实测抓到过）。

### typert 探通的形状（2026-08-18，dsh 0.1.0-rc.6 实测）

拿网关：**不能写 `ctx.typertGateway`**——不在插件级 `inject` 里的服务，cordis 直接抛
`cannot get property "typertGateway" without inject`（实测，startSurface 一调就炸）。
而 `inject` 是硬依赖，写上它 profile 少一行整棵树起不来。可选服务走
`ctx.reflect.get('typertGateway', false)`：没提供返回 `undefined`，退化到
「只出 dshr 自己的命令」。

    list    ← invoke({ namespace: 'commands', method: 'list',    args: { agentId } })
    execute ← invoke({ namespace: 'commands', method: 'execute', args: { agentId, line } })

- `agentId` 就是 sessionId（descriptor 里 scope 的 wire 名）。**args 必须逐字精确**：
  网关 `assertExactArguments` 对多一个键、少一个键都抛 `arguments-invalid`。
- `invoke` 返回**业务结果本体**，不包 `RemoteResult`：
  - list → `CommandDescriptor[]`：`{ name, description, input?: { hint } }`；
    `input` 存在 = 命令要自由文本参数（TUI 里 enter 只补全 `/name `，不执行）。
    实测 payload：`compact` / `feedback` / `goal` / `permission` / `plan` 五条，后四条带 `input`。
  - execute → `CommandExecution | undefined`；**业务失败不 throw**，在
    `result.kind === 'error'` 的 `text` 里。执行后 `command/run` / `command/done`
    事件照常进会话事件流（会话视图里的 `→ /compact` 行就是这么来的）。
- 网关层失败（`service-unavailable` / `context-not-found` / …）抛 `TypertGatewayError`，
  `code` 是 `TypertGatewayErrorCode` 那 16 个之一。

⚠️ 排障钩子：`DSHR_SLASH_DEBUG=<文件>` 时 bundle 把每次 list/run 的结果与报错追加落盘
（屏幕被 ink 占着，只能往文件写）。
