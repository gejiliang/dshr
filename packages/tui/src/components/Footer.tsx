import type { ReactElement } from 'react'
import { Box, Text } from 'ink'
import { theme } from '../theme.js'

export type ConnectionStatus = 'connecting' | 'ready' | 'lost' | 'closed'

export interface FooterProps {
  /** 当前目录（缩写 ~）。 */
  cwd?: string
  /** 未决审批数。0 或缺省不画格子（opencode 只在有未决时画 `△ N`）。 */
  pendingApprovals?: number
  /** 正在跑的后台任务数（`session/jobs` 快照里 status === 'running' 的）。0 或缺省不画。 */
  runningJobs?: number
  connection?: ConnectionStatus
  model?: string
}

function connectionChip(connection: ConnectionStatus): ReactElement {
  switch (connection) {
    case 'ready':
      return (
        <Text>
          <Text color={theme.success}>•</Text> connected
        </Text>
      )
    case 'connecting':
      return (
        <Text>
          <Text color={theme.textMuted}>•</Text> connecting
        </Text>
      )
    case 'lost':
      return (
        <Text>
          <Text color={theme.error}>•</Text> disconnected
        </Text>
      )
    case 'closed':
      return (
        <Text>
          <Text color={theme.textMuted}>•</Text> closed
        </Text>
      )
  }
}

/**
 * 底部栏（opencode `routes/session/footer` 的对齐）：一行 row、space-between，
 * 左 cwd（textMuted），右一排状态 chip（gap 2）。dsh 没有 LSP / MCP--
 * 不画永远为零的格子，chip 只有未决审批 / 连接 / 模型。
 */
export function Footer({ cwd, pendingApprovals = 0, runningJobs = 0, connection = 'ready', model }: FooterProps) {
  return (
    <Box justifyContent="space-between" gap={1}>
      <Text color={theme.textMuted} wrap="truncate-end">
        {cwd ?? ''}
      </Text>
      <Box gap={2} flexShrink={0}>
        {pendingApprovals > 0 ? (
          <Text>
            <Text color={theme.warning}>△</Text>
            <Text color={theme.text}>
              {' '}
              {pendingApprovals} approval{pendingApprovals > 1 ? 's' : ''}
            </Text>
          </Text>
        ) : null}
        {runningJobs > 0 ? (
          <Text>
            <Text color={theme.secondary}>◆</Text>
            <Text color={theme.text}>
              {' '}
              {runningJobs} job{runningJobs > 1 ? 's' : ''} running
            </Text>
          </Text>
        ) : null}
        {connectionChip(connection)}
        {model !== undefined ? <Text color={theme.textMuted}>{model}</Text> : null}
      </Box>
    </Box>
  )
}
