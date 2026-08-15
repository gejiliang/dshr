import { memo } from 'react'
import { Box, Text } from 'ink'
import type { ConversationItem } from '@dshr/state'
import { colors } from '../theme.js'

export type UserItem = Extract<ConversationItem, { kind: 'user' }>
export type AssistantItem = Extract<ConversationItem, { kind: 'assistant' }>
export type ErrorItem = Extract<ConversationItem, { kind: 'error' }>
export type NoticeItem = Extract<ConversationItem, { kind: 'notice' }>

/**
 * 左侧竖线 + 逐行正文。角色靠竖线颜色区分，正文保持默认前景色；
 * 多行消息每一行都带竖线，不用框。
 */
function Barred({
  text,
  barColor,
  streaming = false,
}: {
  text: string
  barColor: string
  streaming?: boolean
}) {
  const lines = text.split('\n')
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index}>
          <Text color={barColor}>│</Text> {line}
          {streaming && index === lines.length - 1 ? <Text dimColor>▍</Text> : null}
        </Text>
      ))}
    </Box>
  )
}

export const UserMessage = memo(function UserMessage({ item }: { item: UserItem }) {
  return <Barred text={item.text} barColor={colors.userBar} />
})

export const AssistantMessage = memo(function AssistantMessage({ item }: { item: AssistantItem }) {
  return <Barred text={item.text} barColor={colors.assistantBar} streaming={item.streaming} />
})

export const ErrorMessage = memo(function ErrorMessage({ item }: { item: ErrorItem }) {
  return <Text color={colors.error}>✕ {item.message}</Text>
})

export const NoticeMessage = memo(function NoticeMessage({ item }: { item: NoticeItem }) {
  return <Text dimColor>· {item.text}</Text>
})
