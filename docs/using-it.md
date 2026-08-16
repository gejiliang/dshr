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

## 三、跑起来

```sh
dshr                       # 连本机 host；没有就自己拉一个，然后开 TUI
dshr --port 39080          # 指定端口（默认 39080）
dshr --connect <url>       # 只开 TUI，attach 到已经在跑的 host
dshr --resume <sessionId>  # 直接打开某个已存在的会话
dshr server                # 只起 host、不开 TUI（当成常驻服务）
```

**推荐的日常形态**是后两条配合：

```sh
dshr server &     # 常驻，关掉终端 agent 也还在跑
dshr              # 随时 attach 回去
```

会话在 host 上是**强制落盘**的，所以关掉 TUI 不会丢东西，`dshr` 再进去还在。

## 四、界面怎么用

`Ctrl-B` 是前缀键（tmux 风格）：

| 键 | 作用 |
|---|---|
| `c` / `n` / `p` | 新 tab / 下一个 / 上一个 |
| `%` / `"` | 竖分 / 横分当前 pane |
| 方向键 | 在 pane 之间移动焦点 |
| `x` | 关掉当前 pane（**只是 detach，会话留在 host 上**） |
| `s` | 开关侧栏 |
| `w` / `W` | 切换工作区 / 新建工作区 |

**一个 pane = 一个 dsh 会话。** 新建 tab 或 pane 都会在当前工作区下开一个新会话。
侧栏里每个会话带状态点：`○` idle、`●` working、`◆` blocked（反显，最扎眼）、`✖` error。
**`◆` 是唯一需要你介入的**——那个会话卡在审批或提问上，点进去答一下才会继续。

直接打字就是跟当前 pane 的会话说话，回车发送。`Ctrl-C` 退出 dshr（不会杀掉 host 上的会话）。

## 五、不灵的时候

| 现象 | 多半是 |
|---|---|
| `Cannot find package …` | 忘了 `pnpm install && npx tsc --build` |
| 界面起来但一提问就报错 | `~/.dsh/settings.yaml` 没配，或 `QP_API_KEY` 没 export |
| 整个界面塌成一列 | 终端没报尺寸；已有 80×24 兜底，还塌就把终端信息发我 |
| 起不来、卡在等 host | 看 `/tmp/dshr-host-<port>.log`，那是它拉起的 host 的输出 |
| 想确认不是我在吹 | `node tools/verify.mjs` 和 `expect -f tools/verify-tty.exp` |

## 六、还不能用的东西

- **编排动词还没接进产品**。`@dshr/orchestrate` 的 spawn/send/wait/cancel/list 写好也测好了，
  但没有任何界面或工具能调到它——要让模型自己调，得接 dsh 的工具插件 API，那还没做。
- **远程 attach 没做**。host 只绑 loopback，跨机器要 dshr 自带认证层，现在没有。
- `Ctrl-B` 那套键位我只在离屏测试里验过；真键盘下只验过普通输入与 `Ctrl-C`。
