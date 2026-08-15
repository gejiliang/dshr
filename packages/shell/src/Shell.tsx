/**
 * 整壳：tab bar + pane 区 + 侧栏 + 状态行（+ 两个工作区覆盖层）。
 *
 * 布局逻辑全部在 `layout.ts` / `tabs.ts` / `overlay.ts` 的纯函数里，这里只负责：
 * 1. 把键事件折算成 `KeyStroke` / `OverlayKeyStroke` 喂给纯状态机，把动作应用到纯数据上；
 * 2. 新建 tab / pane 时**默认开一个新 dsh 会话**，且挂在**当前活动工作区**下；
 * 3. 持有活动工作区（`initialWorkspaceId` 只是初值）：切换工作区只是换视角，
 *    每个 workspace 自己的 tab 集合原封不动，切回去还在；
 * 4. 把这棵树画出来。终端尺寸变化由 flexbox 布局自动重算。
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
import { NewWorkspaceOverlay, WorkspacePickerOverlay } from './Overlays.js'
import {
  type OverlayKeyStroke,
  type TextInputModel,
  type WorkspacePickerModel,
  emptyTextInput,
  inputKey,
  openWorkspacePicker,
  pickerInputFromKey,
  pickerKey,
  textInputFromKey,
} from './overlay.js'
import { PaneView } from './PaneView.js'
import { Sidebar } from './Sidebar.js'
import { TabBar } from './TabBar.js'
import { type Tab, adjacentTabId, closeTabPane, createTab } from './tabs.js'

export interface ShellProps {
  readonly state: DshrState
  readonly components: ShellComponents
  /** 初始工作区 id；之后活动工作区是 shell 的内部状态，Ctrl-B w 可切换。 */
  readonly initialWorkspaceId: string
  /** 新会话的 cwd：默认取工作区 path。 */
  readonly cwd?: string
  readonly sidebarWidth?: number
}

interface ShellModel {
  /** 所有工作区的 tab 全在这里（tab 自带 workspaceId），切换工作区不删任何 tab。 */
  readonly tabs: readonly Tab[]
  /** 每个工作区各自记住自己的活跃 tab。 */
  readonly activeTabByWorkspace: ReadonlyMap<string, string | null>
  readonly sidebarOpen: boolean
}

/** 覆盖层状态（纯数据，状态机在 overlay.ts）。 */
type OverlayState =
  | { readonly kind: 'picker'; readonly model: WorkspacePickerModel }
  | { readonly kind: 'newWorkspace'; readonly input: TextInputModel; readonly error: string | null }

const DEFAULT_SIDEBAR_WIDTH = 28

