# opencode 的对话框（实测截屏）

> 2026-08-17，opencode **1.18.18**，`tmux capture-pane -p`，150×45。
> 与 [`opencode-reference.md`](opencode-reference.md)（会话主体）配套，这份只管**对话框**。
>
> **这些是实物，不是照源码想象的。** 布局常数见 [`coverage.md`](coverage.md) §四。
> 抓法：`tmux -L oc new-session -d -x 150 -y 45 -c <空目录> opencode`，
> 然后 `send-keys` 发键位、`capture-pane -p` 取画面。

## 键位（从空状态提示行读到的，不是猜的）

空状态 composer 下面那行写着：

```
tab agents  ctrl+p commands
```

- **`ctrl+p`** —— 命令面板（**不是** `ctrl+k`）
- **`tab`** —— **就地循环** agent preset，不弹对话框。
  实测：composer 的模式行从 `Build · deepseek-v4-flash Newapi (quota-proxy)`
  变成 `Plan · deepseek-v4-flash Newapi (quota-proxy)`，画面其余部分不动。
- 面板里的命令自带 `ctrl+x <字母>` 二级键位（见下）

## 一、命令面板 `ctrl+p`

```
                                                 Commands                                         esc

                                                 Search

                                                 Suggested
                                                 Switch model                                ctrl+x m

                                                 System
                                                 Hide tips                                   ctrl+x h
                                                 Plugins
                                      ┃          Install plugin
                                      ┃  Ask     View status                                 ctrl+x s
                                      ┃          View debug info
                                      ┃  Buil    Switch theme                                ctrl+x t
                                      ╹▀▀▀▀▀▀    Switch to light mode                                    ▀▀▀▀▀▀▀▀
                                      tab age    Lock theme mode
                                                 Help
                                                 Open docs
                                                 Exit the app                ctrl+c, ctrl+d, ctrl+x q
                                                 Toggle debug panel
```

要点：

- **是浮层，不铺满**——左边能看见底下的 composer（`┃  Ask`、`tab age`）
  和那条 `▀` 横线从浮层两侧穿出去。**没有边框字符**，靠底色区分。
- 标题行：`Commands` 左、`esc` 右
- `Search` 是占位符（muted）
- 分类标题（`Suggested` / `System` / `Plugins` / `Help`）自成一行，前面空一行
- 条目：标题左，键位右对齐；多个键位用 `, ` 连（`ctrl+c, ctrl+d, ctrl+x q`）
- `Suggested` 分组只在**未输入**时出现

搜索态（输入 `session` 后）：

```
                                                 Commands                                         esc

                                                 session

                                                 Session
                                                 New session                                 ctrl+x n
                                                 Move session Move to another project dir
                                                 Switch session                              ctrl+x l
                                                 Open editor                                 ctrl+x e

                                      ┃          System
                                      ┃  Ask     Disable session directory filtering
```

- `Suggested` 分组消失了
- `Move session Move to another project dir` —— **标题后面直接跟 muted 的说明**，同一行，无分隔符

## 二、模型对话框 `ctrl+x m`

```
                                                 Select model                                     esc

                                                 Search

                                                 Favorites
                                                 GPT-5.6 Sol OpenAI

                                                 Recent
                                                 ark-kimi-k3 Newapi (quota-proxy)
                                                 deepseek-v4-pro Newapi (quota-proxy)
                                      ┃        ● deepseek-v4-flash Newapi (quota-proxy)
                                      ┃  Ask     GPT-5.4 mini OpenAI
                                      ┃
                                      ┃  Buil    OpenCode Zen
                                      ╹▀▀▀▀▀▀    Nemotron 3.5 Lightning Free                     Free    ▀▀▀▀▀▀▀▀
                                      tab age    DeepSeek V4 Flash Free                          Free
                                                 Laguna S 2.1 Free                               Free
                                                 Hy3 Free                                        Free
                                                 Nemotron 3 Ultra Free                           Free
                                                 MiMo V2.5 Free                                  Free

                                                 Connect provider ctrl+a  Favorite ctrl+f
```

要点：

- **当前项用 `●` 标在 gutter 里**（`deepseek-v4-flash` 那行），
  它比别的条目**往左突出两列**——源码里就是
  `paddingLeft={current() || option.gutter ? 1 : 3}`
- 条目 = 模型名（`text` 色）+ 空格 + provider（muted）
- 右侧可挂标签（这里是 `Free`）
- 分类是 provider 名（`Favorites` / `Recent` / `OpenCode Zen`）
- 底部动作条：`Connect provider ctrl+a  Favorite ctrl+f`

## 三、会话列表 `ctrl+x l`

```
                                   Sessions                                                                     esc

                                   Search


                                   No results found

                                   pin/unpin ctrl+f  delete ctrl+d  rename ctrl+r
```

要点：

- **这个浮层比命令面板宽**——宽度按对话框定，不是全局常数
- 空态是 `No results found`（muted）
- 底部动作条挂三个二级动作：`pin/unpin ctrl+f`、`delete ctrl+d`、`rename ctrl+r`
  ——**重命名是会话列表里的一个动作，不是独立入口**

## 四、dshr 必然不同的地方

### 不做浮层 —— 这是能力差异，不是偷懒

opencode 的对话框是**渲染器级的浮层**：上面每张图里都能看见浮层左边露出的
composer（`┃  Ask`）和从两侧穿出去的 `▀` 横线。它自带终端渲染器
（`<box>`/`<text>`/`<scrollbox>`），能做绝对定位与合成。

**dshr 用的是 ink，ink 没有浮层**——没有绝对定位，也没有 z 序。
要做出上面那种效果只能自己合成字符缓冲区，等于重写渲染器。

**因此 dshr 的对话框是整区接管**：打开时对话框占据会话区，composer 与底部栏保留。
**内部布局逐项照搬**（标题行 + `esc`、`Search`、分类、条目、`●` gutter、底部动作条），
只是不浮在内容上面。

改这条判断前先问：ink 6 有没有出浮层原语；没有就别改。

### 其余

- opencode 的 `Build` / `Plan` 在 dsh 这边是 **agentPreset**，名字不一样（dsh 默认 `Standard`）
- `Install plugin` / `Switch theme` / `Toggle debug panel` / `Open docs` 是 opencode 自己的，dshr 没有
- opencode 的会话列表带 pin，dsh 没有这个概念；dsh 有的是 `workspace.archiveSession`，
  而**归档在 dshr 里归 herdr**（见 `coverage.md` §二）
- `Exit the app` 在 dshr 里是 Ctrl-C（已实现，且是自己盯 stdin 的 0x03，见 `main.tsx` 的注释）
