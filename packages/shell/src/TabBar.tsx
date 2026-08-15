/**
 * 顶部 tab bar：列出当前工作区的 tab，高亮活跃 tab。
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
    <Box>
      {tabs.map((t, i) => {
        const active = t.tabId === activeTabId
        return (
          <Box key={t.tabId} marginRight={1}>
            <Text
              {...(active ? { inverse: true, bold: true } : { dimColor: true })}
            >{` ${tabLabel(t, i)} `}</Text>
          </Box>
        )
      })}
    </Box>
  )
}
