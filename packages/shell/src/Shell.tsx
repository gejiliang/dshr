/**
 * 整壳：侧栏 + 内容区（tab 栏 / pane 区 / 底部提示栏）+ 覆盖层。
 *
 * 布局逻辑全部在 `layout.ts` / `tabs.ts` / `overlay.ts` / `keys.ts` / `hint.ts`
 * 的纯函数里，这里只负责：
 * 1. 把键事件折算成 `KeyStroke` / `OverlayKeyStroke` 喂给纯状态机，把动作应用到纯数据上；
 * 2. 新建 tab / pane 时**默认开一个新 dsh 会话**，且挂在**当前活动工作区**下；
 * 3. 持有活动工作区（`initialWorkspaceId` 只是初值）：切换工作区只是换视角，
 *    每个 workspace 自己的 tab 集合原封不动，切回去还在；
 * 4. 把这棵树画出来。终端尺寸变化由 flexbox 布局自动重算。
 *
 * 画面结构对齐 herdr（docs/herdr-reference.md）：侧栏在最左（spaces 列表 +
 * 底部 2×2 入口块 + «），内容区在其右、由一条贯穿的竖线隔开，tab 栏在内容区
 * 顶部，底部一行在「前缀键位提示」与「会话状态」之间切换。
 */
import type { DshrState, SessionId } from '@dshr/state'
import { Box, Text, useInput, useStdout } from 'ink'
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ShellComponents } from './components.js'
import { HintBar } from './HintBar.js'
import { KeyDispatcher, type KeyStroke } from './keys.js'
import {
  type LayoutNode,
  computeRects,
  findPane,
  focusDirection,
  paneCount,
  paneIds,
  setPaneSession,
  splitPane,
} from './layout.js'
import { NewWorkspaceOverlay, WorkspacePickerOverlay, HelpOverlay } from './Overlays.js'
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
import { Sidebar, type SidebarView } from './Sidebar.js'
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
  /** 侧栏中间区域显示 space 列表还是全量 agent 列表（herdr 的 agents 入口格）。 */
  readonly sidebarView: SidebarView
}

/** 覆盖层状态（纯数据，状态机在 overlay.ts）。 */
type OverlayState =
  | { readonly kind: 'picker'; readonly model: WorkspacePickerModel }
  | { readonly kind: 'newWorkspace'; readonly input: TextInputModel; readonly error: string | null }
  | { readonly kind: 'help' }

/** herdr 截屏里侧栏连竖线共 25 列。 */
const DEFAULT_SIDEBAR_WIDTH = 25

