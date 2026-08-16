import { memo } from 'react'
import { Box, Text } from 'ink'
import { theme } from '../theme.js'
import { contentText, firstLine, truncate } from '../text-utils.js'
import { toolCallTitle, type ToolItem } from '../tool-view.js'

/**
 * 工具图标：照 opencode `ToolPart` 的 per-tool 图标表（icon 占 2 列）。
 * dsh 的工具名与 opencode 不完全同源，认得的用上游图标，其余走通用 `⚙`。
 */
const TOOL_ICONS: Record<string, string> = {
  read: '->',
  bash: '$',
  shell: '$',
  glob: '✱',
  grep: '✱',
  write: '←',
  edit: '←',
  webfetch: '%',
  websearch: '◈',
}

function iconFor(name: string): string {
  const icon = TOOL_ICONS[name.toLowerCase()]
  return icon === undefined ? '⚙' : icon
}

/** 图标后统一跟一个空格（上游 icon 占 2 列；`->` 天然 2 列，其余图标不强行对齐）。 */
function errorText(item: ToolItem): string {
  const text = contentText(item.result)
  if (text !== undefined && text.trim() !== '') return text
  if (typeof item.result === 'string') return item.result
  return 'failed'
}

/**
 * 工具调用折成一行 `<icon> <Name> <arg>`（如 `-> Read .`）：
 * running 用 text 色、完成用 textMuted、失败标红并把错误摘要接在行尾
 * （上游把失败文本直接渲染在行内，展开交互留待后续）。
 */
export const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }) {
  const name = item.name === '' ? '(tool)' : item.name
  const arg = toolCallTitle(item)
  const head = arg === '' ? name : `${name} ${arg}`
  const failed = item.status === 'error'
  const color = failed ? theme.error : item.status === 'running' ? theme.text : theme.textMuted

  return (
    <Box paddingLeft={3} marginTop={1}>
      <Text color={color} wrap="truncate-end">
        {iconFor(item.name)} {head}
        {item.status === 'running' ? ' …' : ''}
        {failed ? ` ✕ ${truncate(firstLine(errorText(item).trim()), 72)}` : ''}
      </Text>
    </Box>
  )
})
