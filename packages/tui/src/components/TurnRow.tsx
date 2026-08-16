import { memo } from 'react'
import { Box, Text } from 'ink'
import type { ConversationItem } from '@dshr/state'
import { theme } from '../theme.js'
import { formatDuration } from '../text-utils.js'

export type TurnItem = Extract<ConversationItem, { kind: 'turn' }>

function titlecase(text: string): string {
  return text === '' ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`
}

/**
 * 每轮结尾的页脚：`▣  Standard · model · 2.1s`（opencode `AssistantMessage`
 * 的页脚行；`▣` 后是两个空格——上游是 `▣{" "}` 再加一个独立空格）。
 * `▣` 用 agent 色（上游 Build = secondary）；被打断的轮次整行降为 textMuted 并标注。
 * preset 不在事件流里（host 只在 session.create 时给），
 * 由外层按当前会话的 `agentPreset` 传入。
 */
export const TurnRow = memo(function TurnRow({ item, preset }: { item: TurnItem; preset?: string }) {
  const mode = titlecase(preset ?? 'standard')
  const duration = item.durationMs > 0 ? ` · ${formatDuration(item.durationMs)}` : ''
  const model = item.model !== undefined ? ` · ${item.model}` : ''
  const color = item.interrupted === true ? theme.textMuted : theme.secondary
  return (
    <Box paddingLeft={3} marginTop={1}>
      <Text>
        <Text color={color}>▣  </Text>
        <Text color={theme.text}>{mode}</Text>
        <Text color={theme.textMuted}>
          {model}
          {duration}
          {item.interrupted === true ? ' · interrupted' : ''}
        </Text>
      </Text>
    </Box>
  )
})
