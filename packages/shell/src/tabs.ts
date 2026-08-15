/**
 * tab 层：同样是纯数据结构 + 纯函数。
 * 一个 workspace 承载一组 tab，一个 tab 承载一棵 layout 树。
 * workspace 列表本身来自 `DshrState`，这里只管 shell 自己的 tab/焦点簿记。
 */
import type { LayoutNode } from './layout.js'
import { closePane, createPane } from './layout.js'

export interface Tab {
  readonly tabId: string
  /** 属于哪个工作区（`WorkspaceSummary.workspaceId`）。 */
  readonly workspaceId: string
  /** tab bar 上的标题；默认取会话标题，缺省用编号。 */
  title?: string
  /** null = 所有 pane 都被关了（空 tab，等待新会话）。 */
  readonly root: LayoutNode | null
  readonly focusedPaneId: string | null
}

let counter = 0
export function resetTabIds(): void {
  counter = 0
}

export function createTab(workspaceId: string, title?: string): Tab {
  counter += 1
  const pane = createPane()
  return {
    tabId: `tab-${counter}`,
    workspaceId,
    root: pane,
    focusedPaneId: pane.paneId,
    ...(title !== undefined ? { title } : {}),
  }
}

/** 关掉某 tab 里某 pane；最后一片被关时 tab 变空（root=null），不自动删 tab。 */
export function closeTabPane(tab: Tab, paneId: string): { tab: Tab; closedSessionId: string | null; found: boolean } {
  if (tab.root === null) return { tab, closedSessionId: null, found: false }
  const r = closePane(tab.root, paneId)
  if (!r.found) return { tab, closedSessionId: null, found: false }
  const focusedPaneId =
    tab.focusedPaneId === paneId
      ? r.root === null
        ? null
        : firstPaneId(r.root)
      : tab.focusedPaneId
  return { tab: { ...tab, root: r.root, focusedPaneId }, closedSessionId: r.closedSessionId, found: true }
}

export function firstPaneId(root: LayoutNode): string {
  return root.kind === 'pane' ? root.paneId : firstPaneId(root.first)
}

/** 循环切 tab。空数组返回 null。 */
export function adjacentTabId(tabs: readonly Tab[], currentId: string, step: 1 | -1): string | null {
  if (tabs.length === 0) return null
  const idx = tabs.findIndex((t) => t.tabId === currentId)
  const base = idx === -1 ? 0 : idx
  const next = tabs[(base + step + tabs.length) % tabs.length]
  return next ? next.tabId : null
}
