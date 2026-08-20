/**
 * 把 dshr 装成一个 dsh profile，然后**交给 dsh 去跑**。
 *
 * dshr 是 dsh 的 TUI 插件，遵循 dsh「一切皆插件」的逻辑：往 dsh 加一个 surface
 * 的办法是往插件图里贡献一行，不是在外面另写一个会说它线协议的程序。
 * 所以裸跑 `dshr` = `dsh --profile dshr`，界面由 `@dshr/bundle` 的
 * `startSurface` 在**同一个进程**里挂起来（零端口、零 socket）。
 *
 * 这里只做两件事：
 *
 * 1. 确保 `$DSH_HOME/profiles/dshr/` 存在且指向本仓库的 bundle（幂等）
 * 2. exec `dsh --profile dshr`，stdio 直通——TUI 要的是真 tty
 *
 * ⚠️ **不碰 `--connect`**。远程 attach 不该起本地 host plane：profile 会无条件
 * 挂一整套 storage / agent / sessions，attach 到别人 host 的时候那套完全用不上，
 * 还会和目标 host 抢同一个 `$DSH_HOME/sessions`。那条路留在 `main.tsx` 里，
 * 用 HTTP carrier + 同一个 `@dshr/surface`。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** profile 名。dsh 按 `$DSH_HOME/profiles/<name>` 找。 */
export const PROFILE_NAME = 'dshr'

/** 没有 `DSHR_DSH_COMMAND` 时怎么拉起 dsh。 */
const DEFAULT_DSH_COMMAND = ['npx', '--yes', '@deepseek-ai/dsh@0.1.0-rc.8']

export function dshHome(): string {
  const configured = process.env['DSH_HOME']
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/** 本仓库 `packages/bundle` 的绝对路径（从本文件的位置推，装到哪都对）。 */
export function bundleDir(): string {
  // lib/profile.js → packages/cli/lib → packages/cli → packages
  return join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'bundle')
}

/**
 * 幂等地把 profile 目录准备好。
 *
 * `bundles` 里的名字**先**从 dsh 安装目录解析（只有 dsh-base / dsh-web-app /
 * dsh-headless 在那儿），**再**从 profile 自己的 `node_modules`——所以这里把仓库里的
 * bundle 软链进去就够了，**不需要碰 dsh 本体**。
 */
export function ensureProfile(home: string = dshHome()): string {
  const profile = join(home, 'profiles', PROFILE_NAME)
  const modules = join(profile, 'node_modules', '@dshr')
  mkdirSync(modules, { recursive: true })

  const template = join(bundleDir(), 'profile-template')
  for (const file of ['package.json', 'cordis.yml', 'pnpm-workspace.yaml']) {
    const target = join(profile, file)
    // 只在缺失时写：`cordis.patch.yml` 是**人自己的 patch 层**，永远不覆盖。
    if (!existsSync(target)) writeFileSync(target, readFileSync(join(template, file)))
  }
  const userPatch = join(profile, 'cordis.patch.yml')
  if (!existsSync(userPatch)) writeFileSync(userPatch, readFileSync(join(template, 'cordis.patch.yml')))

  // 软链指向仓库里的 bundle。已经指对了就不动——重复 symlink 会抛 EEXIST。
  const link = join(modules, 'bundle')
  const want = bundleDir()
  let current: string | undefined
  try {
    current = realpathSync(link)
  } catch {
    current = undefined
  }
  if (current !== realpathSync(want)) {
    rmSync(link, { recursive: true, force: true })
    symlinkSync(want, link, 'dir')
  }
  return profile
}

function dshCommand(): string[] {
  const override = process.env['DSHR_DSH_COMMAND']
  return override !== undefined && override !== '' ? override.split(/\s+/) : DEFAULT_DSH_COMMAND
}

export interface RunProfileOptions {
  readonly resume?: string
  /** 测试注入用。 */
  readonly spawnFn?: (cmd: string, args: readonly string[]) => ChildProcess
}

/**
 * 跑 `dsh --profile dshr`，把这个终端交给它。
 *
 * `stdio: 'inherit'` 是硬要求：TUI 要真 tty，中间夹一层管道 ink 就拿不到尺寸、
 * 也进不了 raw mode。信号照转，Ctrl-C 由子进程里的 ink 自己处理。
 */
export async function runProfile(options: RunProfileOptions = {}): Promise<number> {
  ensureProfile()
  const [cmd, ...base] = dshCommand()
  if (cmd === undefined) throw new Error('DSHR_DSH_COMMAND 为空')
  const args = [...base, '--profile', PROFILE_NAME]
  if (options.resume !== undefined) args.push('--resume', options.resume)

  const child =
    options.spawnFn !== undefined
      ? options.spawnFn(cmd, args)
      : spawn(cmd, args, { stdio: 'inherit' })

  const forward = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
  const onSigint = (): void => forward('SIGINT')
  const onSigterm = (): void => forward('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  try {
    await new Promise<void>((resolve) => {
      child.once('close', () => resolve())
      child.once('error', () => resolve())
    })
    return child.exitCode ?? (child.signalCode !== null ? 1 : 0)
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}
