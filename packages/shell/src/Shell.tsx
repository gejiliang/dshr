/**
 * 整壳：tab bar + pane 区 + 侧栏 + 状态行。
 *
 * 布局逻辑全部在 `layout.ts` / `tabs.ts` 的纯函数里，这里只负责：
 * 1. 把键事件折算成 `KeyStroke` 喂给 `KeyDispatcher`，把动作应用到纯数据上；
 * 2. 新建 tab / pane 时**默认开一个新 dsh 会话**（产品的原始要求）；
 * 3. 把这棵树画出来。终端尺寸变化由 flexbox 布局自动重算。
 */
import type { DshrState, SessionId } from '@dshr/state'
import { Box, Text, useInput, useStdout } from 'ink'
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ShellComponents } from './components.js'
import { KeyDispatcher, type KeyStroke } from './keys.js'
import {
  type LayoutNode,
  computeRects,
  focusDirection,
  paneIds,
  setPaneSession,
  splitPane,
} from './layout.js'
import { PaneView } from './PaneView.js'
import { Sidebar } from './Sidebar.js'
import { TabBar } from './TabBar.js'
import { type Tab, adjacentTabId, closeTabPane, createTab } from './tabs.js'

export interface ShellProps {
  readonly state: DshrState
  readonly components: ShellComponents
  /** 当前工作区 id；新 tab 落在这里。 */
  readonly workspaceId: string
  /** 新会话的 cwd：默认取工作区 path。 */
  readonly cwd?: string
  readonly sidebarWidth?: number
}

interface ShellModel {
  readonly tabs: readonly Tab[]
  readonly activeTabId: string | null
  readonly sidebarOpen: boolean
}

const DEFAULT_SIDEBAR_WIDTH = 28

