import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DIM, RED, YELLOW, flush, outputOf } from './helpers.ts'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { StatusLine } from '../lib/index.js'

test('状态行：模型 · 上下文用量 · 当前轮耗时 · 连接状态，一行 dim', async (t) => {
  t.after(cleanup)
  const app = render(
    h(StatusLine, {
      model: 'deepseek-chat',
      contextUsed: 12_300,
      contextLimit: 128_000,
      turnElapsedMs: 4200,
      connection: 'ready',
    }),
  )
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('deepseek-chat'))
  assert.ok(out.includes('12.3k/128k ctx'))
  assert.ok(out.includes('4.2s'))
  assert.ok(out.includes('connected'))
  assert.ok(out.includes(DIM), '整行 chrome 应 dim')
  // 单行：输出里没有换行
  const frame = (app.lastFrame() ?? '').replaceAll('\r', '')
  assert.ok(!frame.trim().includes('\n'), `状态行必须是一行: ${JSON.stringify(frame)}`)
  app.unmount()
})

test('断连标红，blocked 标黄', async (t) => {
  t.after(cleanup)
  const app = render(
    h(StatusLine, { model: 'm', connection: 'lost', agentStatus: 'blocked' }),
  )
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(`${RED}disconnected`))
  assert.ok(out.includes(`${YELLOW}blocked`))
  app.unmount()
})

test('可选段缺省时只渲染有的信息', async (t) => {
  t.after(cleanup)
  const app = render(h(StatusLine, { connection: 'connecting' }))
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('—'), '模型缺省渲染占位')
  assert.ok(out.includes('connecting…'))
  assert.ok(!out.includes('ctx'))
  app.unmount()
})
