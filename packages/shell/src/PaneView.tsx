/**
 * 单个 pane 的渲染：会话内容（注入的 tui 组件）。
 * pane = 一个 dsh session；没绑会话时显示占位。
 *
 * 边框规则（docs/herdr-reference.md 第一节 / 第二节）：**单 pane 不画框**，
 * 多 pane 时每片画方角框（borderStyle "single"）。框与标题条只在 `framed`
 * 时出现--单 pane（含 zoom）下界面就是 herdr 那样干净的会话画面。
 */
import type { DshrState, SessionId } from '@dshr/state'
import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { ShellComponents } from './components.js'
import type { PaneLeaf } from './layout.js'
import { STATUS_MARKS } from './Sidebar.js'

export interface PaneViewProps {
  readonly pane: PaneLeaf
  readonly state: DshrState
  readonly components: ShellComponents
  readonly focused: boolean
  /** 多 pane 时为 true：画方角框 + 标题条。 */
  readonly framed: boolean
  /** 前缀键已按下：此拍输入框要静默，避免 Ctrl-B 之后的键落进会话。 */
  readonly prefixPending: boolean
  readonly onSubmit: (sessionId: SessionId, text: string) => void
}

export function PaneView({ pane, state, components, focused, framed, prefixPending, onSubmit }: PaneViewProps): ReactElement {
  const { Conversation, Composer, PendingPrompt } = components
  const session = pane.sessionId !== null ? state.sessions.get(pane.sessionId as SessionId) : undefined

  const title =
    session === undefined
      ? pane.sessionId === null
        ? '(无会话)'
        : String(pane.sessionId)
      : session.title ?? (session.blank ? '(新会话)' : String(session.sessionId))
  const mark = session !== undefined ? STATUS_MARKS[session.status] : undefined

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      {...(framed
        ? {
            borderStyle: 'single' as const,
            ...(focused ? { borderColor: 'cyan' } : { borderColor: 'gray' }),
          }
        : {})}
    >
      {framed ? (
        <Box>
          {mark !== undefined ? (
            <Text {...(mark.color !== undefined ? { color: mark.color } : {})}>{mark.symbol} </Text>
          ) : null}
          <Text {...(focused ? { bold: true } : {})}>{title}</Text>
        </Box>
      ) : null}
      {session !== undefined ? (
        <>
          <Conversation view={state.conversation(session.sessionId)} focused={focused} />
          {session.pending !== undefined ? (
            <PendingPrompt pending={session.pending} focused={focused} />
          ) : (
            <Composer
              sessionId={session.sessionId}
              focused={focused && !prefixPending}
              onSubmit={(text) => onSubmit(session.sessionId, text)}
            />
          )}
        </>
      ) : (
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text dimColor>这个 pane 还没有会话</Text>
        </Box>
      )}
    </Box>
  )
}
