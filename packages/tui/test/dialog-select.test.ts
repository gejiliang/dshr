import { test } from 'node:test'
import assert from 'node:assert/strict'
import './force-color.ts'
import { bg, fg, flush } from './helpers.ts'
import { theme } from '../lib/index.js'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { CommandPalette, DialogSelect, createCommandRegistry } from '../lib/index.js'

const OPTIONS = [
  { title: 'Switch model', category: 'Suggested', footer: 'ctrl+x m', value: 'model' },
  { title: 'Hide tips', category: 'System', footer: 'ctrl+x h', value: 'tips' },
  { title: 'View status', category: 'System', footer: 'ctrl+x s', value: 'status' },
  { title: 'Open docs', category: 'Help', value: 'docs' },
]

const NOP = { onSelect: () => {}, onCancel: () => {} }

/** 当前帧里包含 substr 的那一行。 */
function lineWith(frame: string, substr: string): string | undefined {
  return frame.split('\n').find((line) => line.includes(substr))
}

test('分组渲染：标题行 + esc、Search 占位（muted）、分类自成一行且按序、条目键位右对齐', async (t) => {
  t.after(cleanup)
  const app = render(h(DialogSelect, { title: 'Commands', options: OPTIONS, ...NOP }))
  await flush()
  const frame = app.lastFrame() ?? ''
  const lines = frame.split('\n')
  const titleLine = lineWith(frame, 'Commands')
  assert.ok(titleLine !== undefined, '应有标题')
  assert.ok(titleLine.includes('esc'), '标题行右侧应有 esc')
  assert.ok(
    (lineWith(frame, 'Search') ?? '').includes(fg(theme.textMuted)),
    'Search 占位符应 muted',
  )
  const iSuggested = lines.findIndex((l) => l.includes('Suggested'))
  const iSystem = lines.findIndex((l) => l.includes('System'))
  const iHelp = lines.findIndex((l) => l.includes('Help'))
  assert.ok(iSuggested !== -1 && iSystem !== -1 && iHelp !== -1, '三个分类标题都应在')
  assert.ok(iSuggested < iSystem && iSystem < iHelp, '分类按首现顺序')
  // 分组间空一行：System 标题前一行是空行
  assert.strictEqual((lines[iSystem - 1] ?? 'x').trim(), '', '分组之间应空一行')
  assert.ok(lineWith(frame, 'Switch model')?.includes('ctrl+x m'), '条目右侧应显示键位')
  app.unmount()
})

test('当前项 gutter 画 ●：● 往左突出两列，标题与其余条目对齐', async (t) => {
  t.after(cleanup)
  const options = OPTIONS.map((o) => (o.value === 'status' ? { ...o, current: true } : o))
  const app = render(h(DialogSelect, { title: 'Select model', options, ...NOP }))
  await flush()
  const frame = app.lastFrame() ?? ''
  const current = lineWith(frame, 'View status') ?? ''
  const other = lineWith(frame, 'Hide tips') ?? ''
  assert.ok(current.includes('●'), '当前项应有 ●')
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
  const currentPlain = stripAnsi(current)
  const currentCol = currentPlain.indexOf('View status')
  const otherCol = stripAnsi(other).indexOf('Hide tips')
  assert.ok(currentCol !== -1 && otherCol !== -1)
  // 上游源码 `paddingLeft={current() || option.gutter ? 1 : 3}`：
  // 「● 」占两列，标题列对齐，● 本身往左突出两列。
  assert.strictEqual(currentCol, otherCol, '当前项标题应与其他条目对齐')
  assert.strictEqual(currentPlain.indexOf('●'), currentCol - 2, '● 应往左突出两列')
  app.unmount()
})

