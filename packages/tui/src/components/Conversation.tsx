import { useEffect, useReducer } from 'react'
import { Box, Text } from 'ink'
import type { ConversationItem, ConversationView } from '@dshr/state'
import { AssistantMessage, ErrorMessage, NoticeMessage, UserMessage } from './MessageRow.js'
import { ReasoningRow } from './ReasoningRow.js'
import { ToolRow } from './ToolRow.js'

/** `hasOlder` 的顶部提示，混进 items 里保持视觉顺序。 */
interface OlderHint {
  kind: 'older-hint'
  id: string
}
type Entry = ConversationItem | OlderHint

const OLDER_HINT: OlderHint = { kind: 'older-hint', id: '__older-hint__' }

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

/** 消息流。 */
export interface ConversationProps {
  view: ConversationView
  /**
   * 最多渲染多少条（从末尾往回数）。默认 200。
   *
   * 这是长会话的兜底：ink 每帧重绘整棵子树，几千条消息会明显发卡。
   * 翻更早的历史走 `view.loadOlder()` + 这个窗口，而不是把全部渲染出来。
   */
  maxItems?: number
}

/**
 * ⚠️ **这里刻意不用 ink 的 `<Static>`。**
 *
 * `<Static>` 能让已完成项只追加、永不重绘，是单窗格全屏 TUI（opencode 那种）的正解。
 * 但它是**文档级**的——输出永远写在动态区上方，**无法被限制在某个 Box 里**。
 * dshr 是多 pane 工作区，用了 `<Static>` 的话会话内容会跑到 tab 栏和侧栏**外面**去
 * （实测过：消息渲染在整个布局的最上方，pane 框里只剩输入框）。
 *
 * 所以这里全部走普通渲染，用 `maxItems` 窗口兜住长会话的开销。
 * 代价是每帧重绘整棵子树；换来的是内容真的待在它该待的那个格子里。
 */
export function Conversation({ view, maxItems = 200 }: ConversationProps) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => view.subscribe(bump), [view])

  const items = view.items
  const windowed = items.length > maxItems ? items.slice(items.length - maxItems) : items
  const truncated = windowed.length < items.length
  const entries: Entry[] = view.hasOlder || truncated ? [OLDER_HINT, ...windowed] : [...windowed]

  return (
    <Box flexDirection="column">
      {entries.map((entry) => (
        <EntryRow key={entry.id} entry={entry} />
      ))}
    </Box>
  )
}
