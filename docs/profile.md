# dshr 的 profile 与进程形态

> 前置：[`dsh-contract.md`](dsh-contract.md) 第八节（profile 怎么组合）、第二节（线协议与信任栅栏）。

## profile 长什么样

dsh 的 profile 目录是四个文件，`dsh --profile dshr` 第一次用时按模板初始化：

```
$DSH_HOME/profiles/dshr/
  package.json         # dsh.profile.bundles + out-of-tree 插件依赖
  cordis.yml           # 空入口列表，别改
  cordis.patch.yml     # 用户自己的 patch 层
  pnpm-workspace.yaml
```

dshr 的 `package.json`：

```json
{
  "name": "dsh-profile-dshr",
  "private": true,
  "dependencies": { "@dshr/bundle": "0.0.0" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@dshr/bundle"] } }
}
```

`bundles` 里的名字**先**从 dsh 安装目录解析（只有 `dsh-base` / `dsh-web-app` / `dsh-headless` 在那儿），
**再**从 profile 自己的 `node_modules`——`dsh plugin --profile dshr add @dshr/bundle` 用 pnpm 装到那里。
**这就是 dshr 不用碰 dsh 本体的原因。**

## `@dshr/bundle` 的 patch 层

盖在 `dsh-base` 上。与 `dsh-web-app` 的关键差别：

| | `dsh-web-app` | `@dshr/bundle` |
|---|---|---|
| agent plane（tools/persona/plan/subagent/…） | **逐行 disable**，交给 per-session preset | **保留**——base 的 agent plane 本来就是给 TUI 留的 |
| 前端 | React dist + client 模块加载器 + HMR 链 | 无。渲染在同一个进程里的 Ink 里 |
| host 行 | workspace / apiproxy / cordis-host-runner / webserver / 投影缓存 / storage | **同一批，照抄** |

> 「base 保留 agent plane 是给 TUI 用的」不是推断，是 `dsh-web-app/cordis.patch.yml` 里的原话：
> *"The base keeps them for the TUI, which is single-session and composes its agent process-wide;
> the Web surface disables them here and lets each session mount a preset instead."*

要插的行（照 `dsh-web-app` 的清单裁掉浏览器那半边）：

```yaml
- insert:
    - { id: code-runtime,   name: '@deepseek-ai/dsh-code-runtime-worker-thread' }
    - { id: storage,        name: '@deepseek-ai/dsh-storage' }
    - { id: storage-json,   name: '@deepseek-ai/dsh-storage-json', config: { root: !!js dshHomePath('storages') } }
    - { id: storage-domain, name: '@deepseek-ai/dsh-storage-domain', config: { backend: json } }
    - { id: workspace,      name: '@deepseek-ai/dsh-workspace' }
    - { id: session-projection-cache, name: '@deepseek-ai/dsh-session-projection-cache',
        config: { writeEveryEvents: 200, writeIntervalMs: 5000 } }
    - { id: session-stats,  name: '@deepseek-ai/dsh-session-stats' }
    - { id: api-gateway,    name: '@deepseek-ai/dsh-host-apiproxy' }
    - { id: cordis-host-runner, name: '@deepseek-ai/dsh-cordis-host-runner' }
    - { id: dshr-startup,   name: '@dshr/bundle/startup' }
    - { id: dshr-app,       name: '@dshr/bundle', inject: [dshrStartup], config: { ... } }
```

**两条 patch 语义每次都要记住**（都踩过）：

- 一条 patch **替换目标行的整个 `config`**，所以每行要把自己拥有的键全部重述。
- 改已有条目用 `id`，加新插件用 `insert`。**写错 id 只在 stderr 印一行就照常启动**——
  改完必须 `dsh --profile dshr --dump-config` 复核，别信它没炸就是对的。

`webserver` 行**只在需要跨进程 attach 时才插**，见下。

## 三种进程形态

`@dshr/protocol` 的 `DshrClient` 接口下面挂**两个 carrier**，上层看不出区别：

| carrier | 用在哪 | 有没有 HTTP |
|---|---|---|
| in-process | TUI 与 host 同进程，直接打 `ctx.apiProxy` | 无 |
| http | TUI 连一个已在跑的 host | 有 |

> 「进程内 carrier 满足同一个双流抽象」是上游 `dsh-client-connection` 的原话，不是我们发明的形态。

于是：

```sh
dshr                       # ① 单进程：dsh + host 平面 + TUI 全在一个进程里。
                           #    不开端口、不过信任栅栏、没有认证问题。默认就是它。
dshr server [--port N]     # ② 只起常驻 host（含 webserver 行），绑 loopback，不开 TUI
dshr --connect <url>       # ③ 只起 TUI，attach 到 ② 或另一台机器上的 host
dshr --resume <sessionId>  # 直接打开某个已存在的会话（会话强制落盘，所以这是白送的）
```