test('上下键移动选中（选中行底色 theme.primary）', async (t) => {
  t.after(cleanup)
  const app = render(h(DialogSelect, { title: 'Commands', options: OPTIONS, ...NOP }))
  await flush()
  const primaryBg = bg(theme.primary)
  assert.ok(
    (lineWith(app.lastFrame() ?? '', 'Switch model') ?? '').includes(primaryBg),
    '初始选中第一项',
  )
  app.stdin.write('\x1b[B') // down
  await flush()
  let frame = app.lastFrame() ?? ''
  assert.ok((lineWith(frame, 'Hide tips') ?? '').includes(primaryBg), 'down 后选中第二项')
  assert.ok(!(lineWith(frame, 'Switch model') ?? '').includes(primaryBg), '第一项不再选中')
  app.stdin.write('\x1b[A') // up
  await flush()
  frame = app.lastFrame() ?? ''
  assert.ok((lineWith(frame, 'Switch model') ?? '').includes(primaryBg), 'up 回到第一项')
  app.unmount()
})

test('enter 选中当前项，esc 取消', async (t) => {
  t.after(cleanup)
  const selected: string[] = []
  let cancelled = 0
  const app = render(
    h(DialogSelect, {
      title: 'Commands',
      options: OPTIONS,
      onSelect: (v) => selected.push(v),
      onCancel: () => cancelled++,
    }),
  )
  await flush()
  app.stdin.write('\x1b[B')
  await flush()
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(selected, ['tips'], 'enter 应选中高亮项的 value')
  app.stdin.write('\x1b')
  await flush()
  assert.strictEqual(cancelled, 1, 'esc 应触发 onCancel')
  app.unmount()
})

test('输入即过滤：一有输入就丢掉 Suggested 分组（实测行为）', async (t) => {
  t.after(cleanup)
  const app = render(h(DialogSelect, { title: 'Commands', options: OPTIONS, ...NOP }))
  await flush()
  app.stdin.write('status')
  await flush()
  const frame = app.lastFrame() ?? ''
  assert.ok(!frame.includes('Suggested'), '过滤态不应有 Suggested 分组')
  assert.ok(!frame.includes('Switch model'), 'Suggested 组的条目应一起消失')
  assert.ok(frame.includes('View status'), '匹配的条目应在')
  assert.ok(!frame.includes('Open docs'), '不匹配的条目应被滤掉')
  app.unmount()
})

test('过滤排序：标题权重 2、分类权重 1（标题命中排前）', async (t) => {
  t.after(cleanup)
  const options = [
    { title: 'Alpha', category: 'Beta stuff', value: 'category-hit' },
    { title: 'Beta launch', value: 'title-hit' },
  ]
  const selected: string[] = []
  const app = render(
    h(DialogSelect, { ...NOP, title: 'Commands', options, onSelect: (v) => selected.push(v) }),
  )
  await flush()
  app.stdin.write('beta')
  await flush()
  const frame = app.lastFrame() ?? ''
  const lines = frame.split('\n')
  const iTitle = lines.findIndex((l) => l.includes('Beta launch'))
  const iCategory = lines.findIndex((l) => l.includes('Alpha'))
  assert.ok(iTitle !== -1 && iCategory !== -1)
  assert.ok(iTitle < iCategory, '标题命中应排在分类命中之前')
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(selected, ['title-hit'], 'enter 应选中排序后的第一项')
  app.unmount()
})

test('无匹配时显示 No results found（muted）', async (t) => {
  t.after(cleanup)
  const app = render(h(DialogSelect, { title: 'Sessions', options: OPTIONS, ...NOP }))
  await flush()
  app.stdin.write('zzzzzz')
  await flush()
  const frame = app.lastFrame() ?? ''
  assert.ok(
    (lineWith(frame, 'No results found') ?? '').includes(fg(theme.textMuted)),
    '空结果提示应 muted',
  )
  app.unmount()
})

test('底部动作条：label + key 对', async (t) => {
  t.after(cleanup)
  const app = render(
    h(DialogSelect, {
      title: 'Select model',
      options: OPTIONS,
      actions: [
        { label: 'Connect provider', key: 'ctrl+a' },
        { label: 'Favorite', key: 'ctrl+f' },
      ],
      ...NOP,
    }),
  )
  await flush()
  const frame = app.lastFrame() ?? ''
  assert.ok(frame.includes('Connect provider'), '动作条应有 label')
  assert.ok(frame.includes('ctrl+a'), '动作条应有 key')
  assert.ok(frame.includes('ctrl+f'), '动作条应有第二个 key')
  app.unmount()
})

