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

test('herdr 键位：c/n/p tab，v/- 分割，x 关，b 侧栏，z zoom，a agents，? 帮助', () => {
  const cases: Array<[string, string]> = [
    ['c', 'newTab'],
    ['n', 'nextTab'],
    ['p', 'prevTab'],
    ['v', 'splitVertical'],
    ['-', 'splitHorizontal'],
    ['x', 'closePane'],
    ['b', 'toggleSidebar'],
    ['z', 'toggleZoom'],
    ['a', 'sidebarAgentsView'],
    ['?', 'showHelp'],
  ]
  for (const [input, type] of cases) {
    const d = new KeyDispatcher()
    d.dispatch(PREFIX)
    const r = d.dispatch({ input })
    assert.equal(r.kind, 'action', input)
    if (r.kind === 'action') assert.equal(r.action.type, type)
  }
})

test('prefix+1..9 按序号切 tab', () => {
  for (const digit of ['1', '5', '9']) {
    const d = new KeyDispatcher()
    d.dispatch(PREFIX)
    const r = d.dispatch({ input: digit })
    assert.equal(r.kind, 'action', digit)
    if (r.kind === 'action' && r.action.type === 'selectTab') {
      assert.equal(r.action.index, Number(digit))
    } else {
      assert.fail(`expected selectTab for ${digit}`)
    }
  }
})

test('Ctrl-B w / N -> 工作区选择 / 新建工作区；W 不再绑定', () => {
  for (const [input, type] of [['w', 'selectWorkspace'], ['N', 'newWorkspace']] as Array<[string, string]>) {
    const d = new KeyDispatcher()
    d.dispatch(PREFIX)
    const r = d.dispatch({ input })
    assert.equal(r.kind, 'action', input)
    if (r.kind === 'action') assert.equal(r.action.type, type)
  }
  assert.equal(DEFAULT_KEY_TABLE.bindings['W'], undefined, 'W（旧的新建工作区）必须解绑')
})

test('prefix+s 留空不绑（herdr 那是设置，本版没有--肌肉记忆不许踩空）', () => {
  assert.equal(DEFAULT_KEY_TABLE.bindings['s'], undefined)
  const d = new KeyDispatcher()
  d.dispatch(PREFIX)
  const r = d.dispatch({ input: 's' })
  assert.equal(r.kind, 'consumed', 's 被消费但不触发任何动作')
  assert.equal(d.awaitingPrefixFollowUp, false)
})

test('前缀 + h/j/k/l -> focusPane（vim 方向）', () => {
  const cases: Array<[string, string]> = [
    ['h', 'left'],
    ['j', 'down'],
    ['k', 'up'],
    ['l', 'right'],
  ]
  for (const [input, direction] of cases) {
    const d = new KeyDispatcher()
    d.dispatch(PREFIX)
    const r = d.dispatch({ input })
    assert.equal(r.kind, 'action', input)
    if (r.kind === 'action' && r.action.type === 'focusPane') {
      assert.equal(r.action.direction, direction)
    } else {
      assert.fail(`expected focusPane for ${input}`)
    }
  }
})

test('前缀 + 方向键仍是 focusPane（hjkl 之外的额外绑定）', () => {
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
    { input: 'h' }, // 裸 h 是给会话的
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
  const r = d.dispatch({ input: 'y' })
  assert.equal(r.kind, 'consumed')
  assert.equal(d.awaitingPrefixFollowUp, false)
  assert.equal(d.dispatch({ input: 'y' }).kind, 'passthrough')
})

test('连着两个前缀键：第二个被当作前缀后的 b（开关侧栏）', () => {
  const d = new KeyDispatcher()
  d.dispatch(PREFIX)
  const r = d.dispatch(PREFIX)
  assert.equal(r.kind, 'action')
  if (r.kind === 'action') assert.equal(r.action.type, 'toggleSidebar')
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
