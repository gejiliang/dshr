import { test } from 'node:test'
import assert from 'node:assert/strict'
import './force-color.ts'
import { flush, outputOf } from './helpers.ts'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import {
  Composer,
  setTerminalColumnsForTest,
  type SlashCommandEntry,
} from '../lib/index.js'

test.before(() => {
  setTerminalColumnsForTest(60)
})

const ENTRIES: readonly SlashCommandEntry[] = [
  { key: 'dshr:session.switch', name: 'session.switch', label: 'Switch session', source: 'dshr' },
  { key: 'dshr:app.exit', name: 'app.exit', label: 'Exit the app', source: 'dshr' },
  { key: 'dsh:help', name: 'help', label: 'Show help', source: 'dsh' },
  { key: 'dsh:compact', name: 'compact', label: 'Compact context', source: 'dsh', takesInput: true },
]

function renderComposer(overrides: Record<string, unknown> = {}) {
  const picked: SlashCommandEntry[] = []
  const submitted: string[] = []
  const app = render(
    h(Composer, {
      onSubmit: (text: string) => submitted.push(text),
      slashCommands: ENTRIES,
      onSlashCommand: (entry: SlashCommandEntry) => picked.push(entry),
      ...overrides,
    }),
  )
  return { app, picked, submitted }
}

test('空输入下 `/` 作第一个字符 → 出候选列表', async (t) => {
  t.after(cleanup)
  const { app } = renderComposer()
  await flush()
  assert.ok(!outputOf(app).includes('/session.switch'))
  app.stdin.write('/')
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('/session.switch'), `候选应列出: ${JSON.stringify(out)}`)
  assert.ok(out.includes('/app.exit'))
  assert.ok(out.includes('/help'), 'dsh 来源的命令也应在')
  assert.ok(out.includes('Switch session'), '应带 muted 说明')
  app.unmount()
})

test('中途的 `/` 不触发（路径这类正常文本）', async (t) => {
  t.after(cleanup)
  const { app } = renderComposer()
  await flush()
  app.stdin.write('ab/c')
  await flush()
  const out = outputOf(app)
  assert.ok(!outputOf(app).includes('/session.switch'), `中途 / 不应出候选: ${JSON.stringify(out)}`)
  app.unmount()
})

test('跟着后续输入实时过滤', async (t) => {
  t.after(cleanup)
  const { app } = renderComposer()
  await flush()
  app.stdin.write('/sw')
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('/session.switch'), '模糊的 sw 应命中 session.switch')
  assert.ok(!out.includes('/app.exit'), '不命中的应被滤掉')
  assert.ok(!out.includes('/help'), '不命中的应被滤掉')
  app.unmount()
})

test('esc 收起并保留已输入的文本；继续打字候选回来', async (t) => {
  t.after(cleanup)
  let interrupted = 0
  const { app } = renderComposer({ working: true, onInterrupt: () => interrupted++ })
  await flush()
  app.stdin.write('/')
  await flush()
  assert.ok(outputOf(app).includes('/session.switch'))
  app.stdin.write('\x1b')
  await flush()
  // 「不再出现」的断言要看 lastFrame——outputOf 是所有帧的拼接，旧的候选行还在里面。
  assert.ok(!(app.lastFrame() ?? '').includes('/session.switch'), 'esc 后候选应收起')
  assert.ok((app.lastFrame() ?? '').includes('/'), '已输入的 / 应还在')
  assert.equal(interrupted, 0, '弹出层开着时 esc 不该触发 interrupt')
  // 文本一变就重新武装
  app.stdin.write('s')
  await flush()
  assert.ok((app.lastFrame() ?? '').includes('/session.switch'), '继续打字候选应回来')
  app.unmount()
})

test('enter 执行当前高亮项并清空输入框', async (t) => {
  t.after(cleanup)
  const { app, picked, submitted } = renderComposer()
  await flush()
  app.stdin.write('/')
  await flush()
  app.stdin.write('\r')
  await flush()
  assert.equal(picked.length, 1)
  assert.equal(picked[0]?.key, 'dshr:session.switch', '未过滤时第一条是注册序的第一条')
  assert.deepEqual(submitted, [], '执行命令不走 onSubmit')
  assert.ok((app.lastFrame() ?? '').includes('Ask anything'), '输入框应已清空')
  app.unmount()
})

test('↓ 移动选择后 enter 执行的是选中的那条', async (t) => {
  t.after(cleanup)
  const { app, picked } = renderComposer()
  await flush()
  app.stdin.write('/')
  await flush()
  app.stdin.write('\x1b[B') // ↓
  app.stdin.write('\x1b[B')
  await flush()
  app.stdin.write('\r')
  await flush()
  assert.equal(picked.length, 1)
  assert.equal(picked[0]?.key, 'dsh:help', '两下 ↓ 应落在第三条')
  app.unmount()
})

test('过滤后 enter 执行过滤结果的第一条', async (t) => {
  t.after(cleanup)
  const { app, picked } = renderComposer()
  await flush()
  app.stdin.write('/exit')
  await flush()
  app.stdin.write('\r')
  await flush()
  assert.equal(picked[0]?.key, 'dshr:app.exit')
  app.unmount()
})

test('takesInput 的命令 enter 只补全成 `/name `，不执行；之后可带参数提交', async (t) => {
  t.after(cleanup)
  const { app, picked, submitted } = renderComposer()
  await flush()
  app.stdin.write('/compact')
  await flush()
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(picked, [], '补全不算执行')
  // 补全后输入框是 `/compact `，候选因空白收起；接着敲参数、enter 提交整行
  app.stdin.write('focus on tests')
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(submitted, ['/compact focus on tests'])
  app.unmount()
})

test('无匹配时出 muted 空行而不是假条目，enter 退回正常提交', async (t) => {
  t.after(cleanup)
  const { app, picked, submitted } = renderComposer()
  await flush()
  app.stdin.write('/zzz')
  await flush()
  const out = outputOf(app)
  assert.ok(out.includes('no matching command'), `无匹配应有提示: ${JSON.stringify(out)}`)
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(picked, [])
  assert.deepEqual(submitted, ['/zzz'], '未匹配的斜杠行原样交给上层路由')
  app.unmount()
})

test('候选列表开着时 Tab 是补全，不是切预设（回归）', async (t) => {
  t.after(cleanup)
  // ⚠️ 真踩过：会话进行中按 Tab（人是想补全命令）被预设切换吃掉，
  // 然后撞 host 的 `agent-preset-locked` 弹一条错误。
  // Tab = 补全、Enter = 执行，是 shell / 编辑器的通用习惯；
  // 弹出层开着时这一条必须**排在** tab 切预设前面。
  let cycled = 0
  let executed = 0
  const app = render(
    h(Composer, {
      onSubmit: () => {},
      onCyclePreset: () => cycled++,
      onSlashCommand: () => executed++,
      slashCommands: [
        { key: 'dsh:compact', source: 'dsh', name: 'compact', description: 'Compact history' },
      ],
    }),
  )
  await flush()
  app.stdin.write('/comp')
  await flush()
  app.stdin.write('\t')
  await flush()

  const frame = app.lastFrame() ?? ''
  assert.ok(frame.includes('/compact '), `Tab 应补全成 "/compact "：${JSON.stringify(frame.slice(0, 300))}`)
  assert.strictEqual(cycled, 0, 'Tab 在候选列表开着时绝不能去切预设')
  assert.strictEqual(executed, 0, 'Tab 只补全，不执行——执行是 Enter 的事')
  app.unmount()
})
