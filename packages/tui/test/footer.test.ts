import { test } from 'node:test'
import assert from 'node:assert/strict'
import './force-color.ts'
import { fg, flush, outputOf } from './helpers.ts'
import { theme } from '../lib/index.js'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { Footer } from '../lib/index.js'

test('底部栏：左 cwd（muted），右一排 chip：连接 + 模型', async (t) => {
  t.after(cleanup)
  const app = render(
    h(Footer, { cwd: '~/Workspace/dshr', connection: 'ready', model: 'deepseek-chat' }),
  )
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${fg(theme.textMuted)}~/Workspace/dshr`), 'cwd 应 muted')
  assert.ok(out.includes('connected'), '连接状态 chip')
  assert.ok(out.includes('deepseek-chat'), '模型 chip')
  // 单行：输出里没有换行
  const frame = (app.lastFrame() ?? '').replaceAll('\r', '')
  assert.ok(!frame.trim().includes('\n'), `底部栏必须是一行: ${JSON.stringify(frame)}`)
  app.unmount()
})

test('未决审批画 △ N（warning），没有时不画', async (t) => {
  t.after(cleanup)
  const app = render(h(Footer, { connection: 'ready', pendingApprovals: 2 }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${fg(theme.warning)}△ 2 approvals`), '未决审批 chip 应为 warning 色')
  app.unmount()

  const app2 = render(h(Footer, { connection: 'ready' }))
  await flush()
  assert.ok(!(outputOf(app2)).includes('△'), '无未决审批不应画格子')
  app2.unmount()
})

test('连接状态：ready 绿点、lost 红点、connecting muted', async (t) => {
  t.after(cleanup)
  const ready = render(h(Footer, { connection: 'ready' }))
  await flush()
  assert.ok(outputOf(ready).includes(`${fg(theme.success)}•`))
  ready.unmount()

  const lost = render(h(Footer, { connection: 'lost' }))
  await flush()
  assert.ok(outputOf(lost).includes(`${fg(theme.error)}•`))
  assert.ok(outputOf(lost).includes('disconnected'))
  lost.unmount()

  const connecting = render(h(Footer, { connection: 'connecting' }))
  await flush()
  assert.ok(outputOf(connecting).includes('connecting'))
  connecting.unmount()
})
