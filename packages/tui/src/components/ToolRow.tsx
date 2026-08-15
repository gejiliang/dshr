import { memo } from 'react'
import { Box, Text } from 'ink'
import { colors } from '../theme.js'
import { toolCallTitle, toolResultSummary, type ToolItem } from '../tool-view.js'

/**
 * 工具调用折叠成一行 `⏺ bash(npm test)`，结果摘要一行 dim；
 * 失败标红。展开看详情留给后续快捷键，这一版只有折叠态。
 */
export const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }) {
  const title = toolCallTitle(item)
  const head = title === '' ? item.name : `${item.name}(${title})`
  const failed = item.status === 'error'
  const summary = toolResultSummary(item)
  return (
    <Box flexDirection="column">
      <Text {...(failed ? { color: colors.error } : {})}>
        ⏺ {head}
        {item.status === 'running' ? <Text dimColor> …</Text> : null}
      </Text>
      {summary === undefined ? null : (
        <Text {...(failed ? { color: colors.error } : { dimColor: true })}>
          {'  '}
          {failed ? '✕' : '⎿'} {summary}
        </Text>
      )}
    </Box>
  )
})
