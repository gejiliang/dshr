#!/usr/bin/env node
/**
 * D 批的端到端验收：自包含，不需要先起任何东西（假模型、host 都在临时目录
 * 随机端口起，验完全部拆掉）。与 tools/verify.mjs 同一套纪律：
 * 每条断言对应一个真行为，任一条不成立就非零退出。
 *
 *   node tools/verify-batch-d.mjs
 *
 * 验的：
 *   1. 后台任务：mock 让 bash run_in_background → session/jobs 帧进 summary，
 *      底部栏出现 ◆ chip，命令面板 `View background jobs` 列出任务（截屏 1）
 *   2. 技能：会话 cwd 下的 .dsh/skills/ 被 skill.list 列出，
 *      命令面板 `View skills` 打开列表（截屏 2）
 *   3. 队列 remove：turn 还在跑时第二条 prompt 排队 → ctrl+x 打开队列对话框
 *      → enter 删除 → session/queue 空快照回来（真实操作证据）
 *   4. 附件：真发一张 png 给 host（session.prompt 的 content 带 image 块，
 *      host 收下并引用它）；超限在提交前被 checkImageLimits 拒掉
 *
 * 先决条件：pnpm install && npx tsc --build（引的是构建产物）。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement as h } from 'react'
import { render } from 'ink-testing-library'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { createDshrClient } from '@dshr/protocol'
import { checkImageLimits, createState, imageLimitsFromProjection, readImageDraft } from '@dshr/state'
import { SessionApp } from 'dshr'

const results = []
const note = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const until = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log(`  (timed out waiting for ${label})`)
  return false
}
const settle = async (ms = 150) => new Promise((r) => setTimeout(r, ms))

let mock
let host
let home
let work
let client
let state
let app

try {
  console.log('起假模型端点（第一轮起后台任务，第三轮 stall 撑住轮次给排队留窗口）…')
  mock = await startMockLlmServer({
    port: 0,
    // ⚠️ mock 的行为序列按请求到达顺序消费，而**标题生成也会发一次 LLM 请求**
    // （实测：第一轮结束后 session-title 消费了一格，側栏标题就是它回的 "ok d-batch"）。
    // 所以第 2、3 格都垫 success，用 `mock.requests.length >= 3` 等它们都落定了
    // 再开第二个 turn——第 4 格的 stall 才确定落在第二个 turn 头上。
    sequence: ['tool_call_success', 'success', 'success', 'stall', 'success'],
    repeatLast: true,
    successText: 'ok d-batch',
    toolName: 'bash',
    // bash 工具的 description 是必填参数（不带给的是 INVALID_ARGS，踩过）。
    toolArguments: '{"command":"sleep 12","run_in_background":true,"description":"background sleep"}',
  })
  const mockBase = mock.baseURL.replace(/\/$/, '')
  console.log(`  ${mockBase}`)

  home = await mkdtemp(join(tmpdir(), 'dshr-d-home-'))
  await writeFile(
    join(home, 'settings.yaml'),
    [
      'llm-pi-ai:',
      '  providers:',
      '    mock:',
      '      apiKeyEnv: MOCK_API_KEY',
      '      api: openai-completions',
      `      baseURL: ${mockBase}/v1`,
      '      models:',
      '        - id: mock-model',
      '          contextWindow: 131072',
      '          maxTokens: 4096',
      // 不声明 image 输入模态，host 在 prompt 准入时就拒图片
      // （attachment-error: Model does not support image input，实测）。
      '          input: [text, image]',
      '',
      'agent-default-model:',
      '  provider: mock',
      '  model: mock-model',
      '',
    ].join('\n'),
  )

  // 会话 cwd：临时目录里放一个项目级技能，skill.list 才有东西可列。
  work = await mkdtemp(join(tmpdir(), 'dshr-d-work-'))
  await mkdir(join(work, '.dsh/skills/verify-skill'), { recursive: true })
  await writeFile(
    join(work, '.dsh/skills/verify-skill/SKILL.md'),
    ['---', 'name: verify-skill', 'description: D 批验收用的假技能', '---', '', '什么都没用。', ''].join('\n'),
  )

  console.log('起 dsh host …')
  const baseUrl = await new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', '@deepseek-ai/dsh@0.1.0-rc.6', 'web', '--port', '0'], {
      env: { ...process.env, DSH_HOME: home, MOCK_API_KEY: 'mock-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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

  client = createDshrClient({ baseUrl })
  await client.connect()
  state = createState({ client })

  // 如果 bash 工具要审批，自动放行（后台 sleep 是无害命令）。
  client.onMuxFrame((frame, rpcId) => {
    if (frame.type === 'approval/requested') {
      void client.respond(rpcId, {
        ok: true,
        value: { sessionId: frame.sessionId, approvalId: frame.approvalId, outcome: 'allowed-once' },
      })
    }
  })

  const sessionId = await state.createSession({ cwd: work })
  app = render(h(SessionApp, { state, client, sessionId, model: 'mock-model' }))
  await settle()

  // ── 1. 后台任务 ────────────────────────────────────────────────────
  await state.prompt(sessionId, 'start a background job')
  const jobsSeen = await until(
    () => (state.sessions.get(sessionId)?.jobs ?? []).some((j) => j.status === 'running'),
    40_000,
    'session/jobs 里出现 running 的任务',
  )
  note('1a session/jobs 帧进 summary（有 running 的后台任务）', jobsSeen)

  const chipSeen = await until(() => (app.lastFrame() ?? '').includes('job running'), 10_000, '底部栏 jobs chip')
  note('1b 底部栏出现 ◆ N job(s) running chip', chipSeen)

  // 命令面板 → View background jobs（真实按键路径：ctrl+p，打字，enter）
  app.stdin.write('\x10')
  await settle()
  app.stdin.write('jobs')
  await settle()
  app.stdin.write('\r')
  await settle(400)
  const jobsFrame = app.lastFrame() ?? ''
  const jobsDialogOk = jobsFrame.includes('Background jobs') && jobsFrame.includes('sleep 12') && jobsFrame.includes('bash')
  note('1c 命令面板 View background jobs 列出任务（label + kind + 耗时）', jobsDialogOk)
  console.log('\n── 截屏 1：Background jobs ──\n')
  console.log(jobsFrame)
  app.stdin.write('\x1b') // esc 关对话框
  await settle()

  // ── 2. 技能 ────────────────────────────────────────────────────────
  app.stdin.write('\x10')
  await settle()
  app.stdin.write('skills')
  await settle()
  app.stdin.write('\r')
  const skillsSeen = await until(() => (app.lastFrame() ?? '').includes('verify-skill'), 15_000, '技能列表出现 verify-skill')
  note('2  命令面板 View skills 列出项目技能（skill.list）', skillsSeen)
  console.log('\n── 截屏 2：Skills ──\n')
  console.log(app.lastFrame())
  app.stdin.write('\x1b')
  await settle()

  // ── 3. 队列 remove ─────────────────────────────────────────────────
  // 先等标题生成把第 3 格 success 消费掉（不然第 4 格的 stall 落不到第二个 turn 头上）。
  const titleSettled = await until(() => mock.requests.length >= 3, 20_000, '标题生成的 LLM 请求落定')
  note('3a 标题请求落定（mock 已消费 3 格行为）', titleSettled)
  // 第二轮：mock 序列里的 stall 让这个 turn 永远跑不完，第三条 prompt 才会排队。
  await state.prompt(sessionId, 'stall this turn')
  const stalled = await until(() => state.sessions.get(sessionId)?.status === 'working', 20_000, '第二轮开跑')
  note('3b stall 的轮次跑起来了', stalled)
  await state.prompt(sessionId, 'this one waits in the queue')
  const queued = await until(() => (state.sessions.get(sessionId)?.queue ?? []).length > 0, 20_000, '第二条消息进队列')
  note('3c 轮次还在跑时第二条 prompt 排进队列（session/queue）', queued)

  // 等渲染提交（frame 里出现 QUEUED 微章）再按键——state 先变、React 后画，
  // ctrl+x 的门禁读的是渲染期镜像的 ref，抢在提交前按键会被当成「队列是空」拦掉。
  await until(() => (app.lastFrame() ?? '').includes('QUEUED'), 10_000, 'QUEUED 微章画出来')

  // ctrl+x 打开队列对话框，enter 删掉它——这是 session.updateQueue remove 的真实按键路径。
  app.stdin.write('\x18')
  await settle(300)
  const queueDialog = app.lastFrame() ?? ''
  note('3d ctrl+x 打开队列管理对话框并列出排队消息', queueDialog.includes('Remove queued message') && queueDialog.includes('this one waits'))
  console.log('\n── 截屏 3：Remove queued message ──\n')
  console.log(queueDialog)
  app.stdin.write('\r')
  // 关键：队列清空时第二轮**还在 stall**——条目是被 remove 掉的，不是被认领跑的。
  const removed = await until(
    () =>
      (state.sessions.get(sessionId)?.queue ?? []).length === 0 &&
      state.sessions.get(sessionId)?.status === 'working',
    15_000,
    '队列空快照回来（且轮次仍在跑）',
  )
  note('3e enter 删除后 host 推回空的 session/queue，轮次仍在 stall（是真删除，不是被认领）', removed)
  app.stdin.write('\x1b')
  await settle()

  // 收掉还在跑的第一轮，免得拖住清理。
  await state.cancel(sessionId)

  // ── 4. 附件 ────────────────────────────────────────────────────────
  // 4a. 真发一张 png：host 收下字节并在会话里引用它（attachmentId 进日志）。
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  )
  await writeFile(join(work, 'tiny.png'), png)
  const draft = await readImageDraft(join(work, 'tiny.png'))
  note('4a 读本地 png 成 draft（1×1，image/png）', draft.mediaType === 'image/png' && draft.width === 1 && draft.height === 1)

  const limits = imageLimitsFromProjection(state.projections(sessionId).get('imageLimits'))
  note('4b imageLimits 投影存在（部署装了附件服务）', limits !== undefined, limits ? `maxImageBytes=${limits.maxImageBytes}` : undefined)

  await state.prompt(sessionId, 'see the attached image', [draft])
  const attached = await until(
    async () => {
      const history = await client.call('session.history', { sessionId })
      if (!history.ok) return false
      return history.value.events.some((e) =>
        JSON.stringify(e.event).includes('"attachmentId"'),
      )
    },
    40_000,
    'host 把图片转成持久引用写进会话日志',
  )
  note('4c 图片随 session.prompt 发出，host 转成持久引用（attachmentId 进日志）', attached)

  // 4d. 超限在提交前被拒：拿真实投影的限额，把 maxImageBytes 缩到比这张图还小，
  //     checkImageLimits 必须拦下——这正是 SessionApp 提交前跑的那一道。
  const tight = { ...(limits ?? { maxImagesPerMessage: 4, maxMessageImageBytes: 1 << 20, maxImagePixels: 1 << 24, mediaTypes: ['image/png'] }), maxImageBytes: draft.bytes - 1 }
  const problem = checkImageLimits([draft], tight)
  note('4d 超限在提交前被拒（checkImageLimits 拦下，不发出去）', typeof problem === 'string' && problem.includes('Image too large'), problem)

  console.log('\n── 最终一帧（自己看一眼）──\n')
  console.log(app.lastFrame())
} catch (error) {
  note('验收中断', false, String(error?.stack ?? error))
} finally {
  try { app?.unmount() } catch {}
  try { await state?.dispose() } catch {}
  try { await client?.close() } catch {}
  try { host?.kill() } catch {}
  try { await mock?.close() } catch {}
  if (home) await rm(home, { recursive: true, force: true }).catch(() => {})
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {})
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 条不成立`}：${results.length} 条断言`)
process.exit(failed.length === 0 ? 0 : 1)
