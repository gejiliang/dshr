import { Box, Text } from 'ink'
import { theme } from '../theme.js'
import { formatCount } from '../text-utils.js'

export interface SidebarGoal {
  readonly objective: string
  /** `active` / `paused` / `blocked` / `complete`。 */
  readonly phase: string
  readonly blockedReason?: string
  readonly roundsStarted: number
  readonly maxGoalRounds: number
}

export interface SidebarProps {
  title?: string
  /** workspace 标签（工作区名或会话 cwd）。 */
  workspace?: string
  /** 上下文用量（tokens）。缺省时整块 Context 不画。 */
  contextTokens?: number
  contextPercent?: number
  /** 当前目标（`goal` 投影）；缺省时整块 Goal 不画。 */
  goal?: SidebarGoal
  /** 底部版本行：`• dshr <version>`。 */
  version?: string
}

/**
 * 右侧信息列（opencode `routes/session/sidebar` 的对齐）：width 42、
 * padding 左右 2 上下 1、`backgroundPanel` 底色。顶部是标题块（标题加粗、
 * workspace 标签 textMuted），中间 Context/tokens，底部固定一行版本行。
 *
 * dsh 没有的数据（花费、LSP、MCP）**不画**，不填假值。
 * pane 窄于 100 列时由外层整列折叠（上游 <120 列时也是降级处理）。
 */
export function Sidebar({ title, workspace, contextTokens, contextPercent, goal, version }: SidebarProps) {
  const hasContext = contextTokens !== undefined
  return (
    <Box
      width={42}
      flexShrink={0}
      flexDirection="column"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={theme.backgroundPanel}
    >
      <Box flexDirection="column" gap={1} flexShrink={0}>
        <Text bold color={theme.text} wrap="truncate-end">
          {title ?? 'New session'}
        </Text>
        {workspace !== undefined ? (
          <Text color={theme.textMuted} wrap="truncate-end">
            {workspace}
          </Text>
        ) : null}
      </Box>
      {hasContext ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <Text bold color={theme.text}>
            Context
          </Text>
          <Text color={theme.textMuted}>{formatCount(contextTokens ?? 0)} tokens</Text>
          {contextPercent !== undefined ? (
            <Text color={theme.textMuted}>{contextPercent}% used</Text>
          ) : null}
        </Box>
      ) : null}
      {goal !== undefined ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <Text bold color={theme.text}>
            Goal
          </Text>
          <Text color={theme.text} wrap="truncate-end">
            {goal.objective}
          </Text>
          <Text
            color={
              goal.phase === 'blocked'
                ? theme.error
                : goal.phase === 'paused'
                  ? theme.warning
                  : theme.textMuted
            }
          >
            {goal.phase}
            {goal.maxGoalRounds > 0 ? ` · round ${goal.roundsStarted}/${goal.maxGoalRounds}` : ''}
          </Text>
          {goal.blockedReason !== undefined ? (
            <Text color={theme.textMuted} wrap="truncate-end">
              {goal.blockedReason}
            </Text>
          ) : null}
        </Box>
      ) : null}
      <Box flexGrow={1} />
      <Box flexShrink={0} paddingTop={1}>
        <Text color={theme.textMuted}>
          <Text color={theme.success}>•</Text> <Text bold>dshr</Text>
          {version !== undefined ? ` ${version}` : ''}
        </Text>
      </Box>
    </Box>
  )
}