export function Shell({ state, components, workspaceId, cwd, sidebarWidth }: ShellProps): ReactElement {
  const [model, setModel] = useState<ShellModel>({ tabs: [], activeTabId: null, sidebarOpen: true })
  const dispatcherRef = useRef<KeyDispatcher | null>(null)
  if (dispatcherRef.current === null) dispatcherRef.current = new KeyDispatcher()
  const dispatcher = dispatcherRef.current
  const [, forcePrefixTick] = useState(0)
  const { stdout } = useStdout()

  const activeTab = model.tabs.find((t) => t.tabId === model.activeTabId) ?? null
  const activePaneId = activeTab?.focusedPaneId ?? null
  const activeSessionId = useMemo(() => {
    if (activeTab?.root == null || activePaneId === null) return null
    // paneId → sessionId
    const find = (n: LayoutNode): SessionId | null => {
      if (n.kind === 'pane') return n.paneId === activePaneId ? (n.sessionId as SessionId | null) : null
      return find(n.first) ?? find(n.second)
    }
    return find(activeTab.root)
  }, [activeTab, activePaneId])

  /** 给某个 pane 开新会话并绑定（异步，失败留空 pane）。 */
  const spawnSession = useCallback(
    (paneId: string, tabId: string) => {
      const ws = state.workspaces.find((w) => String(w.workspaceId) === workspaceId)
      void state
        .createSession({
          cwd: cwd ?? ws?.path ?? process.cwd(),
          ...(ws !== undefined ? { workspaceId: ws.workspaceId } : {}),
        })
        .then((sessionId) => {
          setModel((m) => ({
            ...m,
            tabs: m.tabs.map((t) =>
              t.tabId === tabId && t.root !== null
                ? { ...t, root: setPaneSession(t.root, paneId, sessionId) }
                : t,
            ),
          }))
        })
    },
    [state, workspaceId, cwd],
  )

  const newTab = useCallback(() => {
    const tab = createTab(workspaceId)
    setModel((m) => ({ ...m, tabs: [...m.tabs, tab], activeTabId: tab.tabId }))
    if (tab.focusedPaneId !== null) spawnSession(tab.focusedPaneId, tab.tabId)
  }, [workspaceId, spawnSession])

  // 启动时开第一个 tab（连带第一个会话）
  const bootedRef = useRef(false)
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    newTab()
  }, [newTab])

  const mutateActiveTab = useCallback((fn: (tab: Tab) => Tab) => {
    setModel((m) => ({
      ...m,
      tabs: m.tabs.map((t) => (t.tabId === m.activeTabId ? fn(t) : t)),
    }))
  }, [])

  useInput((input, key) => {
    const stroke: KeyStroke = {
      input,
      ...(key.ctrl ? { ctrl: true } : {}),
      ...(key.upArrow ? { upArrow: true } : {}),
      ...(key.downArrow ? { downArrow: true } : {}),
      ...(key.leftArrow ? { leftArrow: true } : {}),
      ...(key.rightArrow ? { rightArrow: true } : {}),
    }
    const result = dispatcher.dispatch(stroke)
    if (result.kind === 'consumed') {
      forcePrefixTick((n) => n + 1) // 让状态行反映「前缀已按下」
      return
    }
    if (result.kind === 'passthrough') return // 交给聚焦 pane 的输入框（它自己的 useInput 处理）
    forcePrefixTick((n) => n + 1)
    const a = result.action
    switch (a.type) {
      case 'newTab':
        newTab()
        break
      case 'nextTab':
      case 'prevTab': {
        const next = adjacentTabId(model.tabs, model.activeTabId ?? '', a.type === 'nextTab' ? 1 : -1)
        if (next !== null) setModel((m) => ({ ...m, activeTabId: next }))
        break
      }
      case 'splitVertical':
      case 'splitHorizontal': {
        if (activeTab === null || activePaneId === null) break
        const dir = a.type === 'splitVertical' ? 'v' : 'h'
        if (activeTab.root === null) break
        const before = paneIds(activeTab.root)
        const root = splitPane(activeTab.root, activePaneId, dir)
        const fresh = paneIds(root).find((id) => !before.includes(id))
        mutateActiveTab((t) => ({ ...t, root, focusedPaneId: fresh ?? t.focusedPaneId }))
        if (fresh !== undefined) spawnSession(fresh, activeTab.tabId)
        break
      }
      case 'focusPane': {
        if (activeTab?.root == null || activePaneId === null) break
        const width = stdout?.columns ?? 80
        const height = (stdout?.rows ?? 24) - 2 // 去掉 tab bar 与状态行
        const next = focusDirection(activeTab.root, activePaneId, a.direction, { x: 0, y: 0, width, height })
        mutateActiveTab((t) => ({ ...t, focusedPaneId: next }))
        break
      }
      case 'closePane': {
        if (activeTab === null || activePaneId === null) break
        const r = closeTabPane(activeTab, activePaneId)
        if (!r.found) break
        // 关 pane 只是 detach：会话本身留在 host 上，侧栏里仍可见、可重开
        mutateActiveTab(() => r.tab)
        break
      }
      case 'toggleSidebar':
        setModel((m) => ({ ...m, sidebarOpen: !m.sidebarOpen }))
        break
    }
  })

  const onSubmit = useCallback(
    (sessionId: SessionId, text: string) => {
      void state.prompt(sessionId, text)
    },
    [state],
  )

  const renderNode = (node: LayoutNode): ReactElement => {
    if (node.kind === 'pane') {
      return (
        <PaneView
          key={node.paneId}
          pane={node}
          state={state}
          components={components}
          focused={node.paneId === activePaneId}
          prefixPending={dispatcher.awaitingPrefixFollowUp}
          onSubmit={onSubmit}
        />
      )
    }
    return (
      <Box flexDirection={node.direction === 'v' ? 'row' : 'column'} flexGrow={1}>
        <Box flexGrow={node.ratio} flexBasis={0}>
          {renderNode(node.first)}
        </Box>
        <Box flexGrow={1 - node.ratio} flexBasis={0}>
          {renderNode(node.second)}
        </Box>
      </Box>
    )
  }

  const { StatusLine } = components
  const activeSummary = activeSessionId !== null ? state.sessions.get(activeSessionId) : undefined

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <TabBar tabs={model.tabs} activeTabId={model.activeTabId} />
      <Box flexGrow={1} flexDirection="row">
        {model.sidebarOpen ? (
          <Sidebar state={state} activeSessionId={activeSessionId} width={sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH} />
        ) : null}
        <Box flexGrow={1} flexDirection="column">
          {activeTab?.root != null ? (
            renderNode(activeTab.root)
          ) : (
            <Box flexGrow={1} justifyContent="center" alignItems="center">
              <Text dimColor>Ctrl-B c 新建 tab</Text>
            </Box>
          )}
        </Box>
      </Box>
      <StatusLine
        tabCount={model.tabs.length}
        activeTitle={activeSummary?.title ?? ''}
        activeStatus={activeSummary?.status ?? null}
        prefixPending={dispatcher.awaitingPrefixFollowUp}
        sidebarOpen={model.sidebarOpen}
      />
    </Box>
  )
}