test('列表滚动：超出 maxHeight 时窗口跟随选中项', async (t) => {
  t.after(cleanup)
  const options = Array.from({ length: 8 }, (_, i) => ({
    title: `Item ${i + 1}`,
    category: 'All',
    value: `item-${i + 1}`,
  }))
  const app = render(h(DialogSelect, { title: 'Commands', options, maxHeight: 4, ...NOP }))
  await flush()
  assert.ok(!(app.lastFrame() ?? '').includes('Item 8'), '初始窗口不应有最后的条目')
  for (let i = 0; i < 7; i++) app.stdin.write('\x1b[B')
  await flush()
  const frame = app.lastFrame() ?? ''
  const lastLine = lineWith(frame, 'Item 8') ?? ''
  assert.ok(lastLine.includes(bg(theme.primary)), '选中项应随窗口滚到可见区')
  assert.ok(!frame.includes('Item 1'), '窗口顶部应已滚走')
  app.unmount()
})

test('命令面板：注册表渲染成 Commands 对话框，键位用 ", " 连接，enter 派发命令', async (t) => {
  t.after(cleanup)
  const registry = createCommandRegistry()
  let ran = ''
  registry.register({
    name: 'app.exit',
    title: 'Exit the app',
    category: 'System',
    bindings: ['ctrl+c', 'ctrl+d', 'ctrl+x q'],
    run: () => {
      ran = 'exit'
    },
  })
  registry.register({
    name: 'session.interrupt',
    title: 'Interrupt',
    category: 'Session',
    bindings: ['esc'],
    hidden: true,
    run: () => {
      ran = 'interrupt'
    },
  })
  const app = render(h(CommandPalette, { registry, onClose: () => {} }))
  await flush()
  const frame = app.lastFrame() ?? ''
  assert.ok(frame.includes('Commands'), '标题应为 Commands')
  assert.ok(frame.includes('Exit the app'), '可见命令应列出')
  assert.ok(frame.includes('ctrl+c, ctrl+d, ctrl+x q'), '多个键位应用 ", " 连接')
  assert.ok(!frame.includes('Interrupt'), 'hidden 命令不应列出')
  app.stdin.write('\r')
  await flush()
  assert.strictEqual(ran, 'exit', 'enter 应派发选中命令')
  app.unmount()
})

test('动作条：ctrl+r 触发 onTrigger，带上当前高亮项的 value', async (t) => {
  t.after(cleanup)
  const triggered: (string | undefined)[] = []
  const app = render(
    h(DialogSelect, {
      title: 'Sessions',
      options: OPTIONS,
      actions: [{ label: 'rename', key: 'ctrl+r', onTrigger: (v) => triggered.push(v) }],
      ...NOP,
    }),
  )
  await flush()
  app.stdin.write('\x1b[B') // down → 第二项 tips
  await flush()
  app.stdin.write('\x12') // ctrl+r
  await flush()
  assert.deepEqual(triggered, ['tips'], 'onTrigger 应带当前高亮项的 value')
  app.unmount()
})

test('动作条：没有 onTrigger 的动作只是展示（不会因为按下而炸）', async (t) => {
  t.after(cleanup)
  const app = render(
    h(DialogSelect, {
      title: 'Sessions',
      options: OPTIONS,
      actions: [{ label: 'delete', key: 'ctrl+d' }],
      ...NOP,
    }),
  )
  await flush()
  app.stdin.write('\x04') // ctrl+d
  await flush()
  assert.ok((app.lastFrame() ?? '').includes('Sessions'), '对话框应还在')
  app.unmount()
})

