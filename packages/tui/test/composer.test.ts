import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DIM, flush, outputOf } from './helpers.ts'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { Composer, hintFor, insertText } from '../lib/index.js'

test('空输入时渲染 dim 占位提示，外框是唯一的 round 边框', async (t) => {
  t.after(cleanup)
  const app = render(h(Composer, { onSubmit: () => {}, placeholder: 'Say something' }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${DIM}`), '占位提示应 dim')
  assert.ok(out.includes('Say something'))
  assert.ok(out.includes('╭'), '应有 round 边框')
  assert.ok(out.includes('╯'), '应有 round 边框')
  app.unmount()
})

test('键入回显，Enter 提交并清空', async (t) => {
  t.after(cleanup)
  const submitted = []
  const app = render(h(Composer, { onSubmit: (text) => submitted.push(text) }))
  await flush()
  app.stdin.write('hello world')
  await flush()
  assert.ok(outputOf(app).includes('hello world'))
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(submitted, ['hello world'])
  // 提交后清空，占位提示回来
  assert.ok((app.lastFrame() ?? '').includes('Type a message'))
  app.unmount()
})

test('空白输入不提交', async (t) => {
  t.after(cleanup)
  const submitted = []
  const app = render(h(Composer, { onSubmit: (text) => submitted.push(text) }))
  await flush()
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(submitted, [])
  app.unmount()
})

test('多行：ctrl+j（\\n）插入换行，Enter 一次提交整段', async (t) => {
  t.after(cleanup)
  const submitted = []
  const app = render(h(Composer, { onSubmit: (text) => submitted.push(text) }))
  await flush()
  app.stdin.write('first')
  app.stdin.write('\n') // ctrl+j：ink 解析为 enter（非 return），走插入路径
  app.stdin.write('second')
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('first'))
  assert.ok(out.includes('second'))
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(submitted, ['first\nsecond'])
  app.unmount()
})

test('退格删除光标前一个字符', async (t) => {
  t.after(cleanup)
  const submitted = []
  const app = render(h(Composer, { onSubmit: (text) => submitted.push(text) }))
  await flush()
  app.stdin.write('abc')
  app.stdin.write('\x7f') // 终端 Backspace
  await flush()
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(submitted, ['ab'])
  app.unmount()
})

test('`/` 开头触发命令提示面板', async (t) => {
  t.after(cleanup)
  const app = render(h(Composer, { onSubmit: () => {} }))
  await flush()
  assert.ok(!outputOf(app).includes('/ commands'))
  app.stdin.write('/')
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('/ commands'), `应出现命令提示面板: ${JSON.stringify(out)}`)
  assert.ok(out.includes('no candidates wired yet'), '候选列表这一版是空面板')
  app.unmount()
})

test('`@` 触发引用提示面板', async (t) => {
  t.after(cleanup)
  const app = render(h(Composer, { onSubmit: () => {} }))
  await flush()
  app.stdin.write('please read @')
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('@ references'), `应出现引用提示面板: ${JSON.stringify(out)}`)
  app.unmount()
})

test('disabled 时不接受输入', async (t) => {
  t.after(cleanup)
  const submitted = []
  const app = render(h(Composer, { onSubmit: (text) => submitted.push(text), disabled: true }))
  await flush()
  app.stdin.write('nope')
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(submitted, [])
  assert.ok(!outputOf(app).includes('nope'))
  app.unmount()
})

test('hintFor / insertText 纯函数', () => {
  assert.equal(hintFor('/', 1), 'command')
  assert.equal(hintFor('/re', 3), 'command')
  assert.equal(hintFor('a @', 3), 'reference')
  assert.equal(hintFor('a @fi', 5), 'reference')
  assert.equal(hintFor('a file', 6), null)
  assert.equal(hintFor('', 0), null)
  assert.equal(hintFor('email a@b', 9), null) // token 不是以 @ 开头

  assert.deepEqual(insertText('ac', 1, 'b'), { text: 'abc', cursor: 2 })
  assert.deepEqual(insertText('ab', 2, '\ncd'), { text: 'ab\ncd', cursor: 5 })
})
