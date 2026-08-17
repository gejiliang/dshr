# dsh 能力覆盖矩阵

> **这份文件是「dshr 到底实现了 dsh 的多少」的真源**，也是补缺口的施工单。
> 数字都是数出来的，不是估的——每一格都注明了怎么数的。
>
> 重数的办法（改完代码要重跑）：
>
> ```sh
> # RPC 方法：dshr 调了哪些
> grep -rhoE "'(session|subagent|host|workspace|skill|agentPreset|goal|settings|credentials|llm)\.[a-zA-Z]+'" packages/*/src | tr -d "'" | sort -u
>
> # 会话事件：dshr 的 fold 认哪些
> grep -rhoE "'[a-z]+/[a-z/_-]+'" packages/state/src | tr -d "'" | sort -u
>
> # 上游全集（权威清单，不是文档措辞）
> grep -oE "'[a-z]+/[a-z/_-]+'" \
>   node_modules/.pnpm/@deepseek-ai+dsh-session@*/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js \
>   | tr -d "'" | sort -u
> ```

## 三个分母（2026-08-17 实测，dsh 0.1.0-rc.6）

| 面 | 覆盖 | 说明 |
|---|---|---|
| RPC 方法 | 16 / 51 | `host.close` 是 dshr 自己 spawn 的 host 对象上的本地方法，**不是 RPC**，不计入；
    grep 会多匹配到命令注册表里的 `session.interrupt` / `session.switch`（命令名，不是 RPC），不计 |
| 下行帧 | 19 / 19 | MuxFrame 10 + HostFrame 9，**全接了** |
| 会话事件 | 8 / 39 | 上游 `known-event-types.js` 是权威清单 |

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
| `session/jobs` | 同上，被丢掉——**后台任务在界面上完全不存在** | 见 D 批 |
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

| 方法 | 用途 |
|---|---|
| `session.attachment` | 发附件／图片（契约里 `imageLimits` 投影就是给这个用的，提交前拒超限） |
| `session.updateQueue` | 队列可改（`session/queue` 帧已收，但改不了） |
| `skill.list` | 技能列表 |

### E 批 —— 配置类

`settings.describe` `openDocument` `update` `replace` `mutate`、
`credentials.describe` `set` `unset`、`llm.providers` `models` `discoverModels`、
`goal.create` `edit` `pause` `resume` `complete` `clear`。

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

改完任一批，重跑 §开头那三条 `grep` 更新分母，并**贴一张真实截屏**对照
`opencode-dialogs.md` 里的对应图。对不上就继续改——
不要贴一张对不上的图然后说做完了。
