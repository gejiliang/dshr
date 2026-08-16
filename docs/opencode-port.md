# 把 opencode 的会话界面搬到 dshr

> 要求原话：「**我需要你尽可能照搬 opencode 的设计**」。
> 所以判据不是「像」，是**逐条对齐**。两个来源：
>
> 1. **实测截屏** —— [`opencode-reference.md`](opencode-reference.md)（`tmux capture-pane` 抓的真实画面）
> 2. **上游源码** —— `sst/opencode` 的 `packages/tui/`，**开源，可以直接读**
>
> 凡是本文与截屏/源码冲突，以后两者为准。

## 一、能搬什么，不能搬什么

opencode 的 TUI 是 **SolidJS + 自研终端渲染器**（元素是 `<box>` / `<text>` / `<scrollbox>`，
用 `createMemo` / `<Show>` / `<Switch>`）。dshr 是 **React + Ink**。

→ **代码搬不了，设计要逐条搬**：结构、宽度、留白、字形、颜色语义、信息取舍。
不要因为「Ink 里不好做」就改设计——先想怎么在 Ink 里做出同样的效果。

## 二、从源码里挖到的硬数值（照抄，别自己定）

**右侧信息列**（`packages/tui/src/routes/session/sidebar.tsx`）：

```
width = 42
paddingTop = 1   paddingBottom = 1
paddingLeft = 2  paddingRight = 2
backgroundColor = theme.backgroundPanel
内容整体是一个 scrollbox；顶部是标题块，底部固定一行版本行
标题：会话标题 **加粗**；下面是 workspace 标签；都用 theme.textMuted 系
底部行：`• OpenCode <version>`，`•` 用 theme.success
```

**底部栏**（`packages/tui/src/routes/session/footer.tsx`）：

```
一行 flexDirection=row，justifyContent=space-between，gap=1
左：当前目录，theme.textMuted
右：一排状态 chip，box gap={2}
    △ N Permissions   theme.warning
    • N LSP           有则 theme.success，无则 theme.textMuted
    ⊙ N MCP           正常 theme.success / 出错 theme.error
```

**主题 token 词汇**（`packages/tui/src/theme/index.ts`）——dshr 的 `theme.ts` 用同一套名字：

```
background  backgroundPanel  backgroundElement
border  borderActive  borderSubtle
text  textMuted
primary  secondary  accent
error  warning  success  info
diffAdded  diffRemoved  diffContext  diffHunkHeader  …（差异视图用，暂不需要）
```

## 三、屏幕结构（对照截屏）

```
┌──────────────────────────────────────────────┬────────────────────────────────┐
│  ┃  用户消息（粗竖线 ┃，上下各空一行）        │ 会话标题（加粗）                │
│                                              │ workspace 标签                  │
│     + Thought: 256ms   ← reasoning 折成一行   │                                 │
│     助手正文（**没有竖线**，缩进 5）          │ Context                         │
│     → Read .           ← 工具：箭头+名+参数   │ 10,209 tokens                   │
│                                              │ 0% used                         │
│     ▣  Build · <model> · 2.1s  ← 每轮页脚     │ $0.00 spent                     │
│                                              │                                 │
│  ┃                                           │ LSP                             │
│  ┃  下一条用户消息                            │ LSPs are disabled               │
│                                              │                                 │
│                                              │ • OpenCode 1.18.18   ← 底部固定  │
├──────────────────────────────────────────────┴────────────────────────────────┤
│  ┃                                                                             │
│  ┃  Ask anything...                     ← 输入框：左 ┃ + 底 ▀ + 拐角 ╹         │
│  ┃                                        **不是框**：没有右边框、没有上边框    │
│  ┃  Build · <model> <provider>          ← 模式与模型写在框内                    │
│  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ │
│  tab agents  ctrl+p commands            ← 输入框下一行：快捷键提示              │
├───────────────────────────────────────────────────────────────────────────────┤
│  ~/path/to/cwd                                    △ 1 Permission   • 0 LSP     │
└───────────────────────────────────────────────────────────────────────────────┘
```

空会话时中间是居中的 ASCII logo（`packages/tui/src/logo.ts`）。

## 四、dshr 的取舍（哪些不照搬，为什么）

- **不做 tab / pane / 工作区切换**：那是 herdr 的活，dshr 跑在它的 pane 里
  （见 [`architecture.md`](architecture.md)）。opencode 的 `dialog-session-list`、
  `dialog-workspace-*` 这些都不移植。
- **底部栏的 chip 换成 dshr 有的东西**：未决审批数（`△`）、连接状态、模型。
  没有 LSP / MCP 就**不要画一个永远是 0 的格子**。
- **`▣ Build · model · 2.1s` 里的「Build」是 opencode 的 agent 模式**；
  dshr 对应的是 agent preset（`session.create` 的 `agentPreset`，默认 `standard`）。
- **右侧信息列的数据源**：`Context` / tokens 来自投影 `contextPressure` 与
  `contextBreakdown`，花费 dsh 暂时没有 → **那一行不画**，不要填 `$0.00` 骗人。
  （投影键名见 [`dsh-contract.md`](dsh-contract.md) 第五之二节。）
- **窄 pane**：herdr 的 pane 可能只有 60 列，右侧 42 列的信息栏放不下。
  宽度不足时（阈值自定，建议 < 100 列）**整列折叠掉**，别把对话挤成一条缝。

## 五、要读的上游源码（都在 `sst/opencode`）

```
packages/tui/src/routes/session/index.tsx      会话主体（90KB，挑渲染部分读）
packages/tui/src/routes/session/sidebar.tsx    右侧信息列（3.8KB，读全）
packages/tui/src/routes/session/footer.tsx     底部栏（3.1KB，读全）
packages/tui/src/routes/session/permission.tsx 审批 → dshr 的 approval
packages/tui/src/routes/session/question.tsx   提问 → dshr 的 question
packages/tui/src/component/prompt/index.tsx    输入框（58KB，挑渲染与键位读）
packages/tui/src/component/logo.tsx            空状态 logo
packages/tui/src/theme/index.ts                主题 token
```

读法（已验证可用）：

```sh
gh api repos/sst/opencode/contents/<path> --jq '.content' | base64 -d
gh api repos/sst/opencode/contents/<dir> --jq '.[].name'
```

## 六、验收：并排截屏，逐项对齐

```sh
# opencode（参照物）
tmux -L oc new-session -d -x 150 -y 45 "$HOME/.opencode/bin/opencode"
tmux -L oc capture-pane -p -t 0

# dshr（本项目）
tmux -L ds new-session -d -x 150 -y 45 "node packages/cli/lib/main.js --connect <host>"
tmux -L ds capture-pane -p -t 0
```

**两张图并排贴进报告，逐条说明对应关系**：输入框的 `┃`/`▀`/`╹`、
助手消息无竖线、`+ Thought:` 折叠、`→ Tool arg` 一行、`▣` 每轮页脚、
右侧信息列、底部 cwd 与 chip。**对不上就继续改，不要贴一张对不上的图说做完了。**
