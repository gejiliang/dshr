import { useEffect, useReducer } from 'react'
import { Box, Text } from 'ink'
import type { ConversationItem, ConversationView } from '@dshr/state'
import { AssistantMessage, ErrorMessage, NoticeMessage, UserMessage } from './MessageRow.js'
import { CommandRow, DividerRow, RetryRow, TodoRow } from './AwarenessRows.js'
import { ReasoningRow } from './ReasoningRow.js'
import { ToolRow } from './ToolRow.js'
import { TurnRow } from './TurnRow.js'
import { theme } from '../theme.js'
import { wrappedLineCount } from '../text-utils.js'

/** `hasOlder` 的顶部提示，混进 items 里保持视觉顺序。 */
interface OlderHint {
  kind: 'older-hint'
  id: string
}
type Entry = ConversationItem | OlderHint

const OLDER_HINT: OlderHint = { kind: 'older-hint', id: '__older-hint__' }

export function ItemRow({ item, first, preset, width }: { item: ConversationItem; first?: boolean; preset?: string; width?: number }) {
  switch (item.kind) {
    case 'user':
      return first === undefined ? <UserMessage item={item} /> : <UserMessage item={item} first={first} />
    case 'assistant':
      return <AssistantMessage item={item} />
    case 'reasoning':
      return <ReasoningRow item={item} />
    case 'tool':
      return <ToolRow item={item} />
    case 'turn':
      return <TurnRow item={item} {...(preset !== undefined ? { preset } : {})} />
    case 'error':
      return <ErrorMessage item={item} />
    case 'notice':
      return <NoticeMessage item={item} />
    case 'retry':
      return <RetryRow item={item} />
    case 'todo':
      return <TodoRow item={item} />
    case 'command':
      return <CommandRow item={item} />
    case 'divider':
      return width === undefined ? <DividerRow item={item} /> : <DividerRow item={item} width={width} />
  }
}

function EntryRow({ entry, first, preset, width }: { entry: Entry; first?: boolean; preset?: string; width?: number }) {
  if (entry.kind === 'older-hint') {
    return <Text color={theme.textMuted}>⋮ earlier history - loadOlder()</Text>
  }
  return (
    <ItemRow
      item={entry}
      {...(first !== undefined ? { first } : {})}
      {...(preset !== undefined ? { preset } : {})}
      {...(width !== undefined ? { width } : {})}
    />
  )
}

/**
 * 一个条目**实际**占多少行——尾部窗口的预算靠它。
 *
 * ⚠️ **必须把 `marginTop={1}` 算进去。** 除首条用户消息外，
 * 每个行组件外层 Box 都有 `marginTop={1}`（MessageRow / ToolRow / ReasoningRow /
 * AwarenessRows / TurnRow 全都有），估算漏掉它就是**每条少算一行**。
 *
 * 踩过：150×45 下连发十轮，30 个条目少算 30 行，预算 37 行而实际渲染 ~67 行，
 * 整个 row 比终端高 → 终端滚动 → **右侧信息列（矮、贴顶）被顶出画面，看起来像凭空消失**。
 * 当时先怀疑是宽度被撑开，钉死列宽没用——是高度。
 *
 * 宁可高估：高估只是少显示一条历史，低估会毁掉整个布局。
 */
function entryRows(entry: Entry, wrapWidth: number): number {
  if (entry.kind === 'older-hint') return 1
  const margin = 1
  if (entry.kind === 'user') return margin + 2 + wrappedLineCount(entry.text, wrapWidth)
  if (entry.kind === 'assistant') return margin + wrappedLineCount(entry.text, wrapWidth)
  if (entry.kind === 'todo') return margin + entry.todos.length + 1
  return margin + 1
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
  /**
   * 可视行数预算（终端高度 - 输入框/底栏占掉的行）。从末尾往回装到装不下为止--
   * ink 没有粘底的 scrollbox，这是「最新内容始终可见」的替代实现。
   * 缺省不限（测试 / 嵌入场景全量渲染）。
   */
  maxRows?: number
  /** 正文可用列宽（折行估算用；不含容器左右 padding）。 */
  contentWidth?: number
  /** 页脚里的模式名（会话的 agentPreset）。 */
  preset?: string
}

/**
 * ⚠️ **这里刻意不用 ink 的 `<Static>`。**
 *
 * `<Static>` 能让已完成项只追加、永不重绘，是单窗格全屏 TUI（opencode 那种）的正解。
 * 但它是**文档级**的--输出永远写在动态区上方，**无法被限制在某个 Box 里**。
 * dshr 是多 pane 工作区，用了 `<Static>` 的话会话内容会跑到 tab 栏和侧栏**外面**去
 * （实测过：消息渲染在整个布局的最上方，pane 框里只剩输入框）。
 *
 * 所以这里全部走普通渲染，用 `maxItems` + `maxRows` 窗口兜住长会话的开销。
 * 代价是每帧重绘整棵子树；换来的是内容真的待在它该待的那个格子里。
 */
export function Conversation({ view, maxItems = 200, maxRows, contentWidth, preset }: ConversationProps) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => view.subscribe(bump), [view])

  const items = view.items
  const windowed = items.length > maxItems ? items.slice(items.length - maxItems) : items
  const truncated = windowed.length < items.length
  const allEntries: Entry[] = view.hasOlder || truncated ? [OLDER_HINT, ...windowed] : [...windowed]

  // 尾部窗口：从末尾往回装，装不下就截（older-hint 也会被挤掉，属预期）。
  let entries = allEntries
  if (maxRows !== undefined) {
    const wrapWidth = Math.max(20, (contentWidth ?? 80) - 5)
    const kept: Entry[] = []
    let budget = maxRows
    for (let i = allEntries.length - 1; i >= 0; i--) {
      const entry = allEntries[i]
      if (entry === undefined) break
      const rows = entryRows(entry, wrapWidth)
      if (rows > budget && kept.length > 0) break
      kept.unshift(entry)
      budget -= rows
    }
    entries = kept
  }

  const firstUserIndex = entries.findIndex((entry) => entry.kind === 'user')

  return (
    <Box flexDirection="column">
      {entries.map((entry, index) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          {...(index === firstUserIndex ? { first: true } : {})}
          {...(preset !== undefined ? { preset } : {})}
          {...(contentWidth !== undefined ? { width: contentWidth } : {})}
        />
      ))}
    </Box>
  )
}