export function Shell({ state, components, initialWorkspaceId, cwd, sidebarWidth }: ShellProps): ReactElement {
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(initialWorkspaceId)
  const [model, setModel] = useState<ShellModel>({
    tabs: [],
    activeTabByWorkspace: new Map(),
    sidebarOpen: true,
  })
  const [overlay, setOverlay] = useState<OverlayState | null>(null)
  // 键处理读 ref（同一拍内连续到达的键不能读到过期闭包），渲染读 state。
  const overlayRef = useRef<OverlayState | null>(null)
  const applyOverlay = useCallback((next: OverlayState | null) => {
    overlayRef.current = next
    setOverlay(next)
  }, [])
  const dispatcherRef = useRef<KeyDispatcher | null>(null)
  if (dispatcherRef.current === null) dispatcherRef.current = new KeyDispatcher()
  const dispatcher = dispatcherRef.current
  const [, forcePrefixTick] = useState(0)
  const { stdout } = useStdout()

  // 当前工作区视角：只看属于它的 tab；活跃 tab 从它自己的记忆里取
  const visibleTabs = useMemo(
    () => model.tabs.filter((t) => t.workspaceId === activeWorkspaceId),
    [model.tabs, activeWorkspaceId],
  )
  const activeTabId = model.activeTabByWorkspace.get(activeWorkspaceId) ?? null
  const activeTab = visibleTabs.find((t) => t.tabId === activeTabId) ?? visibleTabs[0] ?? null
  const activePaneId = activeTab?.focusedPaneId ?? null
  const activeSessionId = useMemo(() => {
    if (activeTab?.root == null || activePaneId === null) return null
    // paneId -> sessionId
    const find = (n: LayoutNode): SessionId | null => {
      if (n.kind === 'pane') return n.paneId === activePaneId ? (n.sessionId as SessionId | null) : null
      return find(n.first) ?? find(n.second)
    }
    return find(activeTab.root)
  }, [activeTab, activePaneId])

  /** 给某个 pane 开新会话并绑定（异步，失败留空 pane）。会话挂到 wsId 工作区下。 */
  const spawnSession = useCallback(
    (paneId: string, tabId: string, wsId: string) => {
      const ws = state.workspaces.find((w) => String(w.workspaceId) === wsId)
      // host 侧 session.create 只接受 workspaceId 或 cwd；@dshr/state 已做互斥，
      // 这里只需：有工作区就传 workspaceId，别自己拼 payload。
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
    [state, cwd],
  )

  const newTab = useCallback(
    (wsId: string = activeWorkspaceId) => {
      const tab = createTab(wsId)
      setModel((m) => ({
        ...m,
        tabs: [...m.tabs, tab],
        activeTabByWorkspace: new Map(m.activeTabByWorkspace).set(wsId, tab.tabId),
      }))
      if (tab.focusedPaneId !== null) spawnSession(tab.focusedPaneId, tab.tabId, wsId)
    },
    [activeWorkspaceId, spawnSession],
  )

  // 启动时开第一个 tab（连带第一个会话）
  const bootedRef = useRef(false)
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    newTab()
  }, [newTab])

  const mutateActiveTab = useCallback(
    (fn: (tab: Tab) => Tab) => {
      setModel((m) => {
        const id = m.activeTabByWorkspace.get(activeWorkspaceId)
        if (id === undefined || id === null) return m
        return { ...m, tabs: m.tabs.map((t) => (t.tabId === id ? fn(t) : t)) }
      })
    },
    [activeWorkspaceId],
  )

  /** 新建工作区：成功切过去并开新会话；失败把 host 的业务错误亮在覆盖层里。 */
  const submitNewWorkspace = useCallback(
    (path: string) => {
      state
        .createWorkspace(path)
        .then(
          (id) => {
            applyOverlay(null)
            const wsId = String(id)
            setActiveWorkspaceId(wsId)
            newTab(wsId)
          },
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            const cur = overlayRef.current
            if (cur !== null && cur.kind === 'newWorkspace') applyOverlay({ ...cur, error: message })
          },
        )
        .catch(() => {})
    },
    [state, newTab, applyOverlay],
  )

  /** 覆盖层按键：全部路由给纯状态机， pane 们此刻已失焦（见 renderNode）。 */
  const handleOverlayKey = useCallback(
    (stroke: OverlayKeyStroke) => {
      const cur = overlayRef.current
      if (cur === null) return
      if (cur.kind === 'picker') {
        const input = pickerInputFromKey(stroke)
        if (input === null) return
        const out = pickerKey(cur.model, input)
        if (out.kind === 'open') applyOverlay({ kind: 'picker', model: out.model })
        else if (out.kind === 'cancelled') applyOverlay(null)
        else {
          applyOverlay(null)
          setActiveWorkspaceId(out.workspaceId) // 只换视角，不动任何 tab
        }
        return
      }
      const input = textInputFromKey(stroke)
      if (input === null) return
      const out = inputKey(cur.input, input)
      if (out.kind === 'cancelled') {
        applyOverlay(null)
        return
      }
      if (out.kind === 'open') {
        // 用户继续编辑：清掉旧错误
        const clearsError = input.kind === 'char' || input.kind === 'backspace'
        applyOverlay({ kind: 'newWorkspace', input: out.model, error: clearsError ? null : cur.error })
        return
      }
      if (out.value.length === 0) return // 空路径不提交
      void submitNewWorkspace(out.value)
    },
    [submitNewWorkspace, applyOverlay],
  )

  useInput((input, key) => {
    if (overlayRef.current !== null) {
      handleOverlayKey({
        input,
        ...(key.upArrow ? { upArrow: true } : {}),
        ...(key.downArrow ? { downArrow: true } : {}),
        ...(key.return ? { returnKey: true } : {}),
        ...(key.escape ? { escape: true } : {}),
        ...(key.backspace || key.delete ? { backspace: true } : {}),
      })
      return
    }
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
        const next = adjacentTabId(
          visibleTabs,
          activeTab?.tabId ?? '',
          a.type === 'nextTab' ? 1 : -1,
        )
        if (next !== null) {
          setModel((m) => ({
            ...m,
            activeTabByWorkspace: new Map(m.activeTabByWorkspace).set(activeWorkspaceId, next),
          }))
        }
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
        if (fresh !== undefined) spawnSession(fresh, activeTab.tabId, activeWorkspaceId)
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
      case 'selectWorkspace':
        applyOverlay({
          kind: 'picker',
          model: openWorkspacePicker(
            state.workspaces.map((w) => ({ id: String(w.workspaceId), title: w.title, path: w.path })),
          ),
        })
        break
      case 'newWorkspace':
        applyOverlay({ kind: 'newWorkspace', input: emptyTextInput(), error: null })
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
          focused={overlay === null && node.paneId === activePaneId}
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
      <TabBar tabs={visibleTabs} activeTabId={activeTab?.tabId ?? null} />
      <Box flexGrow={1} flexDirection="row">
        {model.sidebarOpen ? (
          <Sidebar
            state={state}
            activeSessionId={activeSessionId}
            width={sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH}
            activeWorkspaceId={activeWorkspaceId}
          />
        ) : null}
        <Box flexGrow={1} flexDirection="column">
          {activeTab?.root != null ? (
            renderNode(activeTab.root)
          ) : (
            <Box flexGrow={1} justifyContent="center" alignItems="center">
              <Text dimColor>Ctrl-B c 新建 tab · Ctrl-B w 切换工作区</Text>
            </Box>
          )}
        </Box>
      </Box>
      {overlay?.kind === 'picker' ? <WorkspacePickerOverlay model={overlay.model} /> : null}
      {overlay?.kind === 'newWorkspace' ? (
        <NewWorkspaceOverlay input={overlay.input} error={overlay.error} />
      ) : null}
      <StatusLine
        tabCount={visibleTabs.length}
        activeTitle={activeSummary?.title ?? ''}
        activeStatus={activeSummary?.status ?? null}
        prefixPending={dispatcher.awaitingPrefixFollowUp}
        sidebarOpen={model.sidebarOpen}
      />
    </Box>
  )
}
