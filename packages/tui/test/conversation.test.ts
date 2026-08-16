import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PRIMARY, RED, YELLOW, bg, fg, flush, makeView, outputOf } from './helpers.ts'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { Box } from 'ink'
import { Conversation, theme } from '../lib/index.js'

test('用户消息：左侧粗竖线 ┃（primary）、上下各留一行空、panel 底色', async (t) => {
  t.after(cleanup)
  const view = makeView([{ kind: 'user', id: 'u1', text: 'hello there' }])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${PRIMARY}┃`), `用户竖线应为 primary: ${JSON.stringify(out)}`)
  assert.ok(out.includes('hello there'))
  // 内容区带 backgroundPanel 底色
  assert.ok(out.includes(bg(theme.backgroundPanel)), '用户消息应有 panel 底色')
  const frame = (app.lastFrame() ?? '').replaceAll('\r', '')
  const lines = frame.split('\n')
  const textLine = lines.findIndex((l) => l.includes('hello there'))
  assert.ok(textLine >= 1, '上面应有一行空行（只有竖条）')
  assert.ok(lines[textLine - 1]?.includes('┃'), '空行也要有竖条')
  assert.ok(lines[textLine + 1]?.includes('┃'), '下面也要有一行只有竖条的空行')
  app.unmount()
})

test('助手消息：没有竖线，只有缩进', async (t) => {
  t.after(cleanup)
  const view = makeView([
    { kind: 'user', id: 'u1', text: 'q' },
    { kind: 'assistant', id: 'a1', text: 'line1\nline2', streaming: false },
  ])
  // 外壳（session-app）给会话列左右 padding 2，这里包同一层
  const app = render(h(Box, { paddingLeft: 2 }, h(Conversation, { view })))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('line1'))
  assert.ok(out.includes('line2'))
  const frame = (app.lastFrame() ?? '').replaceAll('\r', '')
  const lines = frame.split('\n')
  for (const line of lines.filter((l) => l.includes('line1') || l.includes('line2'))) {
    assert.ok(!line.includes('│') && !line.includes('┃'), `助手行不应有竖线: ${JSON.stringify(line)}`)
    assert.ok(line.startsWith('     '), `助手正文应缩进 5 列: ${JSON.stringify(line)}`)
  }
  app.unmount()
})

test('reasoning 折成一行 `+ Thought: <时长>`，warning 色，不泄出正文', async (t) => {
  t.after(cleanup)
  const view = makeView([
    {
      kind: 'reasoning',
      id: 'r1',
      text: 'first line of thinking\nsecond line detail',
      streaming: false,
      durationMs: 256,
    },
  ])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${YELLOW}+ Thought: 256ms`), `应为 + Thought: 256ms: ${JSON.stringify(out)}`)
  assert.ok(!out.includes('second line detail'), 'reasoning 默认折叠，正文不应出现')
  app.unmount()
})

test('reasoning 流式中显示 ⋯ Thinking，无时长', async (t) => {
  t.after(cleanup)
  const view = makeView([{ kind: 'reasoning', id: 'r1', text: 'partial', streaming: true }])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('⋯ Thinking'), `流式 thinking 提示: ${JSON.stringify(out)}`)
  assert.ok(!out.includes('+ Thought'), '未收尾不应显示 + Thought')
  app.unmount()
})

test('工具调用一行：`-> Read .`（图标 + 工具名 + 参数），完成后 textMuted', async (t) => {
  t.after(cleanup)
  const view = makeView([
    {
      kind: 'tool',
      id: 't1',
      callId: 'c1',
      name: 'read',
      status: 'ok',
      args: { path: '.' },
      result: 'ok',
    },
  ])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('-> read .'), `应为 -> read .: ${JSON.stringify(out)}`)
  assert.ok(out.includes(fg(theme.textMuted)), '完成的工具行应为 textMuted')
  assert.ok(!out.includes('"path"'), '不应渲染完整 args JSON')
  app.unmount()
})

