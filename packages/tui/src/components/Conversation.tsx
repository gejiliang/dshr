import { useEffect, useReducer } from 'react'
import { Box, Static, Text } from 'ink'
import type { ConversationItem, ConversationView } from '@dshr/state'
import { AssistantMessage, ErrorMessage, NoticeMessage, UserMessage } from './MessageRow.js'
import { ReasoningRow } from './ReasoningRow.js'
import { ToolRow } from './ToolRow.js'

/** `hasOlder` 的顶部提示，混进 Static 的 items 里保持视觉顺序。 */
interface OlderHint {
  kind: 'older-hint'
  id: string
}
type Entry = ConversationItem | OlderHint

const OLDER_HINT: OlderHint = { kind: 'older-hint', id: '__older-hint__' }

/** 还在变化的项：流式中的文本、running 的工具。只有它们进动态区。 */
function isMutable(item: ConversationItem): boolean {
  switch (item.kind) {
    case 'assistant':
    case 'reasoning':
      return item.streaming
    case 'tool':
      return item.status === 'running'
    default:
      return false
  }
}

export function ItemRow({ item }: { item: ConversationItem }) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} />
    case 'assistant':
      return <AssistantMessage item={item} />
    case 'reasoning':
      return <ReasoningRow item={item} />
    case 'tool':
      return <ToolRow item={item} />
    case 'error':
      return <ErrorMessage item={item} />
    case 'notice':
      return <NoticeMessage item={item} />
  }
}

function EntryRow({ entry }: { entry: Entry }) {
  if (entry.kind === 'older-hint') {
    return <Text dimColor>⋮ earlier history — loadOlder()</Text>
  }
  return <ItemRow item={entry} />
}

/**
 * 消息流。
 *
 * 已完成的项进 `<Static>`——只追加、永不重绘；动态区只含还在变化的尾部
 * （第一个 mutable 项到末尾）。流式增量因此只重渲染变化的那一项，
 * 长会话不会每帧全量重排。已知取舍：`loadOlder()`  prepend 的历史会出现在
 * 已渲染内容**下方**（Static 只往下写），翻页后重挂组件即恢复顺序。
 */
export function Conversation({ view }: { view: ConversationView }) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => view.subscribe(bump), [view])

  const items = view.items
  const firstMutable = items.findIndex(isMutable)
  const staticItems = firstMutable === -1 ? items : items.slice(0, firstMutable)
  const liveItems = firstMutable === -1 ? [] : items.slice(firstMutable)

  const staticEntries: Entry[] = view.hasOlder ? [OLDER_HINT, ...staticItems] : [...staticItems]

  return (
    <Box flexDirection="column">
      <Static items={staticEntries}>
        {(entry) => <EntryRow key={entry.id} entry={entry} />}
      </Static>
      {liveItems.map((item) => (
        <ItemRow key={item.id} item={item} />
      ))}
    </Box>
  )
}
