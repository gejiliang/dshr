/**
 * 覆盖层纯状态机测试：不碰 ink，直接喂 OverlayKeyStroke / Input。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  emptyTextInput,
  inputKey,
  openWorkspacePicker,
  pickerInputFromKey,
  pickerKey,
  textInputFromKey,
  type WorkspacePickerEntry,
} from '../lib/overlay.js'

const ENTRIES: readonly WorkspacePickerEntry[] = [
  { id: 'ws-1', title: 'alpha', path: '/tmp/alpha' },
  { id: 'ws-2', title: 'beta', path: '/tmp/beta' },
  { id: 'ws-3', title: 'gamma', path: '/tmp/gamma' },
]

test('选择器：上下键循环移动高亮', () => {
  const m = openWorkspacePicker(ENTRIES)
  assert.equal(m.index, 0)
  const down = pickerKey(m, { kind: 'down' })
  assert.ok(down.kind === 'open' && down.model.index === 1)
  const wrap = pickerKey(
    down.kind === 'open' ? down.model : m,
    { kind: 'down' },
  )
  assert.ok(wrap.kind === 'open' && wrap.model.index === 2)
  const up = pickerKey(m, { kind: 'up' })
  assert.ok(up.kind === 'open' && up.model.index === 2, '从第一项往上绕到最后一项')
})

test('选择器：数字键移动高亮，enter 确认，esc 取消', () => {
  const m = openWorkspacePicker(ENTRIES)
  const to2 = pickerKey(m, { kind: 'digit', digit: 2 })
  assert.ok(to2.kind === 'open' && to2.model.index === 1)
  const confirmed = pickerKey(to2.kind === 'open' ? to2.model : m, { kind: 'confirm' })
  assert.deepEqual(confirmed, { kind: 'confirmed', workspaceId: 'ws-2' })
  assert.deepEqual(pickerKey(m, { kind: 'cancel' }), { kind: 'cancelled' })
})

test('选择器：超出范围的数字与空列表的确认都保持原样', () => {
  const m = openWorkspacePicker(ENTRIES)
  assert.deepEqual(pickerKey(m, { kind: 'digit', digit: 9 }), { kind: 'open', model: m })
  const empty = openWorkspacePicker([])
  assert.deepEqual(pickerKey(empty, { kind: 'confirm' }), { kind: 'open', model: empty })
  assert.deepEqual(pickerKey(empty, { kind: 'down' }), { kind: 'open', model: empty })
  assert.deepEqual(pickerKey(empty, { kind: 'cancel' }), { kind: 'cancelled' })
})

test('OverlayKeyStroke -> PickerInput 的边界折算', () => {
  assert.deepEqual(pickerInputFromKey({ input: '\x1b', escape: true }), { kind: 'cancel' })
  assert.deepEqual(pickerInputFromKey({ input: '\r', returnKey: true }), { kind: 'confirm' })
  assert.deepEqual(pickerInputFromKey({ input: '', upArrow: true }), { kind: 'up' })
  assert.deepEqual(pickerInputFromKey({ input: '3' }), { kind: 'digit', digit: 3 })
  assert.equal(pickerInputFromKey({ input: 'w' }), null)
  assert.equal(pickerInputFromKey({ input: '0' }), null)
  assert.equal(pickerInputFromKey({ input: '\x02' }), null, '控制码不是数字')
})

test('文本输入：char / backspace / confirm / cancel', () => {
  const m = emptyTextInput()
  const a = inputKey(m, { kind: 'char', ch: '/' })
  const b = inputKey(a.kind === 'open' ? a.model : m, { kind: 'char', ch: 'tmp' })
  assert.ok(b.kind === 'open' && b.model.value === '/tmp')
  const c = inputKey(b.kind === 'open' ? b.model : m, { kind: 'char', ch: 'x' })
  const d = inputKey(c.kind === 'open' ? c.model : m, { kind: 'backspace' })
  assert.ok(d.kind === 'open' && d.model.value === '/tmp')
  const s = inputKey(d.kind === 'open' ? d.model : m, { kind: 'confirm' })
  assert.deepEqual(s, { kind: 'submitted', value: '/tmp' })
  assert.deepEqual(inputKey(m, { kind: 'cancel' }), { kind: 'cancelled' })
  // 空串也能 submit，由调用方决定忽略（Shell 里空路径不提交）
  assert.deepEqual(inputKey(m, { kind: 'confirm' }), { kind: 'submitted', value: '' })
})

test('文本输入：控制字符不进输入框，可打印 unicode 可以', () => {
  assert.equal(textInputFromKey({ input: '\x02' }), null)
  assert.deepEqual(textInputFromKey({ input: '', backspace: true }), { kind: 'backspace' })
  assert.deepEqual(textInputFromKey({ input: '路' }), { kind: 'char', ch: '路' })
  assert.deepEqual(textInputFromKey({ input: '\r', returnKey: true }), { kind: 'confirm' })
  assert.deepEqual(textInputFromKey({ input: '', escape: true }), { kind: 'cancel' })
  assert.deepEqual(textInputFromKey({ input: '\x7f' }), null) // 裸 DEL 不是可打印字符
})
