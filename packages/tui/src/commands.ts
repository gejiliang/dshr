/**
 * 命令注册表：**这里只有动词**。
 *
 * `name` 是稳定 id（`session.new` 这种），`title` 是面板里显示的名字，
 * `run` 是它做的事。谁是实现谁是评审、命令之间怎么配对——那是调用方的事，
 * 活在 prompt 与 skill 里。**这一层不许出现 Role / Workflow / Protocol /
 * Template 这类语义类型**（项目章程的硬约束：SPQR v2 的 13k 行死在把语义
 * 固化成了类型）。
 *
 * 本文件不 import ink/react，可在 node:test 里裸测。
 */
export interface Command {
  /** 稳定 id，如 `session.new`。 */
  readonly name: string
  /** 面板里显示的名字。 */
  readonly title: string
  /** 标题后跟着的 muted 说明。 */
  readonly desc?: string
  /** 面板里的分组。 */
  readonly category?: string
  /** 键位，如 `['ctrl+x n']`；面板右侧用 `, ` 连接展示。 */
  readonly bindings?: readonly string[]
  /** 未输入时进 `Suggested` 分组（opencode 实测：一有输入该组就消失）。 */
  readonly suggested?: boolean
  /** 存在但不列进面板（只能按 name 派发）。 */
  readonly hidden?: boolean
  readonly run: () => void | Promise<void>
}

export interface CommandRegistry {
  /** 注册；同名覆盖（后注册的赢）。 */
  register(command: Command): void
  /** 按 name 派发；没找到返回 false。异步 run 的 rejection 在这里吞掉（面板没有地方显示）。 */
  dispatch(name: string): boolean
  /** 可见命令（`hidden` 的不列），按注册顺序。 */
  list(): readonly Command[]
}

export function createCommandRegistry(): CommandRegistry {
  const commands = new Map<string, Command>()
  return {
    register(command) {
      commands.set(command.name, command)
    },
    dispatch(name) {
      const command = commands.get(name)
      if (command === undefined) return false
      const result = command.run()
      if (result instanceof Promise) result.catch(() => {})
      return true
    },
    list() {
      return [...commands.values()].filter((command) => command.hidden !== true)
    },
  }
}
