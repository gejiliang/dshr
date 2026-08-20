#!/usr/bin/env node
/**
 * 自包含的验收脚本：**不需要你先起任何东西**。
 *
 * 它自己起一个假模型端点、自己起一台 dsh host（都在临时目录、随机端口、零凭据），
 * 逐条验证下面这些断言，然后全部拆干净。任一条不成立就打印 FAIL 并以非零退出。
 *
 *   node tools/verify.mjs
 *
 * 先决条件：`pnpm install && npx tsc --build`（工具引的是构建产物，不是源码）。
 *
 * 每条断言都对应一个**真实修过的 bug**，不是凑数的冒烟：
 *   A 线协议能连上真 host 并收到流式回答
 *   B 助手回答出现在**渲染帧**里            ← 曾经完全不显示（memo + 原地改对象）
 *   C createWorkspace 幂等                  ← 曾经第二次调用就炸
 *   D 会话状态回到 idle                     ← 状态来自 host 权威事件
 */
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement as h } from 'react'
import { render } from 'ink-testing-library'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { createDshrClient } from '@dshr/protocol'
import { createState } from '@dshr/state'
import { SessionApp } from 'dshr'

const ANSWER_MARK = 'verify-marker-7391'
const results = []
const note = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const until = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log(`  (timed out waiting for ${label})`)
  return false
}

let mock
let host
let home
let client
let state
let app

try {
  console.log('起假模型端点 …')
  mock = await startMockLlmServer({
    port: 0,
    sequence: ['success'],
    repeatLast: true,
    successText: `ok ${ANSWER_MARK}`,
  })
  const mockBase = mock.baseURL.replace(/\/$/, '')
  console.log(`  ${mockBase}`)

  home = await mkdtemp(join(tmpdir(), 'dshr-verify-'))
  await writeFile(
    join(home, 'settings.yaml'),
    [
      'llm-pi-ai:',
      '  providers:',
      '    mock:',
      '      apiKeyEnv: MOCK_API_KEY', // 省了它会走 pi-ai 的环境发现，然后报 No API key
      '      api: openai-completions',
      `      baseURL: ${mockBase}/v1`,
      '      models:',
      '        - id: mock-model',
      '          contextWindow: 131072',
      '          maxTokens: 4096',
      '',
      'agent-default-model:',
      '  provider: mock',
      '  model: mock-model',
      '',
    ].join('\n'),
  )

  console.log('起 dsh host …')
  const baseUrl = await new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['--yes', '@deepseek-ai/dsh@0.1.0-rc.7', 'web', '--port', '0'],
      { env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'mock-key' }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    host = child
    const timer = setTimeout(() => reject(new Error('host 起不来（90s）')), 90_000)
    const onData = (buf) => {
      const m = /dsh web:\s*(http:\/\/\S+)/.exec(String(buf))
      if (m) {
        clearTimeout(timer)
        resolve(m[1])
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`host 提前退出（code ${code}）`)))
  })
  console.log(`  ${baseUrl}\n`)

  const cwd = process.cwd()
  client = createDshrClient({ baseUrl })
  await client.connect()
  state = createState({ client })

  // ── C：createWorkspace 幂等 ──────────────────────────────────────────
  const ws1 = await state.createWorkspace(cwd, 'dshr-verify')
  let idempotent = true
  let idemDetail = ''
  try {
    const ws2 = await state.createWorkspace(cwd, '一个完全不同的名字')
    idempotent = String(ws1) === String(ws2)
    if (!idempotent) idemDetail = '同一路径返回了不同的工作区'
  } catch (e) {
    idempotent = false
    idemDetail = String(e?.message ?? e)
  }
  note('C  createWorkspace 对同一路径幂等（第二次不炸、返回同一个）', idempotent, idemDetail)

  // ── 开一个会话并把它的 TUI 渲染出来 ─────────────────────────────────
  // dshr 就是「一个 pane 一个会话」，工作区/tab/pane 是 herdr 的活，这里没有那一层。
  const sessionId = await state.createSession({ cwd, workspaceId: ws1 })
  note('   在工作区下开出一个会话', typeof sessionId === 'string' && sessionId.length > 0)

  app = render(h(SessionApp, { state, client, sessionId, model: 'mock-model' }))

  const conv = state.conversation(sessionId)
  const answer = () =>
    conv.items.filter((i) => i.kind === 'assistant').map((i) => i.text).join('')

  await state.prompt(sessionId, 'say the marker')

  // ── A：流式回答进到会话模型 ─────────────────────────────────────────
  const inModel = await until(() => answer().includes(ANSWER_MARK), 40_000, '回答进入会话模型')
  note('A  线协议连上真 host 并收到流式回答', inModel)

  // ── B：而且真的出现在渲染帧里 ───────────────────────────────────────
  // 断言用一个只可能来自回答的随机串——用 "mock" 之类会被侧栏标题/模型名匹配到，那是假绿。
  const inFrame = await until(
    () => (app.lastFrame() ?? '').includes(ANSWER_MARK),
    40_000,
    '回答出现在渲染帧',
  )
  note('B  回答出现在**渲染帧**里（曾经完全不显示）', inFrame)

  // ── D：一轮结束回到 idle ────────────────────────────────────────────
  const backToIdle = await until(
    () => state.sessions.get(sessionId)?.status === 'idle',
    40_000,
    '会话回到 idle',
  )
  note('D  会话状态回到 idle（判据来自 host 权威事件）', backToIdle)

  console.log('\n── 渲染出来的那一帧（自己看一眼）──\n')
  console.log(app.lastFrame())
} catch (error) {
  note('验收中断', false, String(error?.message ?? error))
} finally {
  try { app?.unmount() } catch {}
  try { await state?.dispose() } catch {}
  try { await client?.close() } catch {}
  try { host?.kill() } catch {}
  try { await mock?.close() } catch {}
  if (home) await rm(home, { recursive: true, force: true }).catch(() => {})
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 条不成立`}：${results.length} 条断言`)
process.exit(failed.length === 0 ? 0 : 1)
