/**
 * 斜杠命令的**注入来源**契约。
 *
 * `/` 是客户端的活（docs/gap-shapes.md §十一）：直接发给 host 只会被当成普通文本
 * 塞给模型（实测）。dshr 自己的命令在 `@dshr/tui` 的注册表里，两条路都有；
 * **dsh 的斜杠命令表**则来自这个注入的来源——插件路（`@dshr/bundle`）注入一个走
 * `ctx.typertGateway.invoke` 的真实现，`--connect` 路不注入（typert 没走 `/api`，
 * 已决策的取舍）。
 *
 * ⚠️ 本包只接受注入，**不直接依赖 typert 或 cordis**——与 herdr 上报的钩子
 * （`MountSurfaceOptions.hooks`）同一个模式。
 */
import type { SessionId } from '@dshr/state'

/** host 命令表里的一条（`CommandDescriptor` 的最小可用面）。 */
export interface RemoteSlashCommand {
  /** 命令名，不含前导 `/`。 */
  readonly name: string
  readonly description?: string
  /** 命令声明了自由文本参数（`CommandInputDescriptor` 存在）：enter 只补全不执行。 */
  readonly takesInput?: boolean
}

export interface SlashCommandSource {
  /** 拉取该会话当前可用的斜杠命令表。失败时 reject，调用方退回「只显示 dshr 自己的」。 */
  list(sessionId: SessionId): Promise<readonly RemoteSlashCommand[]>
  /**
   * 执行一行（含前导 `/`，可带参数）。
   *
   * 返回要给人看的一句回执（通常是业务失败原因；`CommandExecution.result.kind === 'error'`
   * 的 text），无回执返回 undefined。传输/派发层失败直接 reject。
   * 成功结果本身不进回执——`command/run` / `command/done` 事件本来就进会话流。
   */
  run(sessionId: SessionId, line: string): Promise<string | undefined>
}
