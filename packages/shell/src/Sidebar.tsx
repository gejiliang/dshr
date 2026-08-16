/**
 * 侧栏，按 herdr 的结构（docs/herdr-reference.md 第一节）：
 *
 * ```
 *  spaces
 *
 *  · ~            <- space 列表（当前活动的用 ● 标出）
 *  ...
 *  new        menu  <- 2×2 入口块
 * ────────────────
 *  agents             <- 第四格留空：herdr 是 priority，dshr 没有这个概念
 *  «                  <- 折叠指示
 * ```
 *
 * 只负责画：数据直接来自 `DshrState`，视图切换（spaces / agents）是 shell 的状态。
 * 侧栏与内容区之间的竖线**不在这画**--它由内容区 Box 的 borderLeft 画出，
 * 这样线能贯穿 tab 栏与底部提示栏所在的行。
 */
import type { AgentStatus, DshrState, SessionId, SessionSummary } from '@dshr/state'
import { Box, Text } from 'ink'
import type { ReactElement } from 'react'

/** 四态的符号与颜色。blocked 是唯一需要人介入的状态，必须最扎眼：黄底黑字反显。 */
export const STATUS_MARKS: Readonly<Record<AgentStatus, { symbol: string; color?: string; inverse?: boolean }>> = {
  idle: { symbol: '○', color: 'gray' },
  working: { symbol: '●', color: 'green' },
  blocked: { symbol: '◆', color: 'black', inverse: true }, // 反显 = 扎眼
  error: { symbol: '✖', color: 'red' },
}

/** 侧栏中间区域显示什么：工作区列表，或全量 agent（会话）列表。 */
export type SidebarView = 'spaces' | 'agents'

export interface SidebarProps {
  readonly state: DshrState
  /** 当前聚焦 pane 绑定的会话（agents 视图里高亮）。 */
  readonly activeSessionId: SessionId | null
  /** 侧栏总宽，含右侧那条竖线占的一列。 */
  readonly width: number
  /** 当前活动工作区（shell 内部状态），spaces 视图里用 ● 标出。 */
  readonly activeWorkspaceId?: string | null
  readonly view: SidebarView
}

function sessionTitle(s: SessionSummary): string {
  if (s.title !== undefined && s.title.length > 0) return s.title
  return s.blank ? '(新会话)' : String(s.sessionId)
}

function StatusDot({ status }: { readonly status: AgentStatus }): ReactElement {
  const mark = STATUS_MARKS[status]
  // exactOptionalPropertyTypes：不给可选 prop 显式传 undefined，用条件展开
  const extra: { color?: string; inverse?: boolean } = {
    ...(mark.color !== undefined ? { color: mark.color } : {}),
    ...(mark.inverse !== undefined ? { inverse: mark.inverse } : {}),
  }
  return <Text {...extra}>{mark.symbol}</Text>
}

/* ------------------ 行拼装：右对齐靠手填空格（herdr 底块的形状） ------------------ */

function codePoints(s: string): number {
  let n = 0
  for (const _ of s) n += 1
  return n
}

function padEnd(s: string, w: number): string {
  const n = codePoints(s)
  return n >= w ? s : s + ' '.repeat(w - n)
}

/** 超宽标题截断加省略号，不让侧栏行折行。 */
function truncate(s: string, max: number): string {
  if (codePoints(s) <= max) return s
  return [...s].slice(0, Math.max(1, max - 1)).join('') + '…'
}

/** 左右两端对齐的一行（`new … menu` 的形状）。 */
function justify(left: string, right: string, w: number): string {
  const pad = Math.max(1, w - codePoints(left) - codePoints(right))
  return left + ' '.repeat(pad) + right
}

export function Sidebar({ state, activeSessionId, width, activeWorkspaceId, view }: SidebarProps): ReactElement {
  const cw = Math.max(8, width - 1) // 内容宽；最后一列留给内容区的竖线

  const list: ReactElement =
    view === 'spaces' ? (
      <>
        {state.workspaces.map((ws) => {
          const activeWs =
            activeWorkspaceId !== null && activeWorkspaceId !== undefined && String(ws.workspaceId) === activeWorkspaceId
          return (
            <Text key={String(ws.workspaceId)} {...(activeWs ? { bold: true, color: 'cyan' } : {})}>
              {` ${activeWs ? '●' : '·'} ${truncate(ws.title, cw - 4)}`}
            </Text>
          )
        })}
        {state.workspaces.length === 0 ? <Text dimColor> (无工作区)</Text> : null}
      </>
    ) : (
      <>
        {[...state.sessions.values()].map((s) => {
          const active = activeSessionId !== null && String(s.sessionId) === String(activeSessionId)
          return (
            <Box key={String(s.sessionId)} paddingLeft={1}>
              <StatusDot status={s.status} />
              <Text {...(active ? { bold: true } : {})}>{` ${truncate(sessionTitle(s), cw - 4)}`}</Text>
            </Box>
          )
        })}
        {state.sessions.size === 0 ? <Text dimColor> (无会话)</Text> : null}
      </>
    )

  return (
    <Box flexDirection="column" width={cw} height="100%">
      <Text bold>{` ${view === 'spaces' ? 'spaces' : 'agents'}`}</Text>
      <Text> </Text>
      {list}
      {/* 弹性空隙：把入口块压到底部 */}
      <Box flexGrow={1} minHeight={1} />
      <Text>{justify(' new', 'menu', cw)}</Text>
      <Text dimColor>{'─'.repeat(cw)}</Text>
      {/* agents 格是视图切换入口（prefix+a），当前就在 agents 视图时高亮 */}
      <Text {...(view === 'agents' ? { bold: true, color: 'cyan' } : {})}>{justify(' agents', '', cw)}</Text>
      <Text>{' '.repeat(cw)}</Text>
      <Text dimColor>{padEnd('', cw - 1) + '«'}</Text>
    </Box>
  )
}
