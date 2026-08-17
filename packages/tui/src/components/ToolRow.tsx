import { memo } from 'react'
import { Box, Text } from 'ink'
import { theme } from '../theme.js'
import { contentText, firstLine, truncate } from '../text-utils.js'
import { toolCallTitle, subagentTitle, type ToolItem } from '../tool-view.js'

/**
 * 工具图标：照 opencode `ToolPart` 的 per-tool 图标表（icon 占 2 列），
 * 逐个从上游源码（`routes/session/index.tsx`）核对过：
 *
 *   read →   write/edit ←   glob/grep ✱   bash $   webfetch/apply_patch %
 *   websearch ◈   question/skill →   task ✓(完成)/│(未完)   其余 ⚙
 *
 * dsh 的工具名与 opencode 不完全同源，认得的用上游图标，其余走通用 `⚙`。
 */
const TOOL_ICONS: Record<string, string> = {
  read: '→',
  bash: '$',
  shell: '$',
  glob: '✱',
  grep: '✱',
  write: '←',
  edit: '←',
  webfetch: '%',
  applypatch: '%',
  apply_patch: '%',
  websearch: '◈',
  question: '→',
  skill: '→',
}

function iconFor(item: ToolItem): string {
  const name = item.name.toLowerCase()
  // 上游 Task 的图标跟状态走：完成 ✓、未完 │（失败只靠颜色表达）。
  // dsh 的 subagent/subagent_fork 就是 opencode 的 Task（docs/gap-shapes.md §五），接同一套。
  if (name === 'task' || name === 'subagent' || name === 'subagent_fork') return item.status === 'ok' ? '✓' : '│'
  const icon = TOOL_ICONS[name]
  return icon === undefined ? '⚙' : icon
}

function titlecase(text: string): string {
  return text === '' ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`
}
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
  const arg = toolCallTitle(item)
  const lower = item.name.toLowerCase()
  const isSubagent = lower === 'subagent' || lower === 'subagent_fork'
  // host 给了 call view 时，title 已是完整标签（含工具名，如 `Read .`）——直接用，
  // 别再拼一遍名字（不然出来 `Read Read .`）。没有 view 时照上游拼法：
  // bash/shell 只有 `$ <command>`；子 agent 是 `<Type> Task — <描述>`；
  // 其余 `<Name> <arg>`，工具名首字母大写（上游是硬编码的 Read/Glob/Edit…，dsh 给的是小写名）。
  const name = item.name === '' ? '(tool)' : titlecase(item.name)
  const fromView = item.view?.for === 'call'
  const head = fromView
    ? arg
    : isSubagent
      ? subagentTitle(item)
      : (lower === 'bash' || lower === 'shell') && arg !== ''
        ? arg
        : arg === ''
          ? name
          : `${name} ${arg}`
  const failed = item.status === 'error'
  const color = failed ? theme.error : item.status === 'running' ? theme.text : theme.textMuted

  return (
    <Box paddingLeft={3} marginTop={1}>
      <Text color={color} wrap="truncate-end">
        {iconFor(item)} {head}
        {item.status === 'running' ? ' …' : ''}
        {failed ? ` ✕ ${truncate(firstLine(errorText(item).trim()), 72)}` : ''}
      </Text>
    </Box>
  )
})
