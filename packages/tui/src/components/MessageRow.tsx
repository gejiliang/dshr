import { memo } from 'react'
import { Box, Text } from 'ink'
import type { ConversationItem } from '@dshr/state'
import { theme } from '../theme.js'

export type UserItem = Extract<ConversationItem, { kind: 'user' }>
export type AssistantItem = Extract<ConversationItem, { kind: 'assistant' }>
export type ErrorItem = Extract<ConversationItem, { kind: 'error' }>
export type NoticeItem = Extract<ConversationItem, { kind: 'notice' }>

/**
 * 用户消息：左侧粗竖线 `┃`（opencode 的 SplitBorder），内容区 `backgroundPanel`
 * 底色、上下各留一行空、正文缩进 2。这是 opencode `UserMessage` 的逐条对齐。
 */
export const UserMessage = memo(function UserMessage({ item, first = false }: { item: UserItem; first?: boolean }) {
  const lines = item.text.split('\n')
  return (
    <Box flexDirection="column" marginTop={first ? 0 : 1}>
      <Text>
        <Text color={theme.primary}>┃</Text>
        <Text backgroundColor={theme.backgroundPanel}>  </Text>
      </Text>
      {lines.map((line, index) => (
        <Text key={index}>
          <Text color={theme.primary}>┃</Text>
          <Text backgroundColor={theme.backgroundPanel} color={theme.text}>
            {'  '}
            {line === '' ? ' ' : line}
          </Text>
        </Text>
      ))}
      <Text>
        <Text color={theme.primary}>┃</Text>
        <Text backgroundColor={theme.backgroundPanel}>  </Text>
      </Text>
    </Box>
  )
})

/**
 * 助手正文：**没有竖线**，只是缩进（容器 padding 2 + 本行 3 = 5 列）。
 */
export const AssistantMessage = memo(function AssistantMessage({ item }: { item: AssistantItem }) {
  const lines = item.text.split('\n')
  return (
    <Box flexDirection="column" paddingLeft={3} marginTop={1}>
      {lines.map((line, index) => (
        <Text key={index} color={theme.text}>
          {line === '' ? ' ' : line}
        </Text>
      ))}
    </Box>
  )
})

/** 错误：红竖线 + panel 底（opencode 的错误面板是 error 色左边框 + panel 底）。 */
export const ErrorMessage = memo(function ErrorMessage({ item }: { item: ErrorItem }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.error}>┃</Text>
        <Text backgroundColor={theme.backgroundPanel} color={theme.textMuted}>
          {'  '}
          {item.message}{' '}
        </Text>
      </Text>
    </Box>
  )
})

export const NoticeMessage = memo(function NoticeMessage({ item }: { item: NoticeItem }) {
  return (
    <Box marginTop={1}>
      <Text color={theme.textMuted}>· {item.text}</Text>
    </Box>
  )
})
