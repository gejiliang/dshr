/**
 * D 批的 tui 层验收：底部栏后台任务 chip、DialogSelect 的 tone、
 * DialogPrompt 单行输入、Composer 的附件行与 ctrl+u 清空。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import './force-color.ts'
import { fg, flush, outputOf } from './helpers.ts'
import { theme } from '../lib/index.js'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { Composer, DialogPrompt, DialogSelect, Footer, setTerminalColumnsForTest } from '../lib/index.js'

test('底部栏：有 running 的后台任务才画 ◆ N jobs chip', async (t) => {
  t.after(cleanup)
  const app = render(h(Footer, { connection: 'ready', runningJobs: 2 }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${fg(theme.secondary)}◆`), '◆ 应为 secondary 色')
  assert.ok(out.includes('2 jobs running'), '计数与标签')
  app.unmount()

  const none = render(h(Footer, { connection: 'ready' }))
  await flush()
  assert.ok(!outputOf(none).includes('◆'), '没有 running 时不画')
  none.unmount()
})

test('DialogSelect：tone 决定非选中标题色（error / muted / default）', async (t) => {
  t.after(cleanup)
  const app = render(
    h(DialogSelect, {
      title: 'Background jobs',
      options: [
        { title: 'sleep 30', label: 'bash · 2.0s', tone: 'default', value: 'a' },
        { title: 'npm test', label: 'bash · 1.0s · exit code: 1', tone: 'error', value: 'b' },
        { title: 'old job', label: 'bash · 3.0s', tone: 'muted', value: 'c' },
      ],
      onSelect: () => {},
      onCancel: () => {},
    }),
  )
  await flush()
  const out = outputOf(app)
  // 第一项选中（反色），第二项 error、第三项 muted
  assert.ok(out.includes(`${fg(theme.error)}npm test`), 'failed/killed 的标题应为 error 色')
  assert.ok(out.includes(`${fg(theme.textMuted)}old job`), 'completed 的标题应为 muted')
  assert.ok(out.includes(`${fg(theme.textMuted)} bash · 1.0s · exit code: 1`), 'label 恒 muted')
  app.unmount()
})

test('DialogPrompt：打字 + enter 提交；esc 取消；空串不提交', async (t) => {
  t.after(cleanup)
  const submitted: string[] = []
  let cancelled = false
  const app = render(
    h(DialogPrompt, {
      title: 'Attach image',
      placeholder: '/path/to/image.png',
      onSubmit: (v) => submitted.push(v),
      onCancel: () => {
        cancelled = true
      },
    }),
  )
  await flush()
  assert.ok((app.lastFrame() ?? '').includes('Attach image'))
  assert.ok((app.lastFrame() ?? '').includes('/path/to/image.png'), '占位提示')

  app.stdin.write('/tmp/a.png')
  await flush()
  assert.ok((app.lastFrame() ?? '').includes('/tmp/a.png'), '打进去的字符要回显')

  app.stdin.write('\r')
  await flush()
  assert.deepEqual(submitted, ['/tmp/a.png'])
  assert.equal(cancelled, false)
  app.unmount()

  const app2 = render(
    h(DialogPrompt, { title: 'x', onSubmit: (v) => submitted.push(v), onCancel: () => (cancelled = true) }),
  )
  await flush()
  app2.stdin.write('\r') // 空串不提交
  await flush()
  assert.deepEqual(submitted, ['/tmp/a.png'])
  app2.stdin.write('\x1b')
  await flush()
  assert.equal(cancelled, true)
  app2.unmount()
})

test('Composer：附件行画出 📎 与文件名，ctrl+u 清空；notice 以 error 色画出', async (t) => {
  t.after(cleanup)
  setTerminalColumnsForTest(80)
  let cleared = 0
  const app = render(
    h(Composer, {
      onSubmit: () => {},
      attachments: [
        { name: 'a.png', bytes: 100 },
        { name: 'b.jpg', bytes: 200 },
      ],
      onClearAttachments: () => cleared++,
      notice: 'Image too large: a.png',
    }),
  )
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('📎 2 images'), '附件计数')
  assert.ok(out.includes('a.png, b.jpg'), '附件文件名')
  assert.ok(out.includes('ctrl+u'), '清空提示')
  assert.ok(out.includes(`${fg(theme.error)}Image too large: a.png`), 'notice 应为 error 色')

  app.stdin.write('\x15') // ctrl+u
  await flush()
  assert.equal(cleared, 1, 'ctrl+u 触发清空')
  app.unmount()

  // 没附件时 ctrl+u 不吃这个键（也不会触发清空回调）
  const bare = render(h(Composer, { onSubmit: () => {}, onClearAttachments: () => cleared++ }))
  await flush()
  bare.stdin.write('\x15')
  await flush()
  assert.equal(cleared, 1, '没附件时 ctrl+u 不动作')
  bare.unmount()
  setTerminalColumnsForTest(0)
})
