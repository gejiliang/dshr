# dsh 能力覆盖矩阵

> **这份文件是「dshr 到底实现了 dsh 的多少」的真源**，也是补缺口的施工单。
> 数字都是数出来的，不是估的——每一格都注明了怎么数的。
>
> 重数的办法（改完代码要重跑）：
>
> ```sh
> sh tools/coverage.sh
> ```
>
> **别手写 grep 数 RPC**，两个坑都真踩过：
>
> 1. 命令注册表里的命令名（`session.interrupt` / `session.switch`）长得跟 RPC 一模一样，
>    直接 grep 会把它们算成 RPC，数字虚高——必须**与 `RpcMethodMap` 求交集**
> 2. 全表大小要从**上游类型**读：`dsh-contract.md` §三 的标题原先写「51 个」，
>    实际是 **52** 条（它自己列的那张表就是 52 条）。文档措辞会过期，类型不会
>
> `host.close` 是 dshr 自己 spawn 的 host 对象上的本地方法，**不是 RPC**，不计入。

## 三个分母（2026-08-17 首测于 rc.6；2026-08-20 在 **rc.8** 上重算）

| 面 | 起点 | 现在 | 说明 |
|---|---|---|---|
| RPC 方法 | 9 / 52 | **31 / 52** | 全表 rc.6→rc.7→rc.8 逐条 diff 过，**零增零删** |
| 下行帧 | 19 / 19 | 19 / 19 | MuxFrame 10 + HostFrame 9，**一开始就全接了** |
| 会话事件（fold 认得的） | 8 / 39 | **18 / 43** | 上游 `known-event-types.js` 是权威清单；rc.8 把分母从 39 抬到 43 |

> **分母怎么从 39 变成 43 的**：rc.8 新增了 4 个 `team/*` 事件
> （`team/member`、`team/message/delivered`、`team/message/queued`、`team/task`），
> 没有删除任何事件。
>
> ⚠️ 但**别急着去画**：在完整的 rc.8 安装里翻了一遍，这 4 个名字
> **只出现在 `dsh-session` 的 known-event-types 清单里，没有任何代码发射它们**。
> 是提前占的名，不是已上线的功能。等上游真开始发了再接——
> 现在接等于对着空气写 fold 分支。

> ⚠️ **数这些分母只能用 `sh tools/coverage.sh`，别自己 `find | head -1`。**
> pnpm store 里同时躺着好几个版本（升过级就有：rc.6 / rc.7 / rc.8 全在），
> `head -1` 取到哪个由文件系统顺序决定。2026-08-20 实测踩到：
> 它取的是 **rc.6** 的表，于是「rc.8 契约没变」这个结论是拿 rc.6 的表自证的，等于没验——
> 事件数正是这么漏掉那 4 个的。脚本现在跟着 pnpm 真实解析的软链走，并且**会把读到的版本印出来**。

fold 现在认得的 18 个（`grep -oE "case '[a-z]+/[a-z/_-]+'" packages/state/src/conversation.ts`）：

```
assistant/chunk  assistant/message  command/done  command/run
compaction/end  compaction/prune  compaction/start  compaction/summary
llm/retry  llm/retry-started  plan/mode  step/start  todo/write
tool/call  tool/result  turn/end  turn/start  user/message
```

帧那层是满的，所以连接、重放、状态机完整。**缺口全在两处**：帧收到了但没画，方法根本没调。

## 一、已经端到端通的

建/挂会话、发提示、流式渲染、取消、history 分页、审批（阻塞）、提问（阻塞，可键盘作答）、
workspace 列表/创建/重命名、上下文 token、往 herdr 报 idle/working/blocked/error。

## 二、不算缺口（故意不做）

跑在 herdr 的 pane 里，**这些归 herdr，重做一遍才是错的**——上一次的方向性错误正是重做了 herdr：

