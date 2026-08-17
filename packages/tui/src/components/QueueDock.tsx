/**
 * 排队消息徽章（opencode 的 QueueDock）：反色 ` QUEUED `（前后各一空格），
 * 底色用 agent 色（本主题的 secondary），前景取对比色（background）。
 *
 * 数据来自 `session/queue` 帧的整份快照（只渲染 placement === 'queued' 的，
 * steering/context 不在这个面——上游注释：context 项被认领前不可见）。
 */
import { Text } from 'ink'
import type { QueuedMessage } from '@dshr/state'
import { theme } from '../theme.js'
import { firstLine } from '../text-utils.js'

export function QueueDock({ items }: { items: readonly QueuedMessage[] }) {
  return (
    <>
      {items.map((item) => (
        <Text key={item.id} wrap="truncate-end">
          <Text backgroundColor={theme.secondary} color={theme.background}>
            {' QUEUED '}
          </Text>
          <Text color={theme.textMuted}> {firstLine(item.text)}</Text>
        </Text>
      ))}
    </>
  )
}
