import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  closePane,
  computeRects,
  createPane,
  focusDirection,
  focusNext,
  focusPrev,
  paneCount,
  paneIds,
  resetLayoutIds,
  resizePane,
  setPaneSession,
  splitPane,
} from '../lib/layout.js'
import { adjacentTabId, closeTabPane, createTab, resetTabIds } from '../lib/tabs.js'

test('createPane 产生带唯一 id 的叶子', () => {
  resetLayoutIds()
  const p = createPane('sess-1')
  assert.equal(p.kind, 'pane')
  assert.equal(p.sessionId, 'sess-1')
  assert.equal(p.paneId, 'pane-1')
})

test('splitPane 竖分：原 pane 在左，新 pane 在右，各占一半', () => {
  resetLayoutIds()
  const p = createPane()
  const tree = splitPane(p, p.paneId, 'v')
  assert.equal(tree.kind, 'split')
  if (tree.kind !== 'split') return
  assert.equal(tree.direction, 'v')
  assert.equal(tree.ratio, 0.5)
  const ids = paneIds(tree)
  assert.equal(ids.length, 2)
  assert.equal(ids[0], p.paneId)
  assert.notEqual(ids[1], p.paneId)
})

test('splitPane 嵌套：第二次分割只影响目标 pane', () => {
  resetLayoutIds()
  const p = createPane()
  let tree = splitPane(p, p.paneId, 'v')
  const right = paneIds(tree)[1]
  assert.ok(right)
  tree = splitPane(tree, right, 'h')
  assert.equal(paneCount(tree), 3)
  // 左 pane 未被动
  const ids = paneIds(tree)
  assert.equal(ids[0], p.paneId)
  if (tree.kind === 'split') {
    assert.equal(tree.second.kind, 'split')
    if (tree.second.kind === 'split') assert.equal(tree.second.direction, 'h')
  }
})

test('splitPane 目标不存在时原样返回', () => {
  resetLayoutIds()
  const p = createPane()
  const tree = splitPane(p, 'nope', 'v')
  assert.equal(tree, p)
})

test('splitPane ratio 被钳制在 (0.1, 0.9)', () => {
  resetLayoutIds()
  const p = createPane()
  const tree = splitPane(p, p.paneId, 'v', 0.01)
  if (tree.kind === 'split') assert.equal(tree.ratio, 0.1)
  const tree2 = splitPane(p, p.paneId, 'v', 0.99)
  if (tree2.kind === 'split') assert.equal(tree2.ratio, 0.9)
})

test('closePane 中间 pane：父 split 坍缩成剩下的孩子', () => {
  resetLayoutIds()
  const p = createPane('s1')
  let tree = splitPane(p, p.paneId, 'v')
  const right = paneIds(tree)[1]
  assert.ok(right)
  tree = setPaneSession(tree, right, 's2')
  const r = closePane(tree, right)
  assert.equal(r.found, true)
  assert.equal(r.closedSessionId, 's2')
  assert.ok(r.root)
  assert.equal(r.root?.kind, 'pane')
  assert.equal(paneIds(r.root)[0], p.paneId)
})

test('closePane 最后一个 pane：整棵树为 null', () => {
  resetLayoutIds()
  const p = createPane('s1')
  const r = closePane(p, p.paneId)
  assert.equal(r.root, null)
  assert.equal(r.closedSessionId, 's1')
  assert.equal(r.found, true)
})

test('closePane 深层 pane：只坍缩它所在的那一级', () => {
  resetLayoutIds()
  const p = createPane()
  let tree = splitPane(p, p.paneId, 'v')
  const right = paneIds(tree)[1]
  assert.ok(right)
  tree = splitPane(tree, right, 'h')
  const bottomRight = paneIds(tree)[2]
  assert.ok(bottomRight)
  const r = closePane(tree, bottomRight)
  assert.ok(r.root)
  assert.equal(paneCount(r.root), 2)
  // 顶层 split 仍在，右侧变回单片
  if (r.root?.kind === 'split') assert.equal(r.root.second.kind, 'pane')
})