test('远程搜索（增强）：返回 value 序时按它过滤与排序', async (t) => {
  t.after(cleanup)
  const app = render(
    h(DialogSelect, {
      title: 'Sessions',
      options: OPTIONS,
      remoteSearch: (query) =>
        Promise.resolve(query === 's' ? ['status', 'tips'] : []),
      ...NOP,
    }),
  )
  await flush()
  app.stdin.write('s')
  await flush(60) // 等远程结果落地
  const frame = app.lastFrame() ?? ''
  const lines = frame.split('\n')
  const iStatus = lines.findIndex((l) => l.includes('View status'))
  const iTips = lines.findIndex((l) => l.includes('Hide tips'))
  assert.ok(iStatus !== -1 && iTips !== -1, '远程匹配的两项都应在')
  assert.ok(iStatus < iTips, '顺序应按远程返回的序（status 在 tips 前）')
  assert.ok(!frame.includes('Open docs'), '不在远程结果里的条目应被滤掉')
  app.unmount()
})

test('远程搜索：返回 undefined（部署关掉了 search）退回本地过滤，照样能用', async (t) => {
  t.after(cleanup)
  let calls = 0
  const app = render(
    h(DialogSelect, {
      title: 'Sessions',
      options: OPTIONS,
      remoteSearch: () => {
        calls++
        return Promise.resolve(undefined)
      },
      ...NOP,
    }),
  )
  await flush()
  app.stdin.write('status')
  await flush(60)
  const frame = app.lastFrame() ?? ''
  assert.ok(frame.includes('View status'), '本地过滤应照常工作')
  assert.ok(!frame.includes('Open docs'), '不匹配的条目应被滤掉')
  app.stdin.write('!') // query 变成 status! —— 已标记不可用，不应再调远程
  await flush(60)
  assert.strictEqual(calls, 1, '标记不可用后不应再调远程搜索')
  app.unmount()
})

test('远程搜索：抛错同样退回本地过滤', async (t) => {
  t.after(cleanup)
  const app = render(
    h(DialogSelect, {
      title: 'Sessions',
      options: OPTIONS,
      remoteSearch: () => Promise.reject(new Error('connection lost')),
      ...NOP,
    }),
  )
  await flush()
  app.stdin.write('status')
  await flush(60)
  assert.ok((app.lastFrame() ?? '').includes('View status'), '抛错后本地过滤应照常工作')
  app.unmount()
})

test('suggested 命令：未过滤时只在 Suggested 里露一次，一搜本体登场（回归）', async (t) => {
  t.after(cleanup)
  // 这条钉死一个真踩过的 bug：早先把 suggested 命令**归类**成 Suggested 而不是复制，
  // 于是一输入过滤就把条目本身删了——`Switch model` 是唯一 suggested 命令，
  // 搜 `model` 返回 No results found，最要紧的那条命令反而搜不到。
  let ran = ''
  const registry = createCommandRegistry()
  registry.register({
    name: 'model.switch',
    title: 'Switch model',
    suggested: true,
    run: () => {
      ran = 'model'
    },
  })
  registry.register({
    name: 'session.switch',
    title: 'Switch session',
    category: 'Session',
    run: () => {},
  })
  const app = render(h(CommandPalette, { registry, onClose: () => {} }))
  await flush()

  const unfiltered = app.lastFrame() ?? ''
  assert.ok(unfiltered.includes('Suggested'), '未过滤应有 Suggested 分组')
  const occurrences = unfiltered.split('Switch model').length - 1
  assert.strictEqual(occurrences, 1, `未过滤时 Switch model 只该出现一次，实际 ${occurrences} 次`)

  app.stdin.write('model')
  await flush()
  const filtered = app.lastFrame() ?? ''
  assert.ok(filtered.includes('Switch model'), '搜 model 必须找得到 Switch model')
  assert.ok(!filtered.includes('Suggested'), '过滤后 Suggested 分组应消失')
  assert.ok(!filtered.includes('Switch session'), '不匹配的命令应被滤掉')

  app.stdin.write('\r')
  await flush()
  assert.strictEqual(ran, 'model', '选中过滤后的本体应派发到原命令名（不带 suggested: 前缀）')
  app.unmount()
})
