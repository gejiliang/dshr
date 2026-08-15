import { memo } from 'react'
import { Text } from 'ink'
import type { ConversationItem } from '@dshr/state'
import { firstLine, truncate } from '../text-utils.js'

export type ReasoningItem = Extract<ConversationItem, { kind: 'reasoning' }>

/**
 * reasoning 默认折叠成一行摘要：dim + 斜体，与正文明显区分。
 * 展开（看全文）留给后续的快捷键，这一版只有折叠态。
 */
export const ReasoningRow = memo(function ReasoningRow({ item }: { item: ReasoningItem }) {
  const snippet = truncate(firstLine(item.text.trim()) || 'thinking', 88)
  return (
    <Text dimColor italic>
      ✻ {snippet}
      {item.streaming ? ' …' : ''}
    </Text>
  )
})
