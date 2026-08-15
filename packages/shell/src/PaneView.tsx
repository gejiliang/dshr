/**
 * 单个 pane 的渲染：边框 + 标题条 + 会话内容（注入的 tui 组件）。
 * pane = 一个 dsh session；没绑会话时显示占位。
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
  /** 前缀键已按下：此拍输入框要静默，避免 Ctrl-B 之后的键落进会话。 */
  readonly prefixPending: boolean
  readonly onSubmit: (sessionId: SessionId, text: string) => void
}

export function PaneView({ pane, state, components, focused, prefixPending, onSubmit }: PaneViewProps): ReactElement {
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
      borderStyle="round"
      {...(focused ? { borderColor: 'cyan' } : { borderColor: 'gray' })}
    >
      <Box>
        {mark !== undefined ? (
          <Text {...(mark.color !== undefined ? { color: mark.color } : {})}>{mark.symbol} </Text>
        ) : null}
        <Text {...(focused ? { bold: true } : {})}>{title}</Text>
      </Box>
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
