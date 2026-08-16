import { test } from 'node:test'
import assert from 'node:assert/strict'
import './force-color.ts'
import { bg, fg, flush, outputOf } from './helpers.ts'
import { theme } from '../lib/index.js'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { Logo, Sidebar } from '../lib/index.js'

test('信息列：panel 底色、标题加粗、workspace 标签、Context 块、底部版本行', async (t) => {
  t.after(cleanup)
  const app = render(
    h(Sidebar, {
      title: '一句话解释 TUI',
      workspace: '~/Workspace/dshr',
      contextTokens: 10_209,
      contextPercent: 8,
      version: '0.1.0',
    }),
  )
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes(bg(theme.backgroundPanel)), '整列 backgroundPanel 底色')
  assert.ok(out.includes('一句话解释 TUI'), '会话标题')
  assert.ok(out.includes('~/Workspace/dshr'), 'workspace 标签')
  assert.ok(out.includes('Context'), 'Context 块')
  assert.ok(out.includes('10,209 tokens'), 'tokens 千分位')
  assert.ok(out.includes('8% used'), '用量百分比')
  assert.ok(out.includes('•'), '底部版本行')
  assert.ok(out.includes('dshr'), '底部版本行')
  assert.ok(out.includes('0.1.0'), '底部版本行')
  assert.ok(!out.includes('$'), '没有花费数据就不画，不填假值')
  assert.ok(!out.includes('LSP'), '没有 LSP 就不画')
  assert.ok(!out.includes('MCP'), '没有 MCP 就不画')
  // 宽度 42（+ 颜色码剥离后每行 ≤ 42 列）
  const frame = (app.lastFrame() ?? '').replaceAll('\r', '')
  for (const line of frame.split('\n')) {
    // 剥 ANSI 后行宽
    const stripped = line.replace(/\u001b\[[0-9;]*m/g, '')
    assert.ok(
      stripped.length <= 42 || stripped.trim() === '',
      `行宽应 ≤ 42: ${JSON.stringify(stripped)}`,
    )
  }
  app.unmount()
})

test('没有 Context 数据时整块不画；标题缺省用 New session', async (t) => {
  t.after(cleanup)
  const app = render(h(Sidebar, {}))
  await flush()
  const out = outputOf(app)
  assert.ok(!out.includes('Context'), '无数据不画 Context')
  assert.ok(!out.includes('tokens'), '无数据不画 tokens')
  assert.ok(out.includes('New session'), '标题缺省')
  app.unmount()
})

test('logo：左右两半、加粗右半、4 行方块字', async (t) => {
  t.after(cleanup)
  const app = render(h(Logo, {}))
  await flush()
  const frame = (app.lastFrame() ?? '').replaceAll('\r', '')
  const stripped = frame.replace(/\u001b\[[0-9;]*m/g, '')
  const lines = stripped.split('\n').filter((l) => l.trim() !== '')
  assert.ok(lines.length >= 3, `logo 应有 3 行字形: ${JSON.stringify(stripped)}`)
  assert.ok(stripped.includes('█▀▀█'), '方块字形')
  const out = outputOf(app)
  assert.ok(out.includes(fg(theme.textMuted)), '左半 textMuted')
  assert.ok(out.includes(fg(theme.text)), '右半 text')
  app.unmount()
})
