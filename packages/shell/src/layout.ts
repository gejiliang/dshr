/**
 * 布局树：纯数据结构 + 纯函数，**不 import ink / react**。
 * tab/pane 树、焦点、分割比例都在这里，React 组件只负责把它画出来。
 *
 * 坐标约定：x 向右、y 向下，单位是终端字符格。
 */

/** 分割方向：'v' = 左右并排（tmux `%`），'h' = 上下堆叠（tmux `"`）。 */
export type SplitDirection = 'v' | 'h'

/** 叶子：一个 pane 恰好对应一个 dsh session。 */
export interface PaneLeaf {
  readonly kind: 'pane'
  readonly paneId: string
  readonly sessionId: string | null
}

/** 内部节点：沿 direction 分割，第一子占 ratio 比例。 */
export interface SplitNode {
  readonly kind: 'split'
  readonly nodeId: string
  readonly direction: SplitDirection
  /** 第一子占可用尺寸的份额，0 < ratio < 1。 */
  readonly ratio: number
  readonly first: LayoutNode
  readonly second: LayoutNode
}

export type LayoutNode = PaneLeaf | SplitNode

export type FocusDirection = 'left' | 'right' | 'up' | 'down'

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/* ------------------------------------------------------------------ */
/* 构造                                                                */
/* ------------------------------------------------------------------ */

let counter = 0
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
}

/** 测试用：重置 id 计数器，让断言可写死。 */
export function resetLayoutIds(): void {
  counter = 0
}

export function createPane(sessionId: string | null = null): PaneLeaf {
  return { kind: 'pane', paneId: nextId('pane'), sessionId }
}

