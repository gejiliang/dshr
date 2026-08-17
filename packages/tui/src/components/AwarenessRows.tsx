/**
 * A 批「感知类」行组件：帧早就收到了，以前没画。
 * 形状判据：docs/gap-shapes.md（实测载荷）与 opencode 的对应展现（docs/coverage.md §三）。
 */
import { memo } from 'react'
import { Box, Text } from 'ink'
import type { ConversationItem } from '@dshr/state'
import { theme } from '../theme.js'
import { firstLine, truncate } from '../text-utils.js'

export type RetryItem = Extract<ConversationItem, { kind: 'retry' }>
export type TodoViewItem = Extract<ConversationItem, { kind: 'todo' }>
export type CommandItem = Extract<ConversationItem, { kind: 'command' }>
export type DividerItem = Extract<ConversationItem, { kind: 'divider' }>

/**
 * 重试行：`↳ Retrying (attempt 1/2) · RATE_LIMIT`，**整行 error 色**（opencode 的行内重试）。
 * 取 `failure.code` 分类；原始报文 `failure.message` 不铺在这行。
 * 这是本批最重要的一行：没有它，网关重试时界面看起来就是卡死。
 */
export const RetryRow = memo(function RetryRow({ item }: { item: RetryItem }) {
  const attempt = item.maxRetries !== undefined ? `${item.attempt}/${item.maxRetries}` : `${item.attempt}`
  const code = item.code !== undefined && item.code !== '' ? ` · ${item.code}` : ''
  return (
    <Box paddingLeft={3}>
      <Text color={theme.error} wrap="truncate-end">
        ↳ Retrying (attempt {attempt}){code}
      </Text>
    </Box>
  )
})

function todoMark(status: TodoViewItem['todos'][number]['status']): string {
  return status === 'completed' ? '[✓]' : status === 'in_progress' ? '[•]' : '[ ]'
}

/**
 * todo 表快照（opencode `todo-item.tsx` 的逐条对齐）：
 * `[✓]` completed / `[ ]` pending → textMuted；`[•]` in_progress → warning。
 * last-write-wins：fold 保证视图里只有一份，这里整表直出。
 */
export const TodoRow = memo(function TodoRow({ item }: { item: TodoViewItem }) {
  return (
    <Box flexDirection="column" paddingLeft={3} marginTop={1}>
      {item.todos.map((todo, index) => (
        <Text
          key={index}
          color={todo.status === 'in_progress' ? theme.warning : theme.textMuted}
          wrap="truncate-end"
        >
          {todoMark(todo.status)} {todo.content}
        </Text>
      ))}
    </Box>
  )
})

/**
 * 斜杠命令的执行痕迹，走工具行的形状：`→ /name args`。
 * running 用 text 色 + `…`；完成 textMuted；`kind==='error'` 整行标红并带 `✕ <text>`。
 */
export const CommandRow = memo(function CommandRow({ item }: { item: CommandItem }) {
  const name = item.name === '' ? '(command)' : `/${item.name}`
  const head = item.args !== undefined && item.args !== '' ? `${name} ${item.args}` : name
  const failed = item.status === 'error'
  const color = failed ? theme.error : item.status === 'running' ? theme.text : theme.textMuted
  return (
    <Box paddingLeft={3} marginTop={1}>
      <Text color={color} wrap="truncate-end">
        → {head}
        {item.status === 'running' ? ' …' : ''}
        {failed && item.text !== undefined ? ` ✕ ${truncate(firstLine(item.text.trim()), 72)}` : ''}
      </Text>
    </Box>
  )
})

/**
 * 居中标题的横线 `──── Compaction ────`，borderActive 色，上面空一行（opencode 的压缩分隔）。
 * `compaction/*` 的载荷形状还没打到（docs/gap-shapes.md §七），fold 只认 type，
 * 所以这里也只有 label，没有别的可画。
 */
export const DividerRow = memo(function DividerRow({ item, width = 60 }: { item: DividerItem; width?: number }) {
  const label = ` ${item.label} `
  const side = Math.max(2, Math.floor((Math.max(width, label.length + 4) - label.length) / 2))
  return (
    <Box marginTop={1}>
      <Text color={theme.borderActive} wrap="truncate-end">
        {'─'.repeat(side)}
        {label}
        {'─'.repeat(side)}
      </Text>
    </Box>
  )
})
