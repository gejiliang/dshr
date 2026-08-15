import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CYAN, DIM, GRAY, ITALIC, RED, flush, makeView, outputOf } from './helpers.ts'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { Conversation } from '../lib/index.js'

test('用户/助手消息用左侧竖线区分角色：用户 cyan、助手 gray', async (t) => {
  t.after(cleanup)
  const view = makeView([
    { kind: 'user', id: 'u1', text: 'hello there' },
    { kind: 'assistant', id: 'a1', text: 'hi back', streaming: false },
  ])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${CYAN}│`), `用户竖线应为 cyan: ${JSON.stringify(out)}`)
  assert.ok(out.includes(`${GRAY}│`), `助手竖线应为 gray: ${JSON.stringify(out)}`)
  assert.ok(out.includes('hello there'))
  assert.ok(out.includes('hi back'))
  // 正文用默认前景色：竖线 reset 之后不再带颜色码
  assert.ok(out.includes(`${CYAN}│[39m hello there`))
  app.unmount()
})

test('多行消息每一行都带竖线', async (t) => {
  t.after(cleanup)
  const view = makeView([{ kind: 'assistant', id: 'a1', text: 'line1\nline2', streaming: false }])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${GRAY}│[39m line1`))
  assert.ok(out.includes(`${GRAY}│[39m line2`))
  app.unmount()
})

test('工具调用折叠成一行：⏺ bash(npm test)，后跟一行 dim 结果摘要', async (t) => {
  t.after(cleanup)
  const view = makeView([
    {
      kind: 'tool',
      id: 't1',
      callId: 'c1',
      name: 'bash',
      status: 'ok',
      args: { command: 'npm test' },
      view: { for: 'call', view: { card: 'terminal', title: 'npm test' } },
      result: 'all tests passed',
    },
  ])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('⏺ bash(npm test)'), `折叠行: ${JSON.stringify(out)}`)
  assert.ok(out.includes('⎿ all tests passed'))
  // 摘要行是 dim 的
  assert.ok(out.includes(`${DIM}`), '摘要行应 dim')
  // 折叠态不渲染 args 的完整 JSON
  assert.ok(!out.includes('"command"'), '不应出现完整 args JSON')
  app.unmount()
})

test('工具失败标红', async (t) => {
  t.after(cleanup)
  const view = makeView([
    {
      kind: 'tool',
      id: 't2',
      callId: 'c2',
      name: 'bash',
      status: 'error',
      args: { command: 'pnpm build' },
      view: { for: 'result', view: { card: 'terminal', output: 'boom happened', exitCode: 1 } },
      result: 'boom happened',
    },
  ])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('exit 1 · boom happened'))
  assert.ok(out.includes(`${RED}`), `失败应标红: ${JSON.stringify(out)}`)
  assert.ok(out.includes('✕'))
  app.unmount()
})

test('没有 view 的工具回退到 args 显著参数，不渲染整份 JSON', async (t) => {
  t.after(cleanup)
  const view = makeView([
    {
      kind: 'tool',
      id: 't3',
      callId: 'c3',
      name: 'read_file',
      status: 'ok',
      args: { path: '/src/index.ts', offset: 12, limit: 40 },
      result: { lines: 40 },
    },
  ])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('⏺ read_file(/src/index.ts)'))
  assert.ok(!out.includes('"offset"'), '不应把 args 整份 JSON 渲染出来')
  app.unmount()
})

test('running 的工具没有结果摘要，行内带流式标记', async (t) => {
  t.after(cleanup)
  const view = makeView([
    { kind: 'tool', id: 't4', callId: 'c4', name: 'bash', status: 'running', args: { command: 'sleep 5' } },
  ])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('⏺ bash(sleep 5)'))
  assert.ok(!out.includes('⎿'), 'running 时不应有结果摘要行')
  app.unmount()
})

test('reasoning 默认折叠成一行：dim + 斜体，不泄出后续行', async (t) => {
  t.after(cleanup)
  const view = makeView([
    {
      kind: 'reasoning',
      id: 'r1',
      text: 'first line of thinking\nsecond line detail\nthird line detail',
      streaming: false,
    },
  ])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('first line of thinking'))
  assert.ok(!out.includes('second line detail'), 'reasoning 默认折叠，第二行不应出现')
  assert.ok(out.includes(DIM), 'reasoning 应 dim')
  assert.ok(out.includes(ITALIC), 'reasoning 应斜体')
  app.unmount()
})

test('streaming 位反映在输出上：流式项带 ▍，结束后消失', async (t) => {
  t.after(cleanup)
  const streaming = { kind: 'assistant', id: 'a1', text: 'partial', streaming: true }
  const view = makeView([streaming])
  const app = render(h(Conversation, { view }))
  await flush()
  assert.ok(outputOf(app).includes('▍'), '流式中应有 ▍')

  // 模拟流式增量：逐段追加，同一项更新
  view._update([{ ...streaming, text: 'partial answer grows' }])
  await flush()
  assert.ok(outputOf(app).includes('partial answer grows'))

  // 流结束
  view._update([{ ...streaming, text: 'partial answer grows', streaming: false }])
  await flush()
  const last = app.lastFrame() ?? ''
  assert.ok(!last.includes('▍'), '流结束后 ▍ 应消失')
  app.unmount()
})

test('hasOlder 时顶部有 dim 的历史提示', async (t) => {
  t.after(cleanup)
  const view = makeView([{ kind: 'notice', id: 'n1', text: 'session started' }], { hasOlder: true })
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${DIM}⋮ earlier history`), '应有 dim 的翻页提示')
  app.unmount()
})

test('error 项红、notice 项 dim', async (t) => {
  t.after(cleanup)
  const view = makeView([
    { kind: 'error', id: 'e1', message: 'provider blew up' },
    { kind: 'notice', id: 'n1', text: 'resumed from log' },
  ])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${RED}✕ provider blew up`))
  assert.ok(out.includes(`${DIM}· resumed from log`))
  app.unmount()
})