`workspace.delete` / `workspace.insertBefore` / `workspace.insertSessionBefore` / `workspace.archiveSession`、
`host.pickDirectory` / `host.listDirectory` / `host.createDirectory` / `host.openPath`（文件与目录选择交给 herdr 与编辑器）。

> ⚠️ 例外：`host.listDirectory` 在做**附件选择器**时可能要用（见 D 批），
> 那不是「管理工作区」，是「在当前会话里挑一个文件」，属于会话内的事。

## 三、缺口与施工批次

排序依据：**故障时界面在骗人 > 天天要用 > 有它更好**。

### A 批 —— 感知类（纯渲染，不新增 RPC）

帧已经收到了，只是没画。**风险最低、价值最高**——其中压缩与重试属于「界面在骗人」。

| 事件 | 现状 | opencode 的展现（判据见 §四） |
|---|---|---|
| `compaction/start` `end` `summary` `prune` | 完全无感知，上下文被压缩时界面什么都不发生 | 一条居中标题的横线 `──── Compaction ────`，`borderActive` 色，`marginTop=1` |
| `llm/retry` `llm/retry-started` | 完全无感知，网关重试时看起来就是卡住 | 行内 `↳ Retrying (attempt N) · <消息>`，所在行整体 `error` 色 |
| `todo/write` | 不画 | `[✓] 内容`（完成，muted）／`[•] 内容`（进行中，warning）／`[ ] 内容`（待办，muted） |
| `plan/mode` | 不画 | composer 的模式标签（opencode 的 `Build` ↔ `Plan` 就是这个位置） |
| `command/run` `command/done` | 不画 | 斜杠命令的执行痕迹，走工具行的形状 |
| `subagent/descriptor` | 不画 | `✓ General Task — <描述>` + `↳` 子行；未完图标 `│`，完成 `✓` |
| `goal/change` | 不画 | 通知行（E 批） |
| `session/queue` | **帧进了 switch 就被 `break` 丢掉**，state 根本没存 | 反色徽章 ` QUEUED `，底色用 agent 色 |
| `session/jobs` | 同上，被丢掉——**后台任务在界面上完全不存在**（D 批已补：快照 + chip + 列表） | 见 D 批 |
| ~~`hook/invoked` `hook/result`~~ | **本部署上不可能触发** | — |
| ~~`schedule/change`~~ | 同上 | — |

> **`hook/*` 与 `schedule/change` 不实现，理由是实测的**：
> `settings.describe` 的返回（14393 字符）里 **`hook` / `schedule` 一个字都没出现**——
> 这台部署没装那两个插件，事件不可能到达。它们出现在 `known-event-types.js` 里，
> 只是给**未安装的插件**预留的名字。
>
> 盲画一个永远不会出现、也无法验证的行，等于往代码里放一段没人能证伪的东西。
> 将来要做，先按这个顺序验：
> 1. `settings.describe` 里能搜到 `hook` → 说明插件装上了
> 2. 用**独立的 `DSH_HOME`** 起一台自己的 host（别动用户的 `~/.dsh`），配一个 hook
> 3. `node tools/probe-gaps.mjs` 打出真实载荷，补进 `gap-shapes.md`
> 4. 再写渲染

> ⚠️ `session/queue` 与 `session/jobs` 的措辞要准：不是「收到了没画」，
> 是 `packages/state/src/state.ts` 里这两个 case 直接 `break`，**没有任何存储**。
> 要渲染得先在 state 层存下来。
>
> `session/jobs` 是**后来才发现的缺口**（原清单漏了）。判据：dsh 自带
> `job_list` / `job_kill` / `job_output` 三个工具，说明后台任务是真实存在的东西，
> 而 dshr 一个都不显示。`JobView` 的形状见 [`gap-shapes.md`](gap-shapes.md) §十。

### B 批 —— 命令面板（前置件）

**A 批之后的所有东西都需要一个入口**。opencode 的面板本身没有逻辑，它是
`DialogSelect` 套在一个**命令注册表**上。要移植的是两个原语：