export function Shell({ state, components, initialWorkspaceId, cwd, sidebarWidth }: ShellProps): ReactElement {
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(initialWorkspaceId)
  const [model, setModel] = useState<ShellModel>({
    tabs: [],
    activeTabByWorkspace: new Map(),
    sidebarOpen: true,
    sidebarView: 'spaces',
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
  // ink 只把根节点宽度钉在终端宽上，高度是内容驱动的；想铺满全屏
  // （侧栏拉到底、底部栏钉在末行）就得自己按终端行数定高。
  // 尺寸未知的 tty 给的是 **0**（不是 undefined），用 > 0 判。
  const termRows = stdout?.rows !== undefined && stdout.rows > 0 ? stdout.rows : 24

  // 当前工作区视角：只看属于它的 tab；活跃 tab 从它自己的记忆里取
  const visibleTabs = useMemo(
    () => model.tabs.filter((t) => t.workspaceId === activeWorkspaceId),
    [model.tabs, activeWorkspaceId],
  )
  const activeTabId = model.activeTabByWorkspace.get(activeWorkspaceId) ?? null
  const activeTab = visibleTabs.find((t) => t.tabId === activeTabId) ?? visibleTabs[0] ?? null
  const activePaneId = activeTab?.focusedPaneId ?? null
  // 焦点 pane 的**当前**值，供 acceptsKey 在按键时刻读。
  // 渲染时同步一次作为兜底；真正要紧的是动作发生时由 mutateActiveTab 当场写入——
  // 否则「分屏之后紧接着打的字」会投进旧 pane。
  const activePaneIdRef = useRef<string | null>(null)
  activePaneIdRef.current = activePaneId

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

  const setActiveTab = useCallback(
    (tabId: string) => {
      setModel((m) => ({
        ...m,
        activeTabByWorkspace: new Map(m.activeTabByWorkspace).set(activeWorkspaceId, tabId),
      }))
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
      if (cur.kind === 'help') {
        if (stroke.escape) applyOverlay(null)
        return
      }
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
      forcePrefixTick((n) => n + 1) // 让底部提示栏出现
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
        if (next !== null) setActiveTab(next)
        break
      }
      case 'selectTab': {
        const target = visibleTabs[a.index - 1]
        if (target !== undefined) setActiveTab(target.tabId)
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
        // ⚠️ 焦点要**当场**写进 ref，不能写在 setModel 的 updater 里：
        // 那个 updater 是 React 渲染阶段才跑的，不是调用时。写晚了，
        // 分屏后紧接着打的字会投进旧 pane（实测）。
        if (fresh !== undefined) activePaneIdRef.current = fresh
        mutateActiveTab((t) => ({ ...t, root, focusedPaneId: fresh ?? t.focusedPaneId }))
        if (fresh !== undefined) spawnSession(fresh, activeTab.tabId, activeWorkspaceId)
        break
      }
      case 'focusPane': {
        if (activeTab?.root == null || activePaneId === null) break
        // 尺寸未知的 tty 给的是 **0** 而不是 undefined，`??` 挡不住--用 > 0 判。
        const cols = stdout?.columns
        const rws = stdout?.rows
        const width = cols !== undefined && cols > 0 ? cols : 80
        const height = (rws !== undefined && rws > 0 ? rws : 24) - 2 // 去掉 tab 栏与底部栏
        const next = focusDirection(activeTab.root, activePaneId, a.direction, { x: 0, y: 0, width, height })
        activePaneIdRef.current = next // 同上：当场写，别等 updater
        mutateActiveTab((t) => ({ ...t, focusedPaneId: next }))
        break
      }
      case 'closePane': {
        if (activeTab === null || activePaneId === null) break
        const r = closeTabPane(activeTab, activePaneId)
        if (!r.found) break
        // 关 pane 只是 detach：会话本身留在 host 上，agents 视图里仍可见、可重开
        mutateActiveTab(() => r.tab)
        break
      }
      case 'toggleSidebar':
        setModel((m) => ({ ...m, sidebarOpen: !m.sidebarOpen }))
        break
      case 'sidebarAgentsView':
        setModel((m) => ({ ...m, sidebarView: m.sidebarView === 'spaces' ? 'agents' : 'spaces' }))
        break
      case 'toggleZoom':
        if (activeTab === null || activePaneId === null) break
        mutateActiveTab((t) =>
          t.focusedPaneId === null
            ? t
            : { ...t, zoomedPaneId: t.zoomedPaneId === t.focusedPaneId ? null : t.focusedPaneId },
        )
        break
      case 'showHelp':
        applyOverlay({ kind: 'help' })
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

  // herdr：单 pane 不画框；多 pane 时每片方角框。zoom 时可见的也只有一片。
  const framed = activeTab?.root != null && activeTab.zoomedPaneId === null && paneCount(activeTab.root) > 1
  const zoomedPane =
    activeTab?.root != null && activeTab.zoomedPaneId !== null
      ? findPane(activeTab.root, activeTab.zoomedPaneId)
      : null

  /**
   * 按键时刻判断某个 pane 的输入框该不该收这个键。
   *
   * ⚠️ 关键是 `dispatcher.awaitingPrefixFollowUp` 读的是**当前**值（dispatcher 在 ref 里），
   * 而不是渲染时快照。前缀动作之后输入框要立刻重新收键——若等重渲染落地，
   * 中间到达的键会被永久丢掉（实测并行跑测试稳定复现，等 5 秒也补不回来）。
   */
  const acceptsKeyFor = (paneId: string) => () =>
    overlayRef.current === null &&
    paneId === activePaneIdRef.current &&
    !dispatcher.awaitingPrefixFollowUp

  const renderNode = (node: LayoutNode): ReactElement => {
    if (node.kind === 'pane') {
      return (
        <PaneView
          key={node.paneId}
          pane={node}
          state={state}
          components={components}
          focused={overlay === null && node.paneId === activePaneId}
          framed={framed}
          prefixPending={dispatcher.awaitingPrefixFollowUp}
          acceptsKey={acceptsKeyFor(node.paneId)}
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
    <Box flexDirection="row" width="100%" height={termRows}>
      {model.sidebarOpen ? (
        <Sidebar
          state={state}
          activeSessionId={activeSessionId}
          width={sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH}
          activeWorkspaceId={activeWorkspaceId}
          view={model.sidebarView}
        />
      ) : null}
      {/* 侧栏开着时，内容区左边一条贯穿的竖线（herdr 截屏里唯一的分隔线） */}
      <Box
        flexDirection="column"
        flexGrow={1}
        {...(model.sidebarOpen
          ? {
              borderStyle: 'single' as const,
              borderLeft: true,
              borderTop: false,
              borderRight: false,
              borderBottom: false,
              borderColor: 'gray',
            }
          : {})}
      >
        <TabBar tabs={visibleTabs} activeTabId={activeTab?.tabId ?? null} />
        <Box flexDirection="column" flexGrow={1}>
          {activeTab?.root != null ? (
            zoomedPane !== null ? (
              <PaneView
                pane={zoomedPane}
                state={state}
                components={components}
                focused={overlay === null && zoomedPane.paneId === activePaneId}
                framed={false}
                prefixPending={dispatcher.awaitingPrefixFollowUp}
                acceptsKey={acceptsKeyFor(zoomedPane.paneId)}
                onSubmit={onSubmit}
              />
            ) : (
              renderNode(activeTab.root)
            )
          ) : (
            <Box flexGrow={1} justifyContent="center" alignItems="center">
              <Text dimColor>Ctrl-B c 新建 tab · Ctrl-B w 切换工作区</Text>
            </Box>
          )}
        </Box>
        {/* 底部一行：前缀按下时是键位提示，平时是会话状态（模型 · 上下文 · 连接） */}
        {dispatcher.awaitingPrefixFollowUp ? (
          <HintBar />
        ) : (
          <StatusLine
            tabCount={visibleTabs.length}
            activeTitle={activeSummary?.title ?? ''}
            activeStatus={activeSummary?.status ?? null}
            prefixPending={dispatcher.awaitingPrefixFollowUp}
            sidebarOpen={model.sidebarOpen}
          />
        )}
      </Box>
      {overlay?.kind === 'picker' ? <WorkspacePickerOverlay model={overlay.model} /> : null}
      {overlay?.kind === 'newWorkspace' ? (
        <NewWorkspaceOverlay input={overlay.input} error={overlay.error} />
      ) : null}
      {overlay?.kind === 'help' ? <HelpOverlay /> : null}
    </Box>
  )
}
