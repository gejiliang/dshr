/**
 * 底部提示栏：前缀按下时出现的一行键位提示（herdr 的 NAVIGATE 行的等价物）。
 * 内容是 `hint.ts` 的纯数据，这里只负责画。
 */
import { Text } from 'ink'
import type { ReactElement } from 'react'
import { PREFIX_HINT, hintLine } from './hint.js'

export function HintBar(): ReactElement {
  return (
    <Text wrap="truncate-end">
      <Text bold>PREFIX</Text>
      <Text dimColor>{hintLine('', PREFIX_HINT)}</Text>
    </Text>
  )
}
