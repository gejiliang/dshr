# 日常怎么用

> 这份是**给人看的**。想验证它是不是真能跑，看 README 的 Verifying 一节。

## 一、装一次

```sh
cd ~/Workspace/idiotStudio/dshr
pnpm install && npx tsc --build
sh tools/install.sh
```

装的是一层薄包装而不是软链，因为它要多做一件事：**自动把凭据带进环境**。
dsh 的 `apiKeyEnv` 是引用，值按「凭据库 → 启动环境 → `.env`」解析；包装脚本负责
source `~/.dsh/env.sh`，所以即使凭据库里没有，每开一个新终端也不用手动 source。
（0.2 起推荐把 key 存进 dsh 凭据库，见下一节。）

改了源码要重新 `npx tsc --build`——命令跑的是构建产物，不是源码。

## 二、配一个真模型

dshr 自己不管模型，它只是 dsh 的一个 surface。**dsh 0.2 起不再读 `~/.dsh/settings.yaml`**
（那是 0.1 的机制；升级时旧文件会被导入一次、改名成 `settings.yaml.imported`），
provider 路由写在 **patch 层**：机器级的 `$DSH_HOME/cordis.patch.yml` 对所有 profile 生效，
排在 profile 自己的 `cordis.patch.yml` 之后——同 id 是**整条 config 替换**，不是逐字段合并。
没有这一步的话界面能起来，但一提问就报 provider 相关的错。

本机现有配置（`~/.dsh/cordis.patch.yml`）长这样，dsh 走 QP：

```yaml
- id: llm-pi-ai
  config:
    providers:
      quota-proxy:
        apiKeyEnv: QP_API_KEY          # ← 只写变量名，密钥不进这个文件
        api: openai-completions
        baseURL: https://qp.gejiliang.com/v1
        models:                        # 替换该路由的 catalog：写了它，这条路由只认列表里的模型
          - id: deepseek-v4.1-flash
            contextWindow: 1048576
            maxTokens: 393216
            reasoningEfforts: { off: none, low: low, high: high, max: max }
```

默认模型是另一条 patch（放 profile 层，比如 `~/.dsh/profiles/dshr/cordis.patch.yml`）：

```yaml
- id: agent-default-model
  config:
    provider: quota-proxy
    model: deepseek-v4.1-flash
```

**凭据**：`apiKeyEnv` 只是引用，值不进 patch。dsh 的解析顺序是
`$DSH_HOME/.credentials.yaml` 的 `refs`（stored，0600；Web 的 Models 页写这里）→
启动环境 → 项目 `.env` → `$DSH_HOME/.env`。
注意 `headless` bundle 默认把 `credentials` 行 disabled（CI 取向，只认环境变量）；
本机已在 `profiles/headless/cordis.patch.yml` 里打开，dump 里看到 `disabled: false` 才算数。

dsh 在 QP 侧是独立租户（key id 42 / name `dsh`）。受限副本在
`~/.gbase/secrets/quota-proxy/clients/dsh.key`（父目录 700、文件 600），权威副本在密码管理器；
`~/.dsh/env.sh` 从那里取（pi 的 key 只作回退）——`tools/install.sh` 装的包装脚本
每次都会 source 它，所以配一次就够，不用动 `~/.zshrc`：

```sh
# ~/.dsh/env.sh（实际内容以文件为准；要点是别把 key 写死在这里）
QP_API_KEY="$(cat "$HOME/.gbase/secrets/quota-proxy/clients/dsh.key")"
export QP_API_KEY
```

`dshr` 拉起的 dsh 是子进程、会继承环境，所以两条路都覆盖到了。

三个坑，都是踩出来的：

- **`apiKeyEnv` 不能省。** 完全不配凭据的路由会走 pi-ai 的「环境发现」，
  而手工声明的路由在那儿什么也发现不到，直接 `PI_AI_ERROR: No API key`。
- **`models` 列表是替换而不是追加**：写了它，这条路由就只认列表里的模型。
- 想改一个模型的参数而保留其余 catalog，用 `modelOverrides`，别用 `models`。

配好之后自查（不进 TUI，也不需要 export 任何变量——凭据库会解析）：

```sh
dsh --profile headless "回一句话"
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
dshr                       # 跑 dsh --profile dshr：一个进程、零端口、界面在插件里
dshr --resume <sessionId>  # 打开某个已存在的会话
dshr --connect <url>       # attach 到别人起好的 host（这条才走 HTTP）
```

裸跑时 `dshr` 会幂等地把 `$DSH_HOME/profiles/dshr/` 准备好（软链本仓库的
`@dshr/bundle`），然后把终端交给 `dsh --profile dshr`——**界面在那个进程里挂起来，
不开端口、不连 socket**。`cordis.patch.yml` 是你自己的 patch 层，已存在就不覆盖。

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
| 界面起来但一提问就报错 | patch 层没配 provider（`~/.dsh/cordis.patch.yml` 或 profile patch），或 `QP_API_KEY` 既不在 `~/.dsh/.credentials.yaml` 也没 export |
| 整个界面塌成一列 | 终端没报尺寸；已有 80×24 兜底，还塌就把终端信息发我 |
| 起不来 | 先单独跑一次 `DSH_HOME=<你的> dsh --profile dshr --dump-config` 看图组不组得出来；**再真跑一次**——组合阶段不检查服务依赖，dump 干净 ≠ 起得来（见 `profile.md`） |
| 想确认不是我在吹 | `node tools/verify.mjs` 和 `expect -f tools/verify-tty.exp` |

## 六、还不能用的东西

- **进不去子 agent 的会话**。对话里能看见 `✓ General Task — …` 这行，但
  `subagent.list` / `history` / `prompt` / `interrupt` 没接，看不到它做了什么、也发不了话给它。
  卡在实测 `host/session-added` 不带 `parentSessionId`／`origin`，父子关联建不起来。
- **`--connect` 那条路仍然走 HTTP+WebSocket**（而且只接 loopback）。这是**故意的**：
  attach 到别人的 host 时不该再挂一套本地 host plane，那套用不上，还会和目标 host
  抢同一个 `$DSH_HOME/sessions`。裸跑（插件路）已经是零端口零 socket 了。
- **远程 attach 没做**。host 只绑 loopback，跨机器要 dshr 自带认证层，现在没有。
