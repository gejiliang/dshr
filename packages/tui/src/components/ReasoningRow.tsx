import { memo } from 'react'
import { Box, Text } from 'ink'
import type { ConversationItem } from '@dshr/state'
import { theme } from '../theme.js'
import { formatDuration } from '../text-utils.js'

export type ReasoningItem = Extract<ConversationItem, { kind: 'reasoning' }>

/** opencode `reasoningSummary`：开头的 `**加粗**` 行抽出来当标题。 */
function reasoningTitle(text: string): string | null {
  const match = text.trim().match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)
  return match !== null && match[1] !== undefined ? match[1].trim() : null
}

/**
 * reasoning 折成一行 `+ Thought: <时长>`（opencode `ReasoningHeader` 的折叠态）：
 * `+` 表示可展开，warning 色。流式未收尾时上游是 Spinner "Thinking"，
 * ink 里没有逐帧动画，用 `⋯` 静态占位。展开交互留待后续快捷键。
 */
export const ReasoningRow = memo(function ReasoningRow({ item }: { item: ReasoningItem }) {
  const title = reasoningTitle(item.text)
  const duration = item.durationMs !== undefined && !item.streaming ? formatDuration(item.durationMs) : null

  if (item.streaming) {
    return (
      <Box paddingLeft={3} marginTop={1}>
        <Text color={theme.warning}>⋯ Thinking{title === null ? '' : `: ${title}`}</Text>
      </Box>
    )
  }
  return (
    <Box paddingLeft={3} marginTop={1}>
      <Text color={theme.warning} wrap="truncate-end">
        + Thought
        {title === null && duration === null ? '' : ': '}
        {title}
        {title !== null && duration !== null ? ' · ' : ''}
        {duration}
      </Text>
    </Box>
  )
})