**默认形态是 ①**，因为它没有任何认证面。②③ 是为了「一套跑在机器上的服务」——
关掉终端 agent 还在跑，再 attach 回去。

## 安全：②③ 那条路上不要自欺

- dsh 的 `/api` 信任栅栏**是可达性策略，不是认证**。上游 web carrier 根本没有认证层，
  `--host 0.0.0.0` 是它**故意**不支持的。
- 所以 **dshr 的 host 只绑 loopback**。要跨机器 attach，dshr 必须自己带一层认证；
  把 `trustedHosts` 放宽**不算**认证，也不会被当成认证接受。
- 一批特权方法被钉死在 loopback，声明 `trustedHosts` 也够不着
  （`host.pickDirectory` / `host.openPath` / 整个 settings 与 credentials 平面 /
  agent-preset 的写作面）。**远程 client 的能力面天生更小，UI 要如实反映**，
  不要画一个按不动的按钮。

## 开发期不需要真 provider（实测 2026-08-15）

`@deepseek-ai/dsh-llm-mock-server@0.1.0-rc.6` 已发布（**在 `next` tag 上，见契约文档第九节**）。

⚠️ **它不是 dsh 插件，别往 profile 里 `dsh plugin add`。**
它是一个**库** + 一个**假的 OpenAI 兼容 HTTP/SSE 端点**：
接受 `POST /chat/completions` 与 `POST /v1/chat/completions`，
每个请求按到达顺序消费一条脚本行为。README 原文写明它
"exposes no installable binary"——只导出 `startMockLlmServer(options)`。

所以正确的接法是**两步**：

1. 起 mock 端点（我们自己写个几行的启动脚本调 `startMockLlmServer`）：
   ```js
   const server = await startMockLlmServer({
     port: 8100,
     sequence: ['success'],
     repeatLast: true,           // 否则脚本耗尽后返回结构化 500
     successText: 'hello from the mock',
   })
   // server.baseURL 是绑定后的 /v1 基址
   ```
   `apiKey` 可省，省了就**接受任意 token**。
2. 让 dsh 的 provider 指过去（`$DSH_HOME/settings.yaml`）：
   ```yaml
   llm-pi-ai:
     providers:
       mock:
         apiKeyEnv: MOCK_API_KEY        # ← 必须有，见下面那个坑
         api: openai-completions
         baseURL: http://127.0.0.1:8100/v1
         models:
           - id: mock-model
             contextWindow: 131072
             maxTokens: 4096

   agent-default-model:
     provider: mock
     model: mock-model
   ```

> ⚠️ **`apiKeyEnv` 不能省。** 适配器的规则是「**完全**不配凭据的路由才走 pi-ai 的环境发现」——
> 而手工声明的路由在那里什么也发现不到，于是 **`dsh: PI_AI_ERROR: No API key for provider: mock`**。
> 给一个引用就行，值随便（mock 端不配 `apiKey` 时接受任意 token）。**这条是踩出来的。**

### 完整可复现的实测（2026-08-15，dsh 0.1.0-rc.6）

```console
$ node tools/mock-llm.mjs --port 8100 --text "mock says: the reconnect backoff is in place."
mock llm: http://127.0.0.1:8100
sequence: success (last repeats)

$ MOCK_API_KEY=mock-key DSH_HOME=/tmp/dshhome \
    npx @deepseek-ai/dsh@0.1.0-rc.6 --profile headless "Reply with exactly one short sentence."
mock says: the reconnect backoff is in place.

$ MOCK_API_KEY=mock-key DSH_HOME=/tmp/dshhome \
    npx @deepseek-ai/dsh@0.1.0-rc.6 web --port 39081
dsh web: http://127.0.0.1:39081
# host.describe → {"provider":"mock","model":"mock-model", ...}
```

**整条链路零凭据跑通**：agent loop、工具、会话落盘、host 平面全都是真的，只有模型是假的。

有用的行为（全部来自 README 的行为表）：

| 行为 | 用来测什么 |
|---|---|
| `success` / `slow_success` / `reasoning_success` | 正常回答；带延迟；带 reasoning 前缀 |
| `tool_call_success` | **工具调用**——TUI 的工具卡片渲染靠它 |
| `partial_disconnect` / `stream_disconnect` / `stall` | 流中断与卡死，测重连与超时 |
| `rate_limit` / `server_error` | 重试策略 |
| `random` + `--repeat-last` + 权重 | 开放式压测 |

**别为了「验证一下」去要真密钥。**
