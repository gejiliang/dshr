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

/**
 * 执行一行的结果。**三种，必须分得开。**
 *
 * ⚠️ 这里原来是 `Promise<string | undefined>`：`undefined` 同时表示「没被认领」
 * **和**「成功」。后果是——正常会话上成功执行一条命令，界面会弹一句
 * 「did nothing — slash commands need a started session」，**自相矛盾且误导**。
 * 是跨厂商评审（DeepSeek）挑出来的；我自己只测了 `kind === 'error'` 那条路
 * （`/compact` 在空会话上返回失败文本），**成功路径根本没覆盖到**。
 *
 * 折叠两种语义到一个 `undefined` 是根因，所以这里改成判别联合，让消费端没法再混。
 */
export type SlashRunOutcome =
  /** 这行没有被任何命令认领（未知命令，或空白会话上 host 还没有 agent）。 */
  | { readonly kind: 'unclaimed' }
  /** 执行成功。**不需要回执**——`command/run` / `command/done` 事件本来就进会话流。 */
  | { readonly kind: 'ok' }
  /** 业务失败：`CommandExecution.result.kind === 'error'` 的 text，给人看。 */
  | { readonly kind: 'error'; readonly text: string }

export interface SlashCommandSource {
  /** 拉取该会话当前可用的斜杠命令表。失败时 reject，调用方退回「只显示 dshr 自己的」。 */
  list(sessionId: SessionId): Promise<readonly RemoteSlashCommand[]>
  /**
   * 执行一行（含前导 `/`，可带参数）。传输/派发层失败直接 reject；
   * 业务层的三种结局走 {@link SlashRunOutcome}。
   */
  run(sessionId: SessionId, line: string): Promise<SlashRunOutcome>
}