1. `DialogSelect` —— 通用可搜索选择对话框（布局常数见 §四）
2. 命令注册表 —— `{ name, title, desc, category, hidden, suggested, bindings }`

> 这与本项目「编排层只提供动词」的纪律一致：注册表里是动词，不是语义类型。

键位（opencode 实测）：`ctrl+p` 开面板；`tab` **就地循环** agent preset（不是对话框）。

### C 批 —— 会话与模型（2026-08-17 落地）

| 方法 | 用途 | 展现 |
|---|---|---|
| `session.models` `session.selectModel` | 切模型 | ✅ `Select model` 对话框：groups→category、name→标题 + muted provider、当前项 `●`；选中即切，composer/footer 跟着变（state 播种 summary.model/provider） |
| `agentPreset.list` `select` | 切预设 | ✅ **两个入口**：`tab` 就地循环（composer 那行原地变，实测 Standard→Code→Minimal→Cordis）+ 面板项 `Switch agent preset` 弹对话框。⚠️ host 只允许 blank 会话切（`agent-preset-locked`），被拒时出可读提示 |
| `session.list` `session.search` | 切会话 | ✅ `Sessions` 对话框走 `session.list`；`search` 是增强（本部署实测关着，自动退回本地过滤）。底部动作条只有 `rename ctrl+r`——**dsh 没有 pin，delete 归 herdr，不造** |
| `session.rename` | 重命名 | ✅ 会话列表里 `ctrl+r` 弹 `DialogPrompt`（单行输入）；返回的 `{title, seq}` 直接 settle 投影格 |
| `session.fork` | 分叉 | ✅ 面板项；成功切到分叉会话，没有已完成轮时显示可读的 `fork-unavailable` 提示，不静默失败 |

`agentPreset.read` / `copy` / `openDocument` / `remove` 是写作面（loopback 钉死的特权方法），
C 批没做——面板只放动词，不画按不动的按钮。

### D 批 —— 输入类

| 方法 | 用途 | 状态（2026-08-17） |
|---|---|---|
| `session.attachment` | 发附件／图片（契约里 `imageLimits` 投影就是给这个用的，提交前拒超限） | ✅ 发送路径完成：附件走 `session.prompt` 的 `content`（没有上传 RPC）；`Attach image` 命令读本地文件→base64→提交前自查 `imageLimits`。读回接口本身没做（没有要它的界面） |
| `session.updateQueue` | 队列可改（`session/queue` 帧已收，但改不了） | ✅ `remove` 完成（QueueDock 有 `ctrl+x` 可见入口，选中即删）。`edit`/`steer` 的其余字段**没打到**，按纪律不做 |
| `skill.list` | 技能列表 | ✅ 完成（`View skills` 命令 → DialogSelect，只读） |
| `session/jobs` | 后台任务（mux 帧，原清单漏了） | ✅ 完成：state 存整份快照，底部栏 running 计数 chip，`View background jobs` 命令列详情。杀任务是模型的 `job_kill` 工具，不造 RPC |

### E 批 —— 配置类

`settings.describe` `openDocument` `update` `replace` `mutate`、
`credentials.describe` `set` `unset`、`llm.providers` `models` `discoverModels`、
`goal.create` `edit` `pause` `resume` `complete` `clear`。

**E 批已落（2026-08-17）；2026-08-18 设置与凭证改成 TUI 内可写**。
起因是一次真实的设计错误：`openDocument` 弹的是**宿主机桌面**的编辑器，SSH 过来的人
根本看不见（docs/gap-shapes.md §十一）——设置必须能在 TUI 里改完：

