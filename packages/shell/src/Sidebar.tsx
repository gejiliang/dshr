/**
 * 侧栏：工作区与其下的会话列表，每个会话带实时状态点。
 * 数据**直接来自 `DshrState`**（workspaces + sessions map），shell 不猜不轮询。
 */
import type { AgentStatus, DshrState, SessionId, SessionSummary } from '@dshr/state'
import { Box, Text } from 'ink'
import type { ReactElement } from 'react'

/** 四态的符号与颜色。blocked 是唯一需要人介入的状态，必须最扎眼：黄底黑字反显。 */
export const STATUS_MARKS: Readonly<Record<AgentStatus, { symbol: string; color?: string; inverse?: boolean }>> = {
  idle: { symbol: '○', color: 'gray' },
  working: { symbol: '●', color: 'green' },
  blocked: { symbol: '◆', color: 'black', inverse: true }, // 反显 = 扎眼
  error: { symbol: '✖', color: 'red' },
}

export interface SidebarProps {
  readonly state: DshrState
  /** 当前聚焦 pane 绑定的会话，用于高亮。 */
  readonly activeSessionId: SessionId | null
  readonly width: number
}

function sessionTitle(s: SessionSummary): string {
  if (s.title !== undefined && s.title.length > 0) return s.title
  return s.blank ? '(新会话)' : String(s.sessionId)
}

function StatusDot({ status }: { readonly status: AgentStatus }): ReactElement {
  const mark = STATUS_MARKS[status]
  // exactOptionalPropertyTypes：不给可选 prop 显式传 undefined，用条件展开
  const extra: { color?: string; inverse?: boolean } = {
    ...(mark.color !== undefined ? { color: mark.color } : {}),
    ...(mark.inverse !== undefined ? { inverse: mark.inverse } : {}),
  }
  return <Text {...extra}>{mark.symbol}</Text>
}

export function Sidebar({ state, activeSessionId, width }: SidebarProps): ReactElement {
  return (
    <Box flexDirection="column" width={width} borderStyle="single" borderColor="gray">
      <Text bold>工作区</Text>
      {state.workspaces.map((ws) => (
        <Box key={String(ws.workspaceId)} flexDirection="column">
          <Text color="cyan">{ws.title}</Text>
          {ws.sessionIds.map((sid) => {
            const s = state.sessions.get(sid)
            if (!s) return null
            const active = activeSessionId !== null && String(sid) === String(activeSessionId)
            return (
              <Box key={String(sid)} paddingLeft={1}>
                <StatusDot status={s.status} />
                <Text {...(active ? { bold: true } : {})}>{` ${sessionTitle(s)}`}</Text>
              </Box>
            )
          })}
        </Box>
      ))}
      {state.workspaces.length === 0 ? <Text dimColor>(无工作区)</Text> : null}
    </Box>
  )
}
