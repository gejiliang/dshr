# herdr 的样子（实测截屏，2026-08-16）

> 产品要求是「**用户界面看起来就是 herdr**」。
> 这份文档是那句话的**判据**——不是我对 herdr 的印象，是 herdr 0.8.x 在这台机器上
> 跑起来的真实画面，用 `tmux capture-pane` 抓的。
>
> **改 UI 之前先看这里，别照着想象做。** 第一版就是照着想象做的，结果差得很远。
>
> 复现方法（用隔离会话，别碰 default）：
> ```sh
> env -u HERDR_SOCKET_PATH -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
>   tmux -L look new-session -d -x 150 -y 45 'herdr --session lookonly'
> tmux -L look capture-pane -p -t 0
> herdr session stop lookonly && herdr session delete lookonly   # 收尾
> ```

## 一、单 pane（刚起来的样子）

```
 spaces                  │ 1       +
                         │
 · ~                     │# gejiliang @ mini in ~ [12:02:45]
                         │$
                         │
                         │
 ...                     │
 new                 menu│
─────────────────────────│
 agents          priority│
                         │
                        «│
```

要点，逐条都与我第一版不同：

1. **左栏标题是 `spaces`**，下面是 space 列表（`· ~` 是一个 space）。
2. **左栏底部有一个 2×2 的入口块**：`new` / `menu` 一行，一条横分隔线，`agents` / `priority` 一行。
   → **`agents` 是一个可切换的视图，不是常驻挂在每个 space 下面的列表。**
3. **左栏最底右角一个 `«`**，是折叠指示。
4. **tab 栏在内容区顶部**（竖线右边），不是整屏顶部；形如 ` 1       + `，`+` 是新建。
5. **单 pane 时完全没有边框**，只有 sidebar 与内容之间一条竖线。
6. **没有全局底部状态行**（我做了一条，多余）。
7. pane 里跑的是**真 shell**（`# gejiliang @ mini in ~` / `$`）。

## 二、分屏之后

```
 spaces                  │ 1       +
                         │┌──────────────────────────────┐┌──────────────────────────────┐
 · ~                     ││                              ││                              │
                         ││# gejiliang @ mini in ~       ││# gejiliang @ mini in ~       │
                         ││$                             ││$                             │
 new                 menu││                              ││                              │
─────────────────────────││                              ││                              │
 agents          priority││                              ││                              │
```

→ **有第二个 pane 时才画边框，而且是方角 `┌┐`。** 我一直画圆角框且单 pane 也画，两处都错。

## 三、进入模式时，底部出现提示栏

按 `prefix+w` 之后：

```
« │ NAVIGATE  esc back  up / down ws  ⇥ pane  g navigator  c new tab  v split  - split─  x close  z zoom  r resize  ? keybinds
```

→ **一条随模式变化的键位提示栏。** 我完全没有这个东西，而它正是「不用记键位」的关键。

## 四、键位真源（`herdr --default-config` 的 `[keys]` 段）

前缀是 `ctrl+b`，与我一致；**其余我几乎全定错了**：

| 动作 | herdr | 我的第一版 | |
|---|---|---|---|
| 竖分 | `prefix+v` | `prefix+%` | ✗ |
| 横分 | `prefix+minus` | `prefix+"` | ✗ |
| 移动焦点 | `prefix+h/j/k/l` | 方向键 | ✗ |
| 开关侧栏 | `prefix+b` | `prefix+s` | ✗ |
| 设置 | `prefix+s` | —（`s` 被我占了） | ✗ |
| 新建工作区 | `prefix+shift+n` | `prefix+W` | ✗ |
| 工作区选择器 | `prefix+w` | `prefix+w` | ✓ |
| 新建 tab | `prefix+c` | `prefix+c` | ✓ |
| 上/下一个 tab | `prefix+p` / `prefix+n` | 同 | ✓ |
| 关 pane | `prefix+x` | 同 | ✓ |
| 按序号切 tab | `prefix+1..9` | 无 | ✗ |
| zoom | `prefix+z` | 无 | ✗ |
| resize 模式 | `prefix+r` | 无 | ✗ |
| detach | `prefix+q` | 无 | ✗ |
| 帮助 | `prefix+?` | 无 | ✗ |
| 关 tab | `prefix+shift+x` | 无 | ✗ |
| 重命名 tab/pane/ws | `prefix+shift+t` / `shift+p` / `shift+w` | 无 | ✗ |
| goto | `prefix+g` | 无 | ✗ |

**`prefix+s` 这一条尤其要改**：我把它占成了侧栏开关，而在 herdr 那是设置——
肌肉记忆会直接踩空。

## 五、dshr 与 herdr 必然不同的地方（这些不改）

- **pane 里是 dsh 会话，不是 shell。** 这是产品定义（「新建 tab 和 pane 就默认打开一个 dsh TUI」），
  也是 dshr 存在的理由。herdr 的 pane 是任意终端、agent 跑在里面；dshr 的 pane
  **本身就是**一个有身份、有状态、可寻址的 agent 会话。
- **agent 状态来自 host 的权威事件**，不是从终端画面上猜的。
- 因此 dshr 不需要 herdr 的 agent 探测清单那一整套。

其余凡是「看起来」的部分，以本文的截屏为准。