- `Settings` → **TUI 设置编辑器**（新默认入口）：命名空间 → 字段 → 按类型编辑的三层下钻，
  schema 走查器把 schemastery 序列化格式走成字段树（`@dshr/state`，纯函数）。
  枚举（union of const）给选择列表、number 按 meta.min/max/step 本地校验（不合法不提交）、
  boolean 就地切换、object 下钻、array/dict 这一版只读且标明。restart 命名空间标出。
  写只走 `settings.mutate`（字段路径粒度 + `expectedRevision` CAS，返回带新 revision，
  不再 describe）；CAS 撞了（`settings-conflict`）原样显示 host 的可读消息。
  `role: 'secret'` 字段值永不下线，只显示 configured / not configured，不提供输入。
- `Open settings file on the host machine` → `settings.openDocument`（保留，名字说清楚它干什么）
- `Configure credentials` → ref 从设置的 `apiKeyEnv` 字段发现 + `credentials.describe`；
  **`credentials.set` 走掩码输入**（ssh/sudo 同款，真值不上屏、不进日志与回执）、
  `unset` 有一步确认；`writable: false` 的只读展示，点了给理由。
  `dsh-credentials-local` 是 host 管理的专用凭证存储（不物化进环境、跨进程写锁），
  上游本来就预期客户端提供录入入口——与「凭证不进仓库」不冲突（进的是 dsh 的存储）。
- `View providers` / `View models` → `llm.providers` / `llm.models` 只读
- 目标：侧栏 Goal 块读 `goal` 投影；`Create goal`（收 objective）+ `Pause` / `Resume` / `Complete` / `Clear`
  按 phase 显隐，ref 派发时现读（revision 会被自动轮次推进，实测撞过 STALE）。
  `goal.edit` 与 `llm.discoverModels` 没接（前者需要编辑 UI，后者会打真实 provider 端点）。
- **没包进 state 层的**：`settings.update` / `replace`——粒度太粗，改一个字段会把并发的
  别处改动盖掉，表单只认 `mutate`。

真实截屏（mock + 隔离 DSH_HOME + tmux 150×45）：
`docs/screenshots/settings-editor-namespaces.txt`（命名空间列表）、
`settings-editor-secret.txt`（secret 字段只显示配置状态）、
`settings-editor-enum.txt`（枚举选择，当前值 ●）、
`settings-editor-mutate-receipt.txt`（改完的回执与新 revision）、
`credentials-set-masked.txt`（凭证掩码录入后的 Configured 态）。
另见 `e-batch-providers.txt`。

## 四、opencode 展现的判据

**A 批与 B 批的形状都来自实物**，不是照源码想象的：

- **命令面板、模型对话框、会话列表** —— 2026-08-17 用 tmux 抓的 opencode 1.18.18 真实画面，见 [`opencode-dialogs.md`](opencode-dialogs.md)
- **todo / 压缩 / subagent / 重试 / queue 徽章** —— 读的上游源码
  （`packages/tui/src/component/todo-item.tsx`、`routes/session/index.tsx`），
  因为实测它们需要真实模型调用（要花钱），而这几样纯粹是渲染

`DialogSelect` 的布局常数（`packages/tui/src/ui/dialog-select.tsx`）：

| 部位 | 值 |
|---|---|
| 标题行 | `paddingLeft=4 paddingRight=4`，标题左、`esc` 右 |
| 搜索框 | 占位符 `Search`，muted；聚焦底色 `backgroundPanel`，光标 `primary` |
| 列表 | `paddingLeft=1 paddingRight=1`，分组间 `paddingTop=1` |
| 条目 | 当前项有 gutter 时 `paddingLeft=1`，否则 `3`；`paddingRight=3` |
| 选中行 | 底色 `theme.primary` |
| 条目文字 | 标题 `text` 色 + 后缀标签 muted；标题截断到 61 列 |
| 详情行 | `paddingLeft=3 paddingRight=3`，`truncateMiddle(detail, min(76, width-12))` |
| 空结果 | `No results found`，muted，`paddingLeft=4` |
| 底部动作条 | `paddingLeft=4 paddingRight=2`，`space-between` |
| 搜索排序 | 模糊匹配 `keys: ["title","category"]`，标题权重 2、分类 1 |
| 过滤态 | 一旦有输入，**丢掉 `Suggested` 分组** |

