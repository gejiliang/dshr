/**
 * E 批对话框的验收：纯构建器（dialog-data）+ LazyDialogSelect + DialogPrompt
 *（goal-create 收 objective 用的是 C 批的 DialogPrompt，单行输入框只有这一个实现）
 * + Sidebar 的 Goal 块。数据全是手工夹具——**不打真 host**（settings/credentials
 * 对着活 host 只能调只读方法，测试连只读都不调，直接喂形状）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import './force-color.ts'
import { fg, flush } from './helpers.ts'
import {
  DialogPrompt,
  LazyDialogSelect,
  Sidebar,
  credentialOptions,
  modelOptions,
  providerOptions,
  settingsOptions,
  theme,
} from '../lib/index.js'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'

const GRAY = fg(theme.textMuted)
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

// ---- 纯构建器 ----

test('settingsOptions：命名空间一行，applies/secrets/user 覆盖都进 muted 说明', () => {
  const options = settingsOptions({
    writable: true,
    hasDocument: true,
    namespaces: [
      { ns: 'llm-deepseek', schema: {}, value: {}, applies: 'restart', secrets: [{ path: ['apiKey'], set: true }], revision: 4 },
      { ns: 'ui-onboarding', schema: {}, value: {}, user: { welcomeNoticeVersion: '1' }, applies: 'live', secrets: [], revision: 0 },
    ],
  } as never)
  assert.equal(options.length, 2)
  assert.equal(options[0]?.title, 'llm-deepseek')
  assert.equal(options[0]?.category, 'Namespaces')
  assert.ok(options[0]?.label?.includes('⚠ applies on restart'))
  assert.ok(options[0]?.label?.includes('1/1 secrets set'))
  assert.equal(options[0]?.footer, 'rev 4')
  assert.ok(options[1]?.label?.includes('applies live'))
  assert.ok(options[1]?.label?.includes('user overrides'))
  assert.ok(!options[1]?.label?.includes('secrets'))
})

test('credentialOptions：配了的画 ● 进 Configured，没配的进 Missing；read-only 进 footer', () => {
  const options = credentialOptions([
    { ref: 'MOCK_API_KEY', configured: true, source: 'env', writable: true, holders: ['mock', 'llm-pi-ai'] },
    { ref: 'DEEPSEEK_API_KEY', configured: false, writable: false, holders: ['web-search-deepseek'] },
  ])
  assert.equal(options[0]?.current, true)
  assert.equal(options[0]?.category, 'Configured')
  assert.ok(options[0]?.label?.includes('configured via env'))
  assert.ok(options[0]?.label?.includes('mock, llm-pi-ai'))
  assert.equal(options[1]?.category, 'Missing')
  assert.equal(options[1]?.current, undefined)
  assert.ok(options[1]?.label?.includes('not configured'))
  assert.equal(options[1]?.footer, 'read-only')
})

test('providerOptions：displayName 标题、provider muted、active 画 ● 进 Active 分组', () => {
  const options = providerOptions([
    { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
    { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false, declared: false },
  ])
  assert.equal(options[0]?.title, 'DeepSeek')
  assert.equal(options[0]?.label, 'deepseek-official')
  assert.equal(options[0]?.category, 'Active')
  assert.equal(options[0]?.current, true)
  assert.equal(options[1]?.category, 'Available')
  assert.equal(options[1]?.current, undefined)
  assert.ok(options[1]?.label?.includes('not declared'))
})

test('modelOptions：分组 = provider 显示名；failures 进 Failures；id≠name 时才带 muted id', () => {
  const options = modelOptions({
    groups: [
      {
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
          { id: 'mock-model', name: 'mock-model' },
        ],
      },
    ],
    failures: [{ id: 'openai', name: 'OpenAI', message: 'connection refused and a very long tail that should be truncated somewhere along the way' }],
  } as never)
  assert.equal(options.length, 3)
  assert.equal(options[0]?.title, 'DeepSeek-V4-Flash')
  assert.equal(options[0]?.label, 'deepseek-v4-flash')
  assert.equal(options[0]?.category, 'DeepSeek')
  assert.equal(options[1]?.label, undefined) // id === name 时不重复
  assert.equal(options[2]?.category, 'Failures')
  assert.ok((options[2]?.label?.length ?? 0) <= 60)
})

// ---- LazyDialogSelect ----

test('LazyDialogSelect：loading → 数据到了渲染列表；esc 关闭', async (t) => {
  t.after(cleanup)
  let closed = false
  const app = render(
    h(LazyDialogSelect, {
      title: 'Providers',
      load: async () => {
        await flush(5)
        return providerOptions([
          { provider: 'mock', displayName: 'Mock', settingsNs: 'llm-pi-ai', settingsPath: [], active: true },
        ])
      },
      onClose: () => {
        closed = true
      },
    }),
  )
  await flush(30)
  const frames = app.frames.join('\n')
  assert.ok(frames.includes('Loading…'), '取数中应出现过 Loading')
  const frame = app.lastFrame() ?? ''
  assert.ok(frame.includes('Mock'), '数据到了应渲染条目')
  assert.ok(frame.includes('●'), 'active 应有 ●')
  app.stdin.write('\x1b') // esc
  await flush()
  assert.ok(closed, 'esc 应触发 onClose')
  app.unmount()
})

test('LazyDialogSelect：取数失败画可读错误行（不静默），note 也在', async (t) => {
  t.after(cleanup)
  const app = render(
    h(LazyDialogSelect, {
      title: 'Settings',
      load: async () => {
        throw new Error('settings.describe failed: loopback-only: nope')
      },
      onClose: () => {},
      note: 'Read-only view',
    }),
  )
  await flush()
  const frame = app.lastFrame() ?? ''
  assert.ok(frame.includes('settings.describe failed'), '失败原因要画出来')
  assert.ok((frame.split('\n').find((l) => l.includes('settings.describe failed')) ?? '').includes(fg(theme.error)), '错误行应 error 色')
  assert.ok(frame.includes('Read-only view'), 'note 应在')
  app.unmount()
})

// ---- DialogPrompt（goal-create 的 objective 输入框走它）----

test('DialogPrompt：输入 + 回车提交（trim）；空串不提交；esc 取消', async (t) => {
  t.after(cleanup)
  const submitted: string[] = []
  let cancelled = false
  const app = render(
    h(DialogPrompt, {
      title: 'Create goal',
      placeholder: 'Objective',
      onSubmit: (text: string) => submitted.push(text),
      onCancel: () => {
        cancelled = true
      },
    }),
  )
  await flush()
  assert.ok((app.lastFrame() ?? '').includes('Objective'), '应有占位符')
  app.stdin.write('\r') // 空串回车：不提交
  await flush()
  assert.equal(submitted.length, 0)
  app.stdin.write('ship the batch')
  await flush()
  assert.ok((app.lastFrame() ?? '').includes('ship the batch'), '输入应回显')
  app.stdin.write('\r')
  await flush()
  assert.deepEqual(submitted, ['ship the batch'])
  app.stdin.write('\x1b')
  await flush()
  assert.ok(cancelled, 'esc 应触发 onCancel')
  app.unmount()
})

// ---- Sidebar 的 Goal 块 ----

test('Sidebar：有目标时画 Goal 块（objective + phase + 轮次），没有时不画', async (t) => {
  t.after(cleanup)
  const withGoal = render(
    h(Sidebar, {
      title: 's',
      goal: { objective: 'ship E batch', phase: 'blocked', blockedReason: 'round limit', roundsStarted: 3, maxGoalRounds: 3 },
    }),
  )
  await flush()
  const frame = stripAnsi(withGoal.lastFrame() ?? '')
  assert.ok(frame.includes('Goal'))
  assert.ok(frame.includes('ship E batch'))
  assert.ok(frame.includes('blocked · round 3/3'))
  assert.ok(frame.includes('round limit'))
  // blocked 用 error 色
  const raw = withGoal.lastFrame() ?? ''
  assert.ok((raw.split('\n').find((l) => l.includes('blocked')) ?? '').includes(fg(theme.error)))
  withGoal.unmount()

  const without = render(h(Sidebar, { title: 's' }))
  await flush()
  assert.ok(!stripAnsi(without.lastFrame() ?? '').includes('Goal'))
  without.unmount()
})

// ---- 颜色常量使用（防止 tree-shake 误报）----
test(' GRAY 常量参与断言环境', () => {
  assert.ok(GRAY.startsWith('\x1b['))
})
