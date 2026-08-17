import { test } from 'node:test'
import assert from 'node:assert/strict'
import './force-color.ts'
import { bg, flush, outputOf } from './helpers.ts'
import { theme } from '../lib/index.js'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { DialogPrompt } from '../lib/index.js'

const NOP = { onSubmit: () => {}, onCancel: () => {} }

test('渲染：标题行 + esc、backgroundPanel 输入行、enter confirm 提示', async (t) => {
  t.after(cleanup)
  const app = render(h(DialogPrompt, { title: 'Rename session', ...NOP }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('Rename session'), '应有标题')
  assert.ok(out.includes('esc'), '标题行右侧应有 esc')
  assert.ok(out.includes(bg(theme.backgroundPanel)), '输入行应有 backgroundPanel 底色')
  assert.ok(out.includes('enter confirm'), '应有确认提示')
  app.unmount()
})

test('初始文本显示出来，光标在末尾', async (t) => {
  t.after(cleanup)
  const app = render(h(DialogPrompt, { title: 'Rename session', initial: 'old title', ...NOP }))
  await flush()
  assert.ok(outputOf(app).includes('old title'), '应显示初始文本')
  app.unmount()
})

test('输入字符 + enter 提交（trim）；空文本 enter 不提交', async (t) => {
  t.after(cleanup)
  const submitted: string[] = []
  const app = render(
    h(DialogPrompt, { title: 'Rename session', onSubmit: (v) => submitted.push(v), onCancel: () => {} }),
  )
  await flush()
  app.stdin.write('\r') // 空文本：不提交
  await flush()
  assert.deepEqual(submitted, [], '空文本不应提交')
  app.stdin.write('  new name  ')
  await flush()
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(submitted, ['new name'], 'enter 应提交 trim 后的文本')
  app.unmount()
})

test('esc 取消', async (t) => {
  t.after(cleanup)
  let cancelled = 0
  const app = render(
    h(DialogPrompt, { title: 'Rename session', onSubmit: () => {}, onCancel: () => cancelled++ }),
  )
  await flush()
  app.stdin.write('\x1b')
  await flush()
  assert.strictEqual(cancelled, 1)
  app.unmount()
})

test('backspace 删光标前一个字符', async (t) => {
  t.after(cleanup)
  const submitted: string[] = []
  const app = render(
    h(DialogPrompt, { title: 'R', onSubmit: (v) => submitted.push(v), onCancel: () => {} }),
  )
  await flush()
  app.stdin.write('abc')
  await flush()
  app.stdin.write('\x7f')
  await flush()
  assert.ok(outputOf(app).includes('ab'), 'backspace 应删掉最后一个字符')
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(submitted, ['ab'])
  app.unmount()
})

test('左右方向键移动光标，在中间插入', async (t) => {
  t.after(cleanup)
  const submitted: string[] = []
  const app = render(
    h(DialogPrompt, { title: 'R', onSubmit: (v) => submitted.push(v), onCancel: () => {} }),
  )
  await flush()
  app.stdin.write('ac')
  await flush()
  app.stdin.write('\x1b[D') // left：光标到 a|c 之间
  await flush()
  app.stdin.write('b')
  await flush()
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(submitted, ['abc'], '应在光标处插入')
  app.unmount()
})
