# 日常怎么用

> 这份是**给人看的**。想验证它是不是真能跑，看 README 的 Verifying 一节。

## 一、装一次

```sh
cd ~/Workspace/idiotStudio/dshr
pnpm install && npx tsc --build
sh tools/install.sh
```

装的是一层薄包装而不是软链，因为它要多做一件事：**自动把凭据带进环境**。
dsh 的 `apiKeyEnv` 是引用，值必须在环境里；不这么做的话每开一个新终端
都得先 `source` 一次，那就不叫能用了。

改了源码要重新 `npx tsc --build`——命令跑的是构建产物，不是源码。

## 二、配一个真模型

dshr 自己不管模型，它只是 dsh 的一个 surface；模型配在 **`~/.dsh/settings.yaml`**。
没有这一步的话界面能起来，但一提问就报 provider 相关的错。

```yaml
llm-pi-ai:
  providers:
    quota-proxy:
      apiKeyEnv: QP_API_KEY          # ← 只写变量名，密钥不进这个文件
      api: openai-completions
      baseURL: https://<你的网关>/v1
      models:
        - id: <模型 id>
          contextWindow: 1000000
          maxTokens: 65536

agent-default-model:
  provider: quota-proxy
  model: <模型 id>
```

然后把那个变量的来源写进 **`~/.dsh/env.sh`**——`tools/install.sh` 装的包装脚本
每次都会 source 它，所以配一次就够，不用动 `~/.zshrc`：

```sh
# ~/.dsh/env.sh
# 别在这里写死密钥：从你已有的凭据源现取（下面这行是从 pi 的配置里取）。
QP_API_KEY="$(node -p "require(process.env.HOME + '/.pi/agent/models.json').providers['quota-proxy'].apiKey" 2>/dev/null)"
export QP_API_KEY
```

`dshr` 拉起的 host 是子进程、会继承环境，所以 `dshr` 和 `dshr server` 都覆盖到了。

三个坑，都是踩出来的：

- **`apiKeyEnv` 不能省。** 完全不配凭据的路由会走 pi-ai 的「环境发现」，
  而手工声明的路由在那儿什么也发现不到，直接 `PI_AI_ERROR: No API key`。
- **`models` 列表是替换而不是追加**：写了它，这条路由就只认列表里的模型。
- 想改一个模型的参数而保留其余 catalog，用 `modelOverrides`，别用 `models`。

配好之后自查（不进 TUI）：

```sh
DSH_HOME=~/.dsh npx @deepseek-ai/dsh@0.1.0-rc.6 --profile headless "回一句话"
```

这一句能出结果，dshr 就一定能用——它跟 TUI 走的是同一个 host 平面。

## 三、让 herdr 的每个 pane 都是一个会话

这是它设计出来要用的方式——**你基本不用手敲 `dshr`**：

```toml
# ~/.config/herdr/config.toml
[terminal]
default_shell = "dshr"
```

改完 `herdr server reload-config`（或重开会话）。之后：

- 在 herdr 里开一个 pane = 开一个 dsh 会话
- 分屏 / 新 tab / 新工作区 —— **全是 herdr 自己的键**，dshr 不参与
- 侧栏会把每个 pane 显示成一个 `dsh` agent，带实时 `idle` / `working` / `blocked`
- 关掉 pane 只是 detach：会话在 host 上**强制落盘**，`dshr --resume <id>` 随时接回来

> dshr 只做一个 pane 内部的那个会话。工作区、tab、pane、侧栏都是 herdr 的活——
> 早期版本在 herdr 旁边复刻了一整套，是方向性错误，已删（`git log -- packages/shell`）。

### 手敲的用法（不在 herdr 里，或者要指定会话时）

```sh
dshr                       # 在当前目录开一个新会话
dshr --resume <sessionId>  # 打开某个已存在的会话
dshr --connect <url>       # attach 到别人起好的 host
dshr --port 39080          # 指定 host 端口（默认 39080）
dshr server                # 只起 host、不开 TUI
```

不在 herdr 里跑时，状态上报自动关闭（判据是有没有 `HERDR_PANE_ID`），其余一模一样。

## 四、界面怎么用

界面照搬 opencode（判据见 [`opencode-reference.md`](opencode-reference.md) 的实测截屏）：

```
  ┃  你问的话                        会话标题
  ┃                                 ~/当前目录
     + Thought: 256ms               ← reasoning 折成一行
     助手的回答（没有竖线，只缩进）    Context
     → Read .                       12.3k tokens
     ▣ Standard · <model> · 2.1s    9% used
  ┃
  ┃ Ask anything...
  ┃  Standard · <model> <provider>
  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
                    enter send  shift+enter newline
~/当前目录                        • connected  <model>
```

- 直接打字，回车发送，`shift+enter` / `ctrl+j` 换行
- **卡住时输入框会让位给审批/提问面板**——那是唯一需要你介入的状态，
  herdr 侧栏那边同时会把这个 pane 标成 `blocked`
- pane 窄于 100 列时右侧信息列自动收起（herdr 的 pane 常常就这么窄）
- `Ctrl-C` 退出 dshr。**不会杀掉 host 上的会话**，也会把 agent 身份交还给 herdr

## 五、不灵的时候

| 现象 | 多半是 |
|---|---|
| `Cannot find package …` | 忘了 `pnpm install && npx tsc --build`。**改完源码或拉了新代码一定要重建**——`dshr` 命令跑的是构建产物，不是源码。踩过：删包之后忘了在主目录重建，命令直接起不来 |
| 侧栏里看不到这个 pane 是 agent | 只在 herdr 里跑才上报（判据是 `HERDR_PANE_ID`）。手敲 `dshr` 在普通终端里是正常没有的 |
| 界面起来但一提问就报错 | `~/.dsh/settings.yaml` 没配，或 `QP_API_KEY` 没 export |
| 整个界面塌成一列 | 终端没报尺寸；已有 80×24 兜底，还塌就把终端信息发我 |
| 起不来、卡在等 host | 看 `/tmp/dshr-host-<port>.log`，那是它拉起的 host 的输出 |
| 想确认不是我在吹 | `node tools/verify.mjs` 和 `expect -f tools/verify-tty.exp` |

## 六、还不能用的东西

- **进不去子 agent 的会话**。对话里能看见 `✓ General Task — …` 这行，但
  `subagent.list` / `history` / `prompt` / `interrupt` 没接，看不到它做了什么、也发不了话给它。
  卡在实测 `host/session-added` 不带 `parentSessionId`／`origin`，父子关联建不起来。
- **插件接缝还是 stub**。`@dshr/bundle` 是 cordis 插件行，但 `startSurface` 目前返回
  `undefined`；实际跑的是「spawn 一个 `dsh web` + 走 loopback HTTP」。
  把这个接缝接上，dshr 才真的是插件，而不是一个恰好会说 dsh 线协议的程序。
- **远程 attach 没做**。host 只绑 loopback，跨机器要 dshr 自带认证层，现在没有。
