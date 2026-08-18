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
 * `suggested` 的命令**额外复制一份**进 `Suggested` 分组，原条目在自己的分类里照常存在；
 * 一有输入，`filterOptions` 丢掉 `Suggested` 那一份，原条目仍然搜得到。
 *
 * ⚠️ 这里踩过：早先的实现是把 suggested 命令**归类**成 `Suggested`（而不是复制），
 * 于是一输入过滤就把条目本身删掉了——`Switch model` 是唯一的 suggested 命令，
 * 结果搜 `model` 返回 `No results found`，最要紧的那条命令反而搜不到。
 * 上游 `command-palette.tsx` 的 `list()` 是「suggested 副本 + 完整列表」两段拼接，
 * 副本的 value 加 `suggested:` 前缀以免与本体撞车。
 */
const SUGGESTED_PREFIX = 'suggested:'

export function CommandPalette({ registry, onClose, maxHeight }: CommandPaletteProps): ReactElement {
  const base: DialogSelectOption[] = registry.list().map((command) => ({
    title: command.title,
    ...(command.desc !== undefined ? { label: command.desc } : {}),
    ...(command.category !== undefined ? { category: command.category } : {}),
    ...(command.bindings !== undefined && command.bindings.length > 0
      ? { footer: command.bindings.join(', ') }
      : {}),
    // suggested 的本体只在搜索时露面——未过滤时它已经在 Suggested 分组里出现过一次了。
    ...(command.suggested === true ? { onlyWhenFiltered: true } : {}),
    value: command.name,
  }))
  const suggested: DialogSelectOption[] = registry
    .list()
    .filter((command) => command.suggested === true)
    .map((command) => {
      const option = base.find((o) => o.value === command.name)
      return {
        ...(option ?? { title: command.title, value: command.name }),
        category: 'Suggested',
        // 副本正好相反：只在**未过滤**时出现，所以不能继承本体的 onlyWhenFiltered。
        onlyWhenFiltered: false,
        value: `${SUGGESTED_PREFIX}${command.name}`,
      }
    })
  const options = [...suggested, ...base]
  return (
    <DialogSelect
      title="Commands"
      options={options}
      onSelect={(value) => {
        onClose()
        registry.dispatch(value.startsWith(SUGGESTED_PREFIX) ? value.slice(SUGGESTED_PREFIX.length) : value)
      }}
      onCancel={onClose}
      {...(maxHeight !== undefined ? { maxHeight } : {})}
    />
  )
}