test('closePane 不存在的 pane：found=false，树不变', () => {
  resetLayoutIds()
  const p = createPane()
  const tree = splitPane(p, p.paneId, 'v')
  const r = closePane(tree, 'ghost')
  assert.equal(r.found, false)
  assert.equal(r.root, tree)
})

test('focusNext / focusPrev 按视觉顺序循环', () => {
  resetLayoutIds()
  const p = createPane()
  let tree = splitPane(p, p.paneId, 'v')
  const second = paneIds(tree)[1]
  assert.ok(second)
  tree = splitPane(tree, second, 'h')
  const [a, b, c] = paneIds(tree)
  assert.ok(a && b && c)
  assert.equal(focusNext(tree, a), b)
  assert.equal(focusNext(tree, c), a) // 环绕
  assert.equal(focusPrev(tree, a), c) // 反向环绕
  // 单片时原地不动
  assert.equal(focusNext(p, p.paneId), p.paneId)
})

test('computeRects 竖分：左右矩形铺满宽度', () => {
  resetLayoutIds()
  const p = createPane()
  const tree = splitPane(p, p.paneId, 'v')
  const rects = computeRects(tree, { x: 0, y: 0, width: 100, height: 30 })
  const [left, right] = paneIds(tree)
  const lr = rects.get(left ?? '')
  const rr = rects.get(right ?? '')
  assert.ok(lr && rr)
  assert.equal(lr.width, 50)
  assert.equal(rr.x, 50)
  assert.equal(rr.width, 50)
  assert.equal(lr.height, 30)
})

test('computeRects 嵌套：右侧上下堆叠', () => {
  resetLayoutIds()
  const p = createPane()
  let tree = splitPane(p, p.paneId, 'v')
  const right = paneIds(tree)[1]
  assert.ok(right)
  tree = splitPane(tree, right, 'h')
  const rects = computeRects(tree, { x: 0, y: 0, width: 80, height: 20 })
  const ids = paneIds(tree)
  const top = rects.get(ids[1] ?? '')
  const bottom = rects.get(ids[2] ?? '')
  assert.ok(top && bottom)
  assert.equal(top.height, 10)
  assert.equal(bottom.y, 10)
  assert.equal(top.x, 40)
})

test('computeRects 奇数宽度：两片加起来恰好铺满，不留缝不重叠', () => {
  resetLayoutIds()
  const p = createPane()
  const tree = splitPane(p, p.paneId, 'v')
  for (const w of [1, 3, 7, 99]) {
    const rects = computeRects(tree, { x: 0, y: 0, width: w, height: 10 })
    const ids = paneIds(tree)
    const a = rects.get(ids[0] ?? '')
    const b = rects.get(ids[1] ?? '')
    assert.ok(a && b)
    assert.equal(a.width + b.width, w)
    assert.equal(b.x, a.width)
  }
})

test('focusDirection 右移：跨过竖分边界', () => {
  resetLayoutIds()
  const p = createPane()
  const tree = splitPane(p, p.paneId, 'v')
  const [left, right] = paneIds(tree)
  const area = { x: 0, y: 0, width: 100, height: 30 }
  assert.equal(focusDirection(tree, left ?? '', 'right', area), right)
  assert.equal(focusDirection(tree, right ?? '', 'left', area), left)
})

test('focusDirection 已在边缘时保持不动', () => {
  resetLayoutIds()
  const p = createPane()
  const tree = splitPane(p, p.paneId, 'v')
  const [left] = paneIds(tree)
  const area = { x: 0, y: 0, width: 100, height: 30 }
  assert.equal(focusDirection(tree, left ?? '', 'left', area), left)
})

