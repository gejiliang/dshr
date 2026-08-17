import { DialogSelect, type DialogSelectOption } from './DialogSelect.js'
import type { CommandRegistry } from '../commands.js'
import type { ReactElement } from 'react'

export interface CommandPaletteProps {
  readonly registry: CommandRegistry
  /** 选中或取消之后关闭面板。 */
  readonly onClose: () => void
  /** 列表窗口高度（行），超出滚动。 */
  readonly maxHeight?: number
}

/**
 * 命令面板：`DialogSelect` 套在命令注册表上（opencode 的 `dialog-command` 就是这形状，
 * 面板本身没有逻辑）。标题 `Commands`，按 category 分组，右侧显示键位
 * （多个键位用 `, ` 连接，实测：`ctrl+c, ctrl+d, ctrl+x q`）。
 * `suggested` 的命令进 `Suggested` 分组——一有输入该组就消失。
 */
export function CommandPalette({ registry, onClose, maxHeight }: CommandPaletteProps): ReactElement {
  const options: DialogSelectOption[] = registry.list().map((command) => ({
    title: command.title,
    ...(command.desc !== undefined ? { label: command.desc } : {}),
    ...(command.category !== undefined || command.suggested === true
      ? { category: command.category ?? 'Suggested' }
      : {}),
    ...(command.bindings !== undefined && command.bindings.length > 0
      ? { footer: command.bindings.join(', ') }
      : {}),
    value: command.name,
  }))
  return (
    <DialogSelect
      title="Commands"
      options={options}
      onSelect={(name) => {
        onClose()
        registry.dispatch(name)
      }}
      onCancel={onClose}
      {...(maxHeight !== undefined ? { maxHeight } : {})}
    />
  )
}