test('bash 工具用 $ 图标；running 行是 text 色 + …', async (t) => {
  t.after(cleanup)
  const view = makeView([
    { kind: 'tool', id: 't2', callId: 'c2', name: 'bash', status: 'running', args: { command: 'npm test' } },
  ])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('$ bash npm test'), `应为 $ bash npm test: ${JSON.stringify(out)}`)
  assert.ok(out.includes('…'), 'running 应有流式标记')
  app.unmount()
})

test('工具失败标红并带错误摘要', async (t) => {
  t.after(cleanup)
  const view = makeView([
    {
      kind: 'tool',
      id: 't3',
      callId: 'c3',
      name: 'bash',
      status: 'error',
      args: { command: 'pnpm build' },
      result: 'boom happened',
    },
  ])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(RED), `失败应标红: ${JSON.stringify(out)}`)
  assert.ok(out.includes('✕'), '失败行应有 ✕')
  assert.ok(out.includes('boom happened'), '失败摘要应可见')
  app.unmount()
})

test('每轮结尾页脚：`▣ Standard · model · 2.5s`；interrupted 降为 muted', async (t) => {
  t.after(cleanup)
  const view = makeView([
    {
      kind: 'turn',
      id: 'turn-1',
      durationMs: 2_500,
      model: 'deepseek-chat',
      provider: 'deepseek',
    },
  ])
  const app = render(h(Conversation, { view, preset: 'standard' }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${PRIMARY}▣`), `▣ 应为 primary: ${JSON.stringify(out)}`)
  assert.ok(out.includes('Standard'), '模式名 titlecase')
  assert.ok(out.includes('· deepseek-chat'), '应含模型名')
  assert.ok(out.includes('2.5s'), '应含耗时')
  app.unmount()

  const view2 = makeView([{ kind: 'turn', id: 'turn-2', durationMs: 100, interrupted: true }])
  const app2 = render(h(Conversation, { view: view2 }))
  await flush()
  const out2 = outputOf(app2)
  assert.ok(out2.includes('interrupted'), '被打断的轮次应标注')
  app2.unmount()
})

test('流式增量更新可见：文本追加、streaming 结束后正常显示', async (t) => {
  t.after(cleanup)
  const streaming = { kind: 'assistant', id: 'a1', text: 'partial', streaming: true }
  const view = makeView([streaming])
  const app = render(h(Conversation, { view }))
  await flush()
  assert.ok(outputOf(app).includes('partial'))

  view._update([{ ...streaming, text: 'partial answer grows' }])
  await flush()
  assert.ok(outputOf(app).includes('partial answer grows'))

  view._update([{ ...streaming, text: 'partial answer grows', streaming: false }])
  await flush()
  assert.ok((app.lastFrame() ?? '').includes('partial answer grows'))
  app.unmount()
})

test('hasOlder 时顶部有 muted 的历史提示', async (t) => {
  t.after(cleanup)
  const view = makeView([{ kind: 'notice', id: 'n1', text: 'session started' }], { hasOlder: true })
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${fg(theme.textMuted)}⋮ earlier history`), '应有 muted 的翻页提示')
  app.unmount()
})

test('error 项红条 + panel 底；notice 项 muted', async (t) => {
  t.after(cleanup)
  const view = makeView([
    { kind: 'error', id: 'e1', message: 'provider blew up' },
    { kind: 'notice', id: 'n1', text: 'resumed from log' },
  ])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${RED}┃`), '错误项应有红竖条')
  assert.ok(out.includes('provider blew up'))
  assert.ok(out.includes(`${fg(theme.textMuted)}· resumed from log`))
  app.unmount()
})

test('maxRows 尾部窗口：超预算时截最旧的条目，最新内容始终在', async (t) => {
  t.after(cleanup)
  const items = Array.from({ length: 40 }, (_, i) => ({
    kind: 'assistant',
    id: `a${i}`,
    text: `message number ${i}`,
    streaming: false,
  }))
  const view = makeView(items)
  const app = render(h(Conversation, { view, maxRows: 5, contentWidth: 80 }))
  await flush()
  const frame = (app.lastFrame() ?? '').replaceAll('\r', '')
  assert.ok(frame.includes('message number 39'), '最新条目必须在窗口里')
  assert.ok(!frame.includes('message number 0'), '最旧条目应被截掉')
  app.unmount()
})
