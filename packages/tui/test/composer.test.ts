import { test } from 'node:test'
import assert from 'node:assert/strict'
import './force-color.ts'
import { fg, flush, outputOf } from './helpers.ts'
import { theme } from '../lib/index.js'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { Composer, hintFor, insertText, setTerminalColumnsForTest } from '../lib/index.js'

test.before(() => {
  setTerminalColumnsForTest(60)
})

test('输入框不是框：左 ┃ 竖条 + 底 ▀ 横线 + 左下角 ╹，没有右边框/上边框/圆角', async (t) => {
  t.after(cleanup)
  const app = render(h(Composer, { onSubmit: () => {} }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('┃'), '应有左侧 ┃ 竖条')
  assert.ok(out.includes('╹'), '应有左下角 ╹')
  assert.ok(out.includes('▀▀'), '应有底部 ▀ 横线')
  assert.ok(!out.includes('╭') && !out.includes('╮') && !out.includes('╯') && !out.includes('╰'), '不应再有圆角框')
  assert.ok(!out.includes('│') || !out.includes('┤'), '不应有右边框')
  app.unmount()
})

test('空输入时显示占位提示（muted），模式与模型写在框内那行', async (t) => {
  t.after(cleanup)
  const app = render(
    h(Composer, { onSubmit: () => {}, preset: 'standard', model: 'deepseek-chat', provider: 'deepseek' }),
  )
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${fg(theme.textMuted)}Ask anything...`), '占位提示应 muted')
  assert.ok(out.includes('Standard'), '模式名应在输入框内')
  assert.ok(out.includes('deepseek-chat'), '模型名应在输入框内')
  assert.ok(out.includes('·'), '模式与模型之间用 · 分隔')
  app.unmount()
})

test('模式名用 primary 色（┃ 用 borderActive 色）', async (t) => {
  t.after(cleanup)
  const app = render(h(Composer, { onSubmit: () => {}, preset: 'standard', model: 'm' }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(fg(theme.primary)), '模式名 primary')
  assert.ok(out.includes(fg(theme.borderActive)), '竖条 borderActive')
  app.unmount()
})

test('快捷键提示行：enter send + shift+enter newline；working 时左侧 esc interrupt', async (t) => {
  t.after(cleanup)
  let interrupted = 0
  const app = render(
    h(Composer, {
      onSubmit: () => {},
      working: true,
      onInterrupt: () => interrupted++,
    }),
  )
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('enter '), '应有 enter send 提示')
  assert.ok(out.includes('send'), '应有 enter send 提示')
  assert.ok(out.includes('shift+enter '), '应有 shift+enter newline 提示')
  assert.ok(out.includes('newline'), '应有 shift+enter newline 提示')
  assert.ok(out.includes('esc '), 'working 时应有 esc interrupt')
  assert.ok(out.includes('interrupt'), 'working 时应有 esc interrupt')
  app.unmount()

  const app2 = render(h(Composer, { onSubmit: () => {} }))
  await flush()
  assert.ok(!(outputOf(app2)).includes('interrupt'), '非 working 不应有 interrupt 提示')
  app2.unmount()
})

test('键入回显，Enter 提交并清空', async (t) => {
  t.after(cleanup)
  const submitted: string[] = []
  const app = render(h(Composer, { onSubmit: (text) => submitted.push(text) }))
  await flush()
  app.stdin.write('hello world')
  await flush()
  assert.ok(outputOf(app).includes('hello world'))
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(submitted, ['hello world'])
  // 提交后清空，占位提示回来
  assert.ok((app.lastFrame() ?? '').includes('Ask anything'))
  app.unmount()
})

test('空白输入不提交', async (t) => {
  t.after(cleanup)
  const submitted: string[] = []
  const app = render(h(Composer, { onSubmit: (text) => submitted.push(text) }))
  await flush()
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(submitted, [])
  app.unmount()
})

test('多行：ctrl+j（\\n）插入换行，Enter 一次提交整段', async (t) => {
  t.after(cleanup)
  const submitted: string[] = []
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
  const submitted: string[] = []
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

test('working 时 esc 触发 onInterrupt', async (t) => {
  t.after(cleanup)
  let interrupted = 0
  const app = render(h(Composer, { onSubmit: () => {}, onInterrupt: () => interrupted++ }))
  await flush()
  app.stdin.write('\x1b')
  await flush()
  assert.equal(interrupted, 1)
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
  const submitted: string[] = []
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
