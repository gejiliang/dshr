/**
 * host 的发现、拉起与生命周期。
 *
 * 生命周期纪律（这条有测试）：**只有自己拉起来的 host 才关**。
 * `--connect` 给定的、或探端口时发现已经在跑的 host，退出时绝对不碰——
 * 那可能有别人正在用。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** `dsh web` 的拉起命令。可用环境变量 DSHR_DSH_COMMAND 整条覆盖（空格分隔）。 */
const DEFAULT_DSH_COMMAND = ['npx', '--yes', '@deepseek-ai/dsh@0.1.0-rc.6']

export interface HostHandle {
  readonly baseUrl: string
  /** true = 这个 host 是本进程拉起来的，退出时由我们关。 */
  readonly owned: boolean
  close(): Promise<void>
}

export type Probe = (baseUrl: string) => Promise<boolean>

/** `host.describe` 通就算活。 */
export const defaultProbe: Probe = async (baseUrl) => {
  try {
    const response = await fetch(`${baseUrl}/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'dshr-probe',
        method: 'host.describe',
        payload: {},
      }),
      signal: AbortSignal.timeout(1_500),
    })
    if (!response.ok) return false
    const body = (await response.json()) as { result?: { ok?: boolean } }
    return body.result?.ok === true
  } catch {
    return false
  }
}

export type SpawnHost = (port: number, logPath: string) => ChildProcess

function dshCommand(port: number): string[] {
  const override = process.env['DSHR_DSH_COMMAND']
  const base = override !== undefined && override !== '' ? override.split(/\s+/) : DEFAULT_DSH_COMMAND
  return [...base, 'web', '--port', String(port)]
}

/** 默认拉起：stdout/stderr 重定向到日志文件，绝不污染 TUI 画面。 */
export const defaultSpawnHost: SpawnHost = (port, logPath) => {
  const [cmd, ...args] = dshCommand(port)
  if (cmd === undefined) throw new Error('DSHR_DSH_COMMAND 为空')
  const log: WriteStream = createWriteStream(logPath, { flags: 'a' })
  const child = spawn(cmd, args, { stdio: ['ignore', log, log] })
  child.on('close', () => log.end())
  return child
}

export interface EnsureHostOptions {
  readonly port: number
  readonly probe?: Probe
  readonly spawnHost?: SpawnHost
  /** 等 host ready 的总预算，默认 60s（冷启动 npx 可能要解包）。 */
  readonly readyTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly logPath?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等子进程退出；已退出则立即返回。 */
function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

/** 关掉一个我们拉起来的 host：先 SIGTERM，3 秒不走再 SIGKILL。 */
export async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const gone = await Promise.race([waitForExit(child).then(() => true), sleep(3_000).then(() => false)])
  if (!gone) {
    child.kill('SIGKILL')
    await waitForExit(child)
  }
}

/**
 * 保证本机有一个可连的 host：先探端口，探不到就把 `dsh web` 拉起来等它 ready。
 * 返回值的 `owned` 记录了这个 host 的归属——attach 上去的 host `close()` 是 no-op。
 */
export async function ensureHost(options: EnsureHostOptions): Promise<HostHandle> {
  const probe = options.probe ?? defaultProbe
  const spawnHost = options.spawnHost ?? defaultSpawnHost
  const baseUrl = `http://127.0.0.1:${options.port}`
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000
  const pollIntervalMs = options.pollIntervalMs ?? 300
  const logPath = options.logPath ?? join(tmpdir(), `dshr-host-${options.port}.log`)

  // 已经在跑的 host：直接 attach，所有权不归我们。
  if (await probe(baseUrl)) {
    return { baseUrl, owned: false, close: () => Promise.resolve() }
  }

  const child = spawnHost(options.port, logPath)
  let childExited = false
  child.once('exit', () => {
    childExited = true
  })

  const deadline = Date.now() + readyTimeoutMs
  while (Date.now() < deadline) {
    if (childExited) {
      throw new Error(`dsh web 启动后自行退出（code ${String(child.exitCode)}）。日志: ${logPath}`)
    }
    if (await probe(baseUrl)) {
      return {
        baseUrl,
        owned: true,
        close: () => killChild(child),
      }
    }
    await sleep(pollIntervalMs)
  }
  await killChild(child)
  throw new Error(`等 dsh web ready 超时（${readyTimeoutMs}ms）。日志: ${logPath}`)
}

export interface RunServerOptions {
  readonly port: number
  readonly spawnHost?: SpawnHost
  readonly logPath?: string
}

/**
 * `dshr server`：只起 host、不开 TUI。前台运行（日志直接打出来），
 * SIGINT/SIGTERM 转发给子进程，退出码跟随它。
 */
export async function runServer(options: RunServerOptions): Promise<number> {
  const logPath = options.logPath ?? join(tmpdir(), `dshr-host-${options.port}.log`)
  if (options.spawnHost !== undefined) {
    // 测试路径：注入的 spawn 不一定是 dsh，只管生命周期。
    const child = options.spawnHost(options.port, logPath)
    return waitForExit(child).then(() => child.exitCode ?? 0)
  }
  const [cmd, ...args] = dshCommand(options.port)
  if (cmd === undefined) throw new Error('DSHR_DSH_COMMAND 为空')
  const child = spawn(cmd, args, { stdio: 'inherit' })
  const forward = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
  const onSigint = () => forward('SIGINT')
  const onSigterm = () => forward('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  try {
    await waitForExit(child)
    return child.exitCode ?? (child.signalCode !== null ? 1 : 0)
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}
