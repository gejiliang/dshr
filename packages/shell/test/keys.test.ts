import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_KEY_TABLE, KeyDispatcher } from '../lib/keys.js'
import type { KeyStroke } from '../lib/keys.js'

const PREFIX: KeyStroke = { input: 'b', ctrl: true }

test('前缀键被消费，不透传', () => {
  const d = new KeyDispatcher()
  const r = d.dispatch(PREFIX)
  assert.equal(r.kind, 'consumed')
  assert.equal(d.awaitingPrefixFollowUp, true)
})

test('Ctrl-B c → newTab；n/p → 切 tab；%/" → 分割；x → 关 pane；s → 侧栏', () => {
  const cases: Array<[string, string]> = [
    ['c', 'newTab'],
    ['n', 'nextTab'],
    ['p', 'prevTab'],
    ['%', 'splitVertical'],
    ['"', 'splitHorizontal'],
    ['x', 'closePane'],
    ['s', 'toggleSidebar'],
  ]
  for (const [input, type] of cases) {
    const d = new KeyDispatcher()
    d.dispatch(PREFIX)
    const r = d.dispatch({ input })
    assert.equal(r.kind, 'action', input)
    if (r.kind === 'action') assert.equal(r.action.type, type)
  }
})

test('Ctrl-B w / W -> 工作区选择 / 新建工作区', () => {
  for (const [input, type] of [['w', 'selectWorkspace'], ['W', 'newWorkspace']] as Array<[string, string]>) {
    const d = new KeyDispatcher()
    d.dispatch(PREFIX)
    const r = d.dispatch({ input })
    assert.equal(r.kind, 'action', input)
    if (r.kind === 'action') assert.equal(r.action.type, type)
  }
  // 大小写是两个不同的键
  assert.notEqual(DEFAULT_KEY_TABLE.bindings['w'], DEFAULT_KEY_TABLE.bindings['W'])
})

test('前缀 + 方向键 → focusPane', () => {
  const d = new KeyDispatcher()
  d.dispatch(PREFIX)
  const r = d.dispatch({ input: '', leftArrow: true })
  assert.equal(r.kind, 'action')
  if (r.kind === 'action' && r.action.type === 'focusPane') {
    assert.equal(r.action.direction, 'left')
  } else {
    assert.fail('expected focusPane')
  }
})

test('非前缀按键透传给会话输入框', () => {
  const d = new KeyDispatcher()
  for (const stroke of [
    { input: 'a' },
    { input: 'x' }, // 裸 x 不是关 pane
    { input: 'b' }, // 不带 ctrl 不是前缀
    { input: '', upArrow: true }, // 裸方向键也透传
  ]) {
    const r = d.dispatch(stroke)
    assert.equal(r.kind, 'passthrough', JSON.stringify(stroke))
    if (r.kind === 'passthrough') assert.deepEqual(r.stroke, stroke)
  }
})

test('前缀序列完成后回到 idle：后续按键照常透传', () => {
  const d = new KeyDispatcher()
  d.dispatch(PREFIX)
  d.dispatch({ input: 'c' }) // newTab
  const r = d.dispatch({ input: 'c' })
  assert.equal(r.kind, 'passthrough')
})

test('前缀后接不认识的键：消费掉，不透传，状态回 idle', () => {
  const d = new KeyDispatcher()
  d.dispatch(PREFIX)
  const r = d.dispatch({ input: 'z' })
  assert.equal(r.kind, 'consumed')
  assert.equal(d.awaitingPrefixFollowUp, false)
  assert.equal(d.dispatch({ input: 'z' }).kind, 'passthrough')
})

test('连着两个前缀键：第二个被视为前缀后的普通键而消费', () => {
  const d = new KeyDispatcher()
  d.dispatch(PREFIX)
  const r = d.dispatch(PREFIX)
  assert.equal(r.kind, 'consumed')
  assert.equal(d.awaitingPrefixFollowUp, false)
})

test('键表是数据：换一张表即换键位', () => {
  const d = new KeyDispatcher({
    prefix: { input: 'a', ctrl: true },
    bindings: { t: { type: 'newTab' } },
  })
  // 默认表的 Ctrl-B 在新表里只是普通按键
  assert.equal(d.dispatch({ input: 'b', ctrl: true }).kind, 'passthrough')
  d.dispatch({ input: 'a', ctrl: true })
  const r = d.dispatch({ input: 't' })
  assert.equal(r.kind, 'action')
  assert.equal(DEFAULT_KEY_TABLE.prefix.input, 'b') // 默认表没被污染
})
