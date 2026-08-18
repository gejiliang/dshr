/**
 * A 批感知类行组件的渲染验收：颜色与字形逐条对（判据 docs/coverage.md §三
 * 与 docs/gap-shapes.md 的实测载荷）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RED, YELLOW, bg, fg, flush, makeView, outputOf } from './helpers.ts'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { Composer, Conversation, QueueDock, setTerminalColumnsForTest, theme } from '../lib/index.js'

test('重试行：`↳ Retrying (attempt 1/2) · RATE_LIMIT`，整行 error 色', async (t) => {
  t.after(cleanup)
  const view = makeView([
    { kind: 'retry', id: 'r1', retryId: 'r-1', attempt: 1, maxRetries: 2, code: 'RATE_LIMIT', started: false },
  ])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${RED}↳ Retrying (attempt 1/2) · RATE_LIMIT`), `整行 error 色: ${JSON.stringify(out)}`)
  assert.ok(!out.includes('429'), '原始报文 failure.message 不铺在这行')
  app.unmount()
})

test('孤儿重试行：没有 maxRetries 时只写 attempt N', async (t) => {
  t.after(cleanup)
  const view = makeView([{ kind: 'retry', id: 'r2', retryId: 'r-x', attempt: 2, started: true }])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('↳ Retrying (attempt 2)'), `无 maxRetries 的写法: ${JSON.stringify(out)}`)
  assert.ok(!out.includes('attempt 2/'), '不应出现裸斜杠')
  app.unmount()
})

test('todo 表：[✓]/[ ] 是 textMuted，[•] 是 warning', async (t) => {
  t.after(cleanup)
  const view = makeView([
    {
      kind: 'todo',
      id: 'todo-1',
      todos: [
        { content: '读契约', status: 'completed' },
        { content: '实现渲染', status: 'in_progress' },
        { content: '补测试', status: 'pending' },
      ],
    },
  ])
  const app = render(h(Conversation, { view }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${fg(theme.textMuted)}[✓] 读契约`), `completed: ${JSON.stringify(out)}`)
  assert.ok(out.includes(`${YELLOW}[•] 实现渲染`), `in_progress 应为 warning 色: ${JSON.stringify(out)}`)
  assert.ok(out.includes(`${fg(theme.textMuted)}[ ] 补测试`), `pending: ${JSON.stringify(out)}`)
  app.unmount()
})

test('斜杠命令：running 是 `→ /compact` + …；完成降 muted；error 整行标红带 ✕', async (t) => {
  t.after(cleanup)
  const running = makeView([{ kind: 'command', id: 'c1', commandId: 'cmd-1', name: 'compact', status: 'running' }])
  const app1 = render(h(Conversation, { view: running }))
  await flush()
  const out1 = outputOf(app1)
  assert.ok(out1.includes('→ /compact'), `running 行: ${JSON.stringify(out1)}`)
  assert.ok(out1.includes('…'), 'running 应有流式标记')
  app1.unmount()

  const done = makeView([
    { kind: 'command', id: 'c2', commandId: 'cmd-2', name: 'model', args: 'flash', status: 'ok', text: 'switched' },
  ])
  const app2 = render(h(Conversation, { view: done }))
  await flush()
  const out2 = outputOf(app2)
  assert.ok(out2.includes(`${fg(theme.textMuted)}→ /model flash`), `完成行: ${JSON.stringify(out2)}`)
  app2.unmount()

  const failed = makeView([
    { kind: 'command', id: 'c3', commandId: 'cmd-3', name: 'model', status: 'error', text: 'no such model' },
  ])
  const app3 = render(h(Conversation, { view: failed }))
  await flush()
  const out3 = outputOf(app3)
  assert.ok(out3.includes(`${RED}→ /model ✕ no such model`), `error 行: ${JSON.stringify(out3)}`)
  app3.unmount()
})

test('压缩横线：`──── Compaction ────`，borderActive 色', async (t) => {
  t.after(cleanup)
  const view = makeView([{ kind: 'divider', id: 'd1', label: 'Compaction' }])
  const app = render(h(Conversation, { view, contentWidth: 40 }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(fg(theme.borderActive)), `应为 borderActive 色: ${JSON.stringify(out)}`)
  const plain = out.replace(/\[[0-9;]*m/g, '')
  assert.ok(/─+ Compaction ─+/.test(plain), `横线字形: ${JSON.stringify(plain)}`)
  app.unmount()
})

test('子 agent 工具行：`✓ General Task — <描述>`；未完图标 │', async (t) => {
  t.after(cleanup)
  const running = makeView([
    {
      kind: 'tool',
      id: 't1',
      callId: 'c1',
      name: 'subagent',
      status: 'running',
      args: { subagent_type: 'general', description: '调查协议形状', prompt: '……' },
    },
  ])
  const app1 = render(h(Conversation, { view: running }))
  await flush()
  const out1 = outputOf(app1)
  assert.ok(out1.includes('│ General Task — 调查协议形状'), `未完: ${JSON.stringify(out1)}`)
  app1.unmount()

  const done = makeView([
    {
      kind: 'tool',
      id: 't2',
      callId: 'c2',
      name: 'subagent_fork',
      status: 'ok',
      args: '{"subagent_type":"explore","description":"找入口"}',
      result: 'done',
    },
  ])
  const app2 = render(h(Conversation, { view: done }))
  await flush()
  const out2 = outputOf(app2)
  assert.ok(out2.includes('✓ Explore Task — 找入口'), `完成（JSON 串参数也要解出）: ${JSON.stringify(out2)}`)
  app2.unmount()
})

test('队列徽章：反色 ` QUEUED `，底色 agent 色（secondary）', async (t) => {
  t.after(cleanup)
  const app = render(h(QueueDock, { items: [{ id: 'q1', text: '说一句话' }] }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${bg(theme.secondary)}`), `应有 secondary 底色: ${JSON.stringify(out)}`)
  assert.ok(out.includes(' QUEUED '), '徽章前后各一空格')
  assert.ok(out.includes('说一句话'), '排队内容可见')
  app.unmount()
})

test('composer 模式位：见过 plan/mode 事件后留 muted 标记', async (t) => {
  t.after(cleanup)
  setTerminalColumnsForTest(80)
  const app = render(h(Composer, { onSubmit: () => {}, preset: 'standard', planModeSeen: true }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('Standard'), '模式名还在')
  assert.ok(out.includes(`${fg(theme.textMuted)} · plan/mode`), `plan/mode 标记: ${JSON.stringify(out)}`)
  app.unmount()

  const app2 = render(h(Composer, { onSubmit: () => {}, preset: 'standard' }))
  await flush()
  assert.ok(!outputOf(app2).includes('plan/mode'), '没见过事件就不该有标记')
  app2.unmount()
  setTerminalColumnsForTest(0)
})