export function createSplit(
  direction: SplitDirection,
  first: LayoutNode,
  second: LayoutNode,
  ratio = 0.5,
): SplitNode {
  return { kind: 'split', nodeId: nextId('split'), direction, ratio, first, second }
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export function findPane(root: LayoutNode, paneId: string): PaneLeaf | null {
  if (root.kind === 'pane') return root.paneId === paneId ? root : null
  return findPane(root.first, paneId) ?? findPane(root.second, paneId)
}

/** 先序遍历，与视觉上的阅读顺序一致。 */
export function paneIds(root: LayoutNode): string[] {
  if (root.kind === 'pane') return [root.paneId]
  return [...paneIds(root.first), ...paneIds(root.second)]
}

export function paneCount(root: LayoutNode): number {
  return paneIds(root).length
}

/* ------------------------------------------------------------------ */
/* 变换（全部返回新树，不改原树）                                       */
/* ------------------------------------------------------------------ */

/**
 * 把 target pane 沿 direction 一分为二，新 pane 放在它之后（右 / 下）。
 * target 不存在时原样返回。
 */
export function splitPane(root: LayoutNode, targetId: string, direction: SplitDirection, ratio = 0.5): LayoutNode {
  const fresh = createPane()
  const wrap = (node: LayoutNode): LayoutNode =>
    createSplit(direction, node, fresh, clampRatio(ratio))
  const [next, done] = mapPane(root, targetId, wrap)
  return done ? next : root
}

/** 替换某个 pane 绑定的会话。 */
export function setPaneSession(root: LayoutNode, paneId: string, sessionId: string | null): LayoutNode {
  const [next, done] = mapPane(root, paneId, (p) => ({ ...p, sessionId }))
  return done ? next : root
}

export interface CloseResult {
  /** pane 是树里唯一一片时 root 为 null。 */
  readonly root: LayoutNode | null
  /** 被关 pane 的 sessionId，调用方据此决定要不要 cancel 会话。 */
  readonly closedSessionId: string | null
  readonly found: boolean
}

/** 关闭 pane：父 split 坍缩成剩下的那个孩子；关最后一片时整棵树为空。 */
export function closePane(root: LayoutNode, paneId: string): CloseResult {
  if (root.kind === 'pane') {
    return root.paneId === paneId
      ? { root: null, closedSessionId: root.sessionId, found: true }
      : { root, closedSessionId: null, found: false }
  }
  const a = closePane(root.first, paneId)
  if (a.found) {
    return { root: a.root === null ? root.second : { ...root, first: a.root }, closedSessionId: a.closedSessionId, found: true }
  }
  const b = closePane(root.second, paneId)
  if (b.found) {
    return { root: b.root === null ? root.first : { ...root, second: b.root }, closedSessionId: b.closedSessionId, found: true }
  }
  return { root, closedSessionId: null, found: false }
}

/** 调整包含 paneId 的最近一级 split 的 ratio（+delta 朝 first 一侧）。 */
export function resizePane(root: LayoutNode, paneId: string, delta: number): LayoutNode {
  if (root.kind === 'pane') return root
  if (containsPane(root.first, paneId)) {
    return { ...root, ratio: clampRatio(root.ratio + delta), first: resizePane(root.first, paneId, delta) }
  }
  if (containsPane(root.second, paneId)) {
    return { ...root, ratio: clampRatio(root.ratio - delta), second: resizePane(root.second, paneId, delta) }
  }
  return root
}

/* ------------------------------------------------------------------ */
/* 焦点                                                                */
/* ------------------------------------------------------------------ */

/** 按先序（视觉顺序）循环移动焦点。 */
export function focusNext(root: LayoutNode, currentId: string): string {
  return cycle(root, currentId, 1)
}

export function focusPrev(root: LayoutNode, currentId: string): string {
  return cycle(root, currentId, -1)
}

/**
 * 方向焦点：给定终端矩形，找 current 在 dir 方向上「中心点最先撞上」的 pane。
 * 找不到（已在边缘）时保持不动。
 */
export function focusDirection(root: LayoutNode, currentId: string, dir: FocusDirection, area: Rect): string {
  const rects = computeRects(root, area)
  const cur = rects.get(currentId)
  if (!cur) return currentId
  const cx = cur.x + cur.width / 2
  const cy = cur.y + cur.height / 2
  const horizontal = dir === 'left' || dir === 'right'
  let best: string | null = null
  let bestScore = Number.POSITIVE_INFINITY
  let bestOverlap: string | null = null
  let bestOverlapScore = Number.POSITIVE_INFINITY
  for (const [id, r] of rects) {
    if (id === currentId) continue
    const tx = r.x + r.width / 2
    const ty = r.y + r.height / 2
    const dx = tx - cx
    const dy = ty - cy
    const forward =
      dir === 'left' ? dx < 0 : dir === 'right' ? dx > 0 : dir === 'up' ? dy < 0 : dy > 0
    if (!forward) continue
    const primary = horizontal ? Math.abs(dx) : Math.abs(dy)
    const secondary = horizontal ? Math.abs(dy) : Math.abs(dx)
    // 垂直轴有投影重叠的候选永远优先（同列 / 同行），没有重叠才退到最近质心
    const overlap = horizontal
      ? r.y < cur.y + cur.height && cur.y < r.y + r.height
      : r.x < cur.x + cur.width && cur.x < r.x + r.width
    if (overlap) {
      if (primary < bestOverlapScore) {
        bestOverlapScore = primary
        bestOverlap = id
      }
    } else {
      const score = primary * 1000 + secondary
      if (score < bestScore) {
        bestScore = score
        best = id
      }
    }
  }
  return bestOverlap ?? best ?? currentId
}

/* ------------------------------------------------------------------ */
/* 几何：把树折算成每个 pane 的矩形                                     */
/* ------------------------------------------------------------------ */

export function computeRects(root: LayoutNode, area: Rect): Map<string, Rect> {
  const out = new Map<string, Rect>()
  walk(root, area, out)
  return out
}

function walk(node: LayoutNode, r: Rect, out: Map<string, Rect>): void {
  if (node.kind === 'pane') {
    out.set(node.paneId, r)
    return
  }
  if (node.direction === 'v') {
    const w1 = Math.max(1, Math.round(r.width * node.ratio))
    const w2 = Math.max(0, r.width - w1)
    walk(node.first, { x: r.x, y: r.y, width: w1, height: r.height }, out)
    walk(node.second, { x: r.x + w1, y: r.y, width: w2, height: r.height }, out)
  } else {
    const h1 = Math.max(1, Math.round(r.height * node.ratio))
    const h2 = Math.max(0, r.height - h1)
    walk(node.first, { x: r.x, y: r.y, width: r.width, height: h1 }, out)
    walk(node.second, { x: r.x, y: r.y + h1, width: r.width, height: h2 }, out)
  }
}

/* ------------------------------------------------------------------ */
/* 内部                                                                */
/* ------------------------------------------------------------------ */

function clampRatio(r: number): number {
  return Math.min(0.9, Math.max(0.1, r))
}

function containsPane(node: LayoutNode, paneId: string): boolean {
  if (node.kind === 'pane') return node.paneId === paneId
  return containsPane(node.first, paneId) || containsPane(node.second, paneId)
}

/** 对某个 pane 应用变换。返回 [新树, 是否命中]。 */
function mapPane(
  node: LayoutNode,
  paneId: string,
  fn: (pane: PaneLeaf) => LayoutNode,
): [LayoutNode, boolean] {
  if (node.kind === 'pane') {
    return node.paneId === paneId ? [fn(node), true] : [node, false]
  }
  const [first, hitFirst] = mapPane(node.first, paneId, fn)
  if (hitFirst) return [{ ...node, first }, true]
  const [second, hitSecond] = mapPane(node.second, paneId, fn)
  if (hitSecond) return [{ ...node, second }, true]
  return [node, false]
}

function cycle(root: LayoutNode, currentId: string, step: 1 | -1): string {
  const ids = paneIds(root)
  if (ids.length === 0) return currentId
  const idx = ids.indexOf(currentId)
  const base = idx === -1 ? 0 : idx
  const next = ids[(base + step + ids.length) % ids.length]
  return next ?? currentId
}
