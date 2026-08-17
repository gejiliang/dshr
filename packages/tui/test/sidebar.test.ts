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

test('logo 拼的是 dshr —— 钉住两次被人读错的那两处（回归）', async (t) => {
  t.after(cleanup)
  // 这个 logo 返工过两次，**两次都是人一眼读错才发现的**，两次都不是「字符写错了」：
  //
  //   第一稿 → 被读成 `oshr`：d 只有闭合方框、没有升部。上游字库里
  //            `d` = `o` + 右立柱上方一个凸起，那一点就是 d 与 o 的全部区别。
  //   第二稿 → 被读成 `dsbc`：h 的碗底用了上游 n 的暗色中段 `~~`，暗色在终端里
  //            几乎看不出来，碗看着是闭合的（= b）；r 带一整条底边，四面围起来（= c）。
  //
  // 所以这里断言的不是「字符长什么样」，而是**让它读得出来的那几条几何性质**：
  // 升部在不在、碗开不开、底边有没有多画。换字形时这些必须仍然成立。
  //
  // ⚠️ 单测钉不住「读不读得出来」——那只能靠眼睛：`node tools/logo.mjs`。
  const app = render(h(Logo, {}))
  await flush()
  const stripped = (app.lastFrame() ?? '').replaceAll('\r', '').replace(/\u001b\[[0-9;]*m/g, '')
  const rows = stripped.split('\n').map((r) => r.padEnd(19, ' '))
  // 字形槽：每个 4 宽、空一格 —— d[0..3] s[5..8] h[10..13] r[15..18]
  const slot = (row: number, start: number): string => (rows[row] ?? '').slice(start, start + 4)
  const riser = (ch: string): boolean => ch === '▄' || ch === '█'

  assert.strictEqual(slot(1, 0), '█▀▀█', 'd 的碗')
  assert.ok(riser(slot(0, 0)[3] ?? ' '), `d 的升部必须在右立柱正上方，否则就是 o：${JSON.stringify(rows[0])}`)
  assert.ok(riser(slot(0, 10)[0] ?? ' '), `h 的升部必须在左立柱正上方：${JSON.stringify(rows[0])}`)

  // h 的碗底必须**真开口**（两条腿）。用暗色糊过去就会被读成 b。
  assert.strictEqual(slot(3, 10), '▀  ▀', 'h 的底部必须是两条腿，中间不能有任何东西')

  // r 的肩下面什么都没有；多画一条底边就围成 c 了。
  assert.strictEqual(slot(3, 15).trimEnd(), '▀', 'r 的底边只留立柱那一格')
  assert.strictEqual(slot(2, 15).trimEnd(), '█', 'r 的肩下只有立柱')

  // 四个字形不能有两个同形，否则读出来必然是别的词。
  assert.notStrictEqual(slot(1, 0), slot(1, 5), 'd 与 s 不能同形')
  assert.notStrictEqual(slot(1, 0), slot(1, 10), 'd 与 h 不能同形')
  app.unmount()
})
