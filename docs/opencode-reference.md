# opencode 的样子（实测截屏，2026-08-16）

> 产品要求是「**TUI 我喜欢 opencode 的风格**」。
> 这份文档是那句话的判据——不是我对 opencode 的印象，是 opencode `1.18.18`
> 在这台机器上跑起来的真实画面，用 `tmux capture-pane` 抓的。
>
> **改 TUI 之前先看这里。** 第一版是照着想象做的，做出来是个圆角框，
> 和 opencode 没有一处相同。同样的错误在 herdr 那边也犯过一次
> （见 [`herdr-reference.md`](herdr-reference.md)）。
>
> 复现：
> ```sh
> tmux -L oc new-session -d -x 150 -y 45 "$HOME/.opencode/bin/opencode"
> tmux -L oc capture-pane -p -t 0
> tmux -L oc kill-server
> ```

## 一、空状态

```
                                    ▄
               █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█
               █  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀
               ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀

     ┃
     ┃  Ask anything... "What is the tech stack of this project?"
     ┃
     ┃  Build · deepseek-v4-flash Newapi (quota-proxy)
     ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
     tab agents  ctrl+p commands

  ~/path/to/cwd                                          1.18.18
```

1. **输入框不是框**：左边一条 `┃`，底下一道 `▀` 横线，左下角 `╹`。**没有右边框、没有上边框、没有圆角。**
   dshr 第一版画的是完整圆角框 `╭───╮`，一处都不对。
2. **模式与模型写在输入框里**（`Build · <model> <provider>`），不是单独的状态行。
3. 输入框下面一行是**快捷键提示**：`tab agents  ctrl+p commands`。
4. **最底一行**：左 cwd，右版本号。
5. 空状态中央是 ASCII logo。

## 二、有对话时

```
  ┃                                                        一句话解释 TUI
  ┃  用一句话说明什么是 TUI
  ┃                                                        Context
                                                           10,209 tokens
     + Thought: 256ms                                      0% used
     TUI（Text User Interface）是运行在终端里…               $0.00 spent
     介于命令行和 GUI 之间，键盘友好。
                                                           LSP
     ▣  Build · deepseek-v4-flash · 2.1s                   LSPs are disabled

  ┃
  ┃  列出当前目录下的文件
  ┃

     → Read .

     当前目录为空。

     ▣  Build · deepseek-v4-flash · 1.5s
```

逐条，**每条都和 dshr 第一版不同**：

| | opencode | dshr 第一版 |
|---|---|---|
| 用户消息 | 左侧**粗**竖线 `┃`，上下各留一行空 | 细线 `│` cyan |
| 助手消息 | **完全没有竖线**，只是缩进（5 空格） | 细线 `│` gray |
| reasoning | 折成一行 `+ Thought: 256ms`，`+` 表示可展开 | `✻` + dim 斜体首行 |
| 工具调用 | `→ Read .`（箭头 + 工具名 + 参数） | `⏺ bash(npm test)` + `⎿` 结果行 |
| 每轮结尾 | `▣  Build · <model> · <耗时>` | 无 |
| 右侧 | **一整列会话信息**：标题、Context/tokens/用量/花费、LSP | 无 |

**右侧那一列是结构性的**，不是装饰：会话标题、上下文用量、花费、LSP 状态常驻在那儿。
dshr 把这些塞进了底部一行，位置和信息量都不一样。

## 三、dshr 与 opencode 必然不同的地方

- opencode 是**单会话全屏**应用，所以它能用 ink 的 `<Static>` 那类只追加不重绘的优化，
  也不需要 tab/pane。**dshr 是工作区形态**（herdr 的壳），一个 pane 一个会话——
  所以 opencode 的「整屏就是一个会话」在 dshr 里是「**一个 pane 内部**长这样」。
- 因此 opencode 的最底那行（cwd / 版本）在 dshr 里由外壳的底部栏承担，不重复。
- 右侧信息列在 dshr 里应当**属于 pane**，多 pane 时每个 pane 自己有（或在窄 pane 时折叠）。

## 四、状态

**尚未实现。** dshr 现在的会话视图是第一版凭想象做的样子，与本文档不符。
