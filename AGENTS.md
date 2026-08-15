# dshr — Agent 指令

> **本文件是本项目章程的唯一真源**，`CLAUDE.md` 只是指向它的软链——改章程改本文件。
> 只写「在这个目录里干活才需要的东西」，全局配置 `~/.agents/AGENTS.md` 已注入，不复述。
>
> 动手前必读，按序：
> 1. [`docs/dsh-contract.md`](docs/dsh-contract.md) —— dsh 的线协议与行为，**实测的**
> 2. [`docs/architecture.md`](docs/architecture.md) —— 分包、接口、纪律
>
> 项目是什么见 [`README.md`](README.md)。

## 不可逆约束

- **不 fork dsh，不改 `node_modules/@deepseek-ai/**` 里的任何东西。**
  dshr 的一切以 profile bundle + 插件形式挂上去。上游是 developer preview，
  fork 的长期成本是跟它 diverge。确实缺原语时才考虑，且要留下证据。
- **不依赖 herdr。** 借它的产品形状，不借它的代码，也不做它的插件。
  两者是同类替代品，不是上下游。
- **凭证不进仓库。** 值放 `secrets/`（已 gitignore，权威副本在密码管理器），
  代码里只留 `apiKeyEnv` 这类引用。写任何配置前先问一句：这行值泄露了要不要紧。
- **不碰 `~/.dsh` 之外的用户配置**，不跑安装/部署脚本。
  「装上去确实能用」是人在合并之后做的事。

## 判据来自实测，不来自文档措辞

上游是 developer preview，README 的措辞与实际行为会脱节。
`docs/dsh-contract.md` 里每一条都标了怎么验的。**改判据前先问：
这条依赖上游的哪个行为、那个行为在哪个版本上验过。**

已经踩到的两个例子：

- patch YAML **写错 id 只在 stderr 印一行就照常启动**，不报错。
  改完 profile 必须 `--dump-config` 复核，别信它没炸就是对的。
- 「dsh 没有 TUI、headless 没有 resume，所以做不了」——前半句是**没人实现**而不是做不了
  （上游文档两处留了 TUI 的位置），后半句只对 headless 这个 surface 成立，
  会话本身一直强制落盘。**结论过期了就重验，别继承。**

## 在无人值守的会话里跑 git：必须 `GIT_EDITOR=true`

任何可能拉起编辑器的 git 命令——`rebase --continue`、`merge`（有冲突时）、
`commit` 不带 `-m`、`revert`——在没有人坐在终端前的会话里会**静默挂死**：
git 拉起 `vim` 等输入，永远等不到，而且**不报错、不超时**，只是一直「在跑」。

```sh
GIT_EDITOR=true git rebase --continue     # ✅
git merge --no-edit main                  # ✅
git commit -m "…"                         # ✅
```

踩过：一个 worker 的 `git rebase --continue` 挂了 13 分钟，
`ps` 里能看到 `git commit -e` 的子进程是 `/usr/bin/vim`。
中断那一轮**没用**——子进程还在，harness 被工具调用堵着，连纠偏消息都投递不进去，
最后只能从外面 kill 那个编辑器进程。

**`pnpm-lock.yaml` 的冲突一律取一边再重跑 `pnpm install`**，不要手工合并。

## 验收只能在仓库内自证

✅ 单元测试、类型检查、`--dry-run` / `--dump-config` 的退出码与输出、读配置确认格式
❌ 真安装、真部署、写 `~/.config` 或 `~/.dsh` 以外的地方、推远程、改数据库

开发期**不需要真 provider**：`@deepseek-ai/dsh-llm-mock-server` 是一个假的 OpenAI 兼容端点
（**不是 dsh 插件，别往 profile 里 add**），起它 + 让 provider 指过去就能零密钥跑通全链路。
接法见 [`docs/profile.md`](docs/profile.md) 末节。**别为了「验证一下」去要密钥。**

## 分包边界是硬的

`@dshr/state` **不许 import ink 或 react**——它必须能在 `node:test` 里裸跑。
`@dshr/protocol` 是唯一知道 HTTP 与 WebSocket 存在的地方。
这两条不是风格偏好，是「能不能测」的分界。

## 编排层：只提供动词

代码里出现 `Role` / `Workflow` / `Protocol` / `Template` 这类**类型定义**就是越界。
谁是实现谁是评审、怎么配对，全部活在 prompt 与 skill 里，dshr 不认识这些概念。
理由见 herdgent 的 AGENTS.md：SPQR v2 的 13k 行死在把语义固化成了类型。

**spawn 必须有硬上限且上限本身可配**：默认值可覆盖，运行时可调，工具里再钉一个绝对上界。
存「人显式设过的值」，别把启动时写回的值当成人设的——两者无法区分会导致
改默认值对所有跑过的仓库静默无效（herdgent 实测 29 条记录有 24 条钉着旧默认值）。

## 提交

`<type>: <描述>`，类型 feat/fix/refactor/docs/test/chore/perf/ci。
