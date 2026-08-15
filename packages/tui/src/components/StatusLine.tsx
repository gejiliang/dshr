import type { ReactElement } from 'react'
import { Text } from 'ink'
import type { AgentStatus } from '@dshr/state'
import { colors } from '../theme.js'
import { formatDuration, formatTokens } from '../text-utils.js'

export type ConnectionStatus = 'connecting' | 'ready' | 'lost' | 'closed'

export interface StatusLineProps {
  model?: string
  /** 上下文用量（tokens）。 */
  contextUsed?: number
  contextLimit?: number
  /** 当前轮耗时。 */
  turnElapsedMs?: number
  connection?: ConnectionStatus
  agentStatus?: AgentStatus
}

function connectionSegment(connection: ConnectionStatus): ReactElement {
  switch (connection) {
    case 'ready':
      return <Text>connected</Text>
    case 'connecting':
      return <Text>connecting…</Text>
    case 'lost':
      return <Text color={colors.error}>disconnected</Text>
    case 'closed':
      return <Text>closed</Text>
  }
}

function statusSegment(status: AgentStatus): ReactElement {
  switch (status) {
    case 'working':
      return <Text>working</Text>
    case 'blocked':
      return <Text color={colors.blocked}>blocked</Text>
    case 'error':
      return <Text color={colors.error}>error</Text>
    case 'idle':
      return <Text>idle</Text>
  }
}

/**
 * 一行状态：模型 · 上下文用量 · 当前轮耗时 · 连接状态。
 * 信息密度高、装饰为零；整行 dim，只有异常状态（disconnected / blocked / error）上色。
 */
export function StatusLine({
  model,
  contextUsed,
  contextLimit,
  turnElapsedMs,
  connection = 'ready',
  agentStatus,
}: StatusLineProps) {
  const segments: ReactElement[] = [<Text key="model">{model ?? '—'}</Text>]
  if (contextUsed !== undefined) {
    const ctx =
      contextLimit === undefined
        ? `${formatTokens(contextUsed)} ctx`
        : `${formatTokens(contextUsed)}/${formatTokens(contextLimit)} ctx`
    segments.push(<Text key="ctx">{ctx}</Text>)
  }
  if (turnElapsedMs !== undefined) {
    segments.push(<Text key="elapsed">{formatDuration(turnElapsedMs)}</Text>)
  }
  if (agentStatus !== undefined) {
    segments.push(<Text key="status">{statusSegment(agentStatus)}</Text>)
  }
  segments.push(<Text key="conn">{connectionSegment(connection)}</Text>)

  return (
    <Text dimColor wrap="truncate-end">
      {segments.flatMap((segment, index) =>
        index === 0 ? [segment] : [<Text key={`sep-${index}`}>{' · '}</Text>, segment],
      )}
    </Text>
  )
}