test('focusDirection 上下：右侧堆叠的两片互达', () => {
  resetLayoutIds()
  const p = createPane()
  let tree = splitPane(p, p.paneId, 'v')
  const right = paneIds(tree)[1]
  assert.ok(right)
  tree = splitPane(tree, right, 'h')
  const ids = paneIds(tree)
  const area = { x: 0, y: 0, width: 80, height: 20 }
  assert.equal(focusDirection(tree, ids[1] ?? '', 'down', area), ids[2])
  assert.equal(focusDirection(tree, ids[2] ?? '', 'up', area), ids[1])
})

test('resizePane 调整包含焦点的最近一级 split', () => {
  resetLayoutIds()
  const p = createPane()
  const tree = splitPane(p, p.paneId, 'v')
  const [left] = paneIds(tree)
  const grown = resizePane(tree, left ?? '', 0.1)
  if (grown.kind === 'split') assert.ok(Math.abs(grown.ratio - 0.6) < 1e-9)
  // 原树不可变
  if (tree.kind === 'split') assert.equal(tree.ratio, 0.5)
})

test('resizePane 嵌套：只动直接父 split，祖先 ratio 不变', () => {
  resetLayoutIds()
  // Split(A, 0.5)
  //   first:  Pane(X)
  //   second: Split(B, 0.5)
  //             first:  Pane(Y)
  //             second: Pane(Z)
  const x = createPane()
  let root = splitPane(x, x.paneId, 'v')
  const y = paneIds(root)[1]
  assert.ok(y)
  root = splitPane(root, y, 'h')
  assert.equal(paneCount(root), 3)

  const resized = resizePane(root, y, 0.1)
  if (resized.kind !== 'split') return assert.fail('顶层仍是 split')
  assert.equal(resized.ratio, 0.5, '外层 A.ratio 不变')
  if (resized.second.kind !== 'split') return assert.fail('右侧仍是 split')
  assert.ok(Math.abs(resized.second.ratio - 0.6) < 1e-9, '内层 B.ratio 0.5 → 0.6')
  // 原树不可变
  if (root.kind === 'split' && root.second.kind === 'split') {
    assert.equal(root.ratio, 0.5)
    assert.equal(root.second.ratio, 0.5)
  }
})

/* ------------------------------ tabs ------------------------------ */

test('createTab 自带一个 pane 且聚焦', () => {
  resetTabIds()
  const t = createTab('ws-1')
  assert.equal(t.workspaceId, 'ws-1')
  assert.ok(t.root)
  assert.ok(t.focusedPaneId)
  assert.equal(paneIds(t.root)[0], t.focusedPaneId)
})

test('closeTabPane 焦点跟随：关掉聚焦 pane 时焦点落到剩下的第一片', () => {
  resetTabIds()
  let t = createTab('ws-1')
  assert.ok(t.root && t.focusedPaneId)
  const tree = splitPane(t.root, t.focusedPaneId, 'v')
  const second = paneIds(tree)[1]
  assert.ok(second)
  t = { ...t, root: tree, focusedPaneId: second }
  const r = closeTabPane(t, second)
  assert.equal(r.found, true)
  assert.equal(r.tab.focusedPaneId, paneIds(r.tab.root ?? createPane())[0])
})

test('closeTabPane 关最后一片：tab 变空而非消失', () => {
  resetTabIds()
  const t = createTab('ws-1')
  const paneId = t.focusedPaneId ?? ''
  const r = closeTabPane(t, paneId)
  assert.equal(r.tab.root, null)
  assert.equal(r.tab.focusedPaneId, null)
  assert.equal(r.tab.tabId, t.tabId)
})

test('adjacentTabId 循环且空表安全', () => {
  resetTabIds()
  const a = createTab('ws')
  const b = createTab('ws')
  assert.equal(adjacentTabId([a, b], a.tabId, 1), b.tabId)
  assert.equal(adjacentTabId([a, b], a.tabId, -1), b.tabId)
  assert.equal(adjacentTabId([], a.tabId, 1), null)
})
