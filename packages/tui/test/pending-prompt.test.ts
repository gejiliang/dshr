import { test } from 'node:test'
import assert from 'node:assert/strict'
import './force-color.ts'
import { flush, makeApproval, makeQuestion, outputOf } from './helpers.ts'
import { theme } from '../lib/index.js'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { PendingPrompt } from '../lib/index.js'

const fg = (hex: string): string => {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `\x1b[38;2;${r};${g};${b}m`
}

test('approval：△ 头行 + warning 竖条 + 工具名与原因，选项是 chip 行', async (t) => {
  t.after(cleanup)
  const pending = makeApproval({ toolName: 'bash', reason: 'wants to run: rm -rf build' })
  const app = render(h(PendingPrompt, { pending, onApprove: () => {} }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('bash'), '应列出工具名')
  assert.ok(out.includes('wants to run: rm -rf build'), '应列出原因')
  assert.ok(out.includes('△ '), '应有 △ 头行')
  assert.ok(out.includes('Permission required'), '应有标题')
  assert.ok(out.includes(`${fg(theme.warning)}┃`), `审批面板应用 warning 竖条: ${JSON.stringify(out)}`)
  assert.ok(out.includes('Allow once'), '应有 Allow once chip')
  assert.ok(out.includes('Reject'), '应有 Reject chip')
  assert.ok(out.includes('⇆ '), '应有选择键提示')
  app.unmount()
})

test('approval：方向键选 chip，enter 确认', async (t) => {
  t.after(cleanup)
  const outcomes: string[] = []
  const app = render(h(PendingPrompt, { pending: makeApproval(), onApprove: (o) => outcomes.push(o) }))
  await flush()
  // 默认选中第一项（Allow once），enter 即提交
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(outcomes, ['allowed-once'])
  app.unmount()

  // 右移一次选中 Reject
  const outcomes2: string[] = []
  const app2 = render(h(PendingPrompt, { pending: makeApproval(), onApprove: (o) => outcomes2.push(o) }))
  await flush()
  app2.stdin.write('\x1b[C') // right arrow
  await flush()
  app2.stdin.write('\r')
  await flush()
  assert.deepEqual(outcomes2, ['rejected'])
  app2.unmount()
})

test('approval：没有 reason 时不渲染原因行', async (t) => {
  t.after(cleanup)
  const app = render(h(PendingPrompt, { pending: makeApproval(), onApprove: () => {} }))
  await flush()
  const out = app.lastFrame() ?? ''
  assert.ok(out.includes('Permission required'))
  assert.ok(!out.includes('wants to run'))
  app.unmount()
})

test('question：渲染问题与选项（含描述），accent 竖条', async (t) => {
  t.after(cleanup)
  const pending = makeQuestion([
    {
      id: 'q1',
      question: 'Pick a color',
      header: 'setup',
      options: [
        { label: 'red', description: 'warm' },
        { label: 'blue' },
      ],
    },
  ])
  const app = render(h(PendingPrompt, { pending, onAnswer: () => {} }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('setup'), '应有 header')
  assert.ok(out.includes('? '), '应有 ? 头行')
  assert.ok(out.includes('Pick a color'))
  assert.ok(out.includes('[1] red'))
  assert.ok(out.includes('- warm'))
  assert.ok(out.includes('[2] blue'))
  assert.ok(out.includes(`${fg(theme.accent)}┃`), `提问面板应用 accent 竖条: ${JSON.stringify(out)}`)
  app.unmount()
})

test('question：数字键单选作答', async (t) => {
  t.after(cleanup)
  const answers = []
  const pending = makeQuestion([
    { id: 'q1', question: 'Pick a color', options: [{ label: 'red' }, { label: 'blue' }] },
  ])
  const app = render(h(PendingPrompt, { pending, onAnswer: (a) => answers.push(a) }))
  await flush()
  app.stdin.write('2')
  await flush()
  assert.deepEqual(answers, [{ answers: [{ id: 'q1', selected: ['blue'] }] }])
  app.unmount()
})

test('question：multiSelect 切换 + enter 确认', async (t) => {
  t.after(cleanup)
  const answers = []
  const pending = makeQuestion([
    {
      id: 'q1',
      question: 'Pick toppings',
      multiSelect: true,
      options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
    },
  ])
  const app = render(h(PendingPrompt, { pending, onAnswer: (a) => answers.push(a) }))
  await flush()
  app.stdin.write('1')
  app.stdin.write('3')
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('[x] a'), '选中的项应有 [x]')
  assert.ok(out.includes('[x] c'))
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(answers, [{ answers: [{ id: 'q1', selected: ['a', 'c'] }] }])
  app.unmount()
})

test('question：无选项时自由文本作答', async (t) => {
  t.after(cleanup)
  const answers = []
  const pending = makeQuestion([{ id: 'q1', question: 'What is your name?' }])
  const app = render(h(PendingPrompt, { pending, onAnswer: (a) => answers.push(a) }))
  await flush()
  assert.ok(outputOf(app).includes('›'))
  app.stdin.write('gg')
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(answers, [{ answers: [{ id: 'q1', selected: [], custom: 'gg' }] }])
  app.unmount()
})

test('question：有选项时按 e 进入自定义文本', async (t) => {
  t.after(cleanup)
  const answers = []
  const pending = makeQuestion([
    { id: 'q1', question: 'Pick', options: [{ label: 'x' }] },
  ])
  const app = render(h(PendingPrompt, { pending, onAnswer: (a) => answers.push(a) }))
  await flush()
  app.stdin.write('e')
  await flush()
  assert.ok(outputOf(app).includes('›'))
  app.stdin.write('mine')
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(answers, [{ answers: [{ id: 'q1', selected: [], custom: 'mine' }] }])
  app.unmount()
})

test('question：多题顺序作答，最后一题答完才 onAnswer', async (t) => {
  t.after(cleanup)
  const answers = []
  const pending = makeQuestion([
    { id: 'q1', question: 'First?', options: [{ label: 'one' }] },
    { id: 'q2', question: 'Second?', options: [{ label: 'two' }] },
  ])
  const app = render(h(PendingPrompt, { pending, onAnswer: (a) => answers.push(a) }))
  await flush()
  assert.ok(outputOf(app).includes('(1/2)'))
  app.stdin.write('1')
  await flush()
  assert.deepEqual(answers, [], '第一题答完还不应提交')
  assert.ok(outputOf(app).includes('Second?'), '应前进到第二题')
  app.stdin.write('1')
  await flush()
  assert.deepEqual(answers, [
    { answers: [
      { id: 'q1', selected: ['one'] },
      { id: 'q2', selected: ['two'] },
    ] },
  ])
  app.unmount()
})

test('esc 触发 onCancel', async (t) => {
  t.after(cleanup)
  let cancelled = 0
  const app = render(
    h(PendingPrompt, { pending: makeApproval(), onApprove: () => {}, onCancel: () => cancelled++ }),
  )
  await flush()
  app.stdin.write('')
  await flush()
  assert.equal(cancelled, 1)
  app.unmount()
})