## 五、复核

改完任一批，重跑 `sh tools/coverage.sh` 更新分母，并**贴一张真实截屏**对照
`opencode-dialogs.md` 里的对应图。对不上就继续改——
不要贴一张对不上的图然后说做完了。

## 六、修过的坑（结论，别再重新推理一遍）

### 对话超过一屏后 Sidebar 内容消失 —— 已修（`6772be8`）

**根因不是宽度，是高度。** 当时先猜「左列内容超高时 yoga 把右栏挤没了」，
按这个猜想给会话列钉死 `width` + `flexShrink={0}`——**没用**。

真正的原因：`Conversation.tsx` 的 `entryRows()` 估算行数时**漏算了每个行组件的
`marginTop={1}`**（MessageRow / ToolRow / ReasoningRow / AwarenessRows / TurnRow 全都有），
每条少算一行。150×45 下连发十轮 = 30 个条目 = 少算 30 行：预算 37 行，
实际渲染 ~67 行 → 整个 row 比终端高 → 终端滚动 → **矮且贴顶的右栏被顶出画面**。

修法是把 margin 算进估算，并**宁可高估**（高估只少显示一条历史，低估毁掉整个布局）。
回归测试 `packages/tui/test/conversation.test.ts` 断言的是**实际渲染行数 ≤ maxRows**，
不是估算值本身——把 margin 改回 0 会立刻红（实测 `渲染 31 行，超过预算 20 行`）。

### 命令面板里 `Switch model` 一搜就消失 —— 已修（`e9f779f`）

`suggested` 的命令被**归类**成 `Suggested` 分组，而过滤时「丢掉 Suggested」的实现
把**条目本身**删了，于是最要紧的那条命令反而搜不到（搜 `model` 返回 `No results found`）。

上游 `command-palette.tsx` 的 `list()` 是「suggested 副本 + 完整列表」**两段拼接**，
副本 value 加 `suggested:` 前缀。dshr 用 `DialogSelectOption.onlyWhenFiltered` 表达同一语义：
未过滤只显示副本，过滤只显示本体。**`filterOptions` 的 `query === ''` 分支别改回 `[...options]`**，
有回归测试钉着。

## 七、还剩 24 个方法没接 —— 分类与理由

跑 `sh tools/coverage.sh` 看当前列表。到 2026-08-17 为止剩下的，按**为什么不接**分四类：

| 类 | 方法 | 理由 |
|---|---|---|
| **归 herdr** | `workspace.delete` / `insertBefore` / `insertSessionBefore` / `archiveSession`、`host.pickDirectory` / `listDirectory` / `createDirectory` / `openPath` | 工作区与文件选择是 herdr 的活，重做一遍就是上次那个方向性错误 |
| **故意不做** | `settings.update` / `replace` / `mutate`、`credentials.set` / `unset` | 上游给了 `settings.openDocument`，意图就是用编辑器改配置。**在终端里明文输密钥是坏主意**，且本项目章程规定凭证值只进 gitignored 的 `secrets/` |
| **形状没打到 / 打不了** | `session.attachment`（读回接口，发图走 `session.prompt`，见 §gap-shapes 八）、`llm.discoverModels`（会打真实 provider，验证期不该调）、`agentPreset.read` / `copy` / `openDocument` / `remove`（写作面，loopback 钉死的特权方法）、`goal.edit` | 见各自条目 |
| **真缺口，还没做** | `subagent.list` / `history` / `prompt` / `interrupt` | ⬅️ **这是唯一一条「本可以做但没做」的**。A 批画出了父会话里的 subagent 工具行（`✓ General Task — …`），但**进不去子会话**——看不到它干了什么、也发不了话给它。要做得先解决 `gap-shapes.md` §五 记的那个问题：实测 `host/session-added` **没带** `parentSessionId` / `origin`，父子关联无从建立 |
