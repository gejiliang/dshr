/**
 * tab 栏：在**内容区顶部**（侧栏竖线右边，docs/herdr-reference.md 第一节），
 * 形如 ` 1  2     +`；`+` 是新建 tab 的可视入口（本版不可点，真入口是 prefix+c）。
 */
import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { Tab } from './tabs.js'

export interface TabBarProps {
  readonly tabs: readonly Tab[]
  readonly activeTabId: string | null
}

export function tabLabel(tab: Tab, index: number): string {
  return tab.title ?? `${index + 1}`
}

export function TabBar({ tabs, activeTabId }: TabBarProps): ReactElement {
  return (
    <Box width="100%">
      {tabs.map((t, i) => {
        const active = t.tabId === activeTabId
        return (
          <Text key={t.tabId} {...(active ? { inverse: true, bold: true } : { dimColor: true })}>
            {` ${tabLabel(t, i)} `}
          </Text>
        )
      })}
      <Box flexGrow={1} />
      <Text dimColor>+</Text>
    </Box>
  )
}
