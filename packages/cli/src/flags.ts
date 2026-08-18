/**
 * `dshr` 的旗标解析。纯函数，不碰进程——`main` 把 FlagError 折算成退出码 2。
 *
 * 形态见 docs/profile.md 的「三种进程形态」：
 *   dshr                        连本机 host；没有就自己拉一个，然后开 TUI
 *   dshr --connect <url>        只开 TUI，attach 到已有 host（**只接受 loopback**）
 *   dshr --resume <sessionId>   直接打开某个已存在的会话
 */

export const DEFAULT_PORT = 39080

export const USAGE = `dshr — dsh 的终端 surface

用法:
  dshr                        跑 dsh --profile dshr：一个进程、零端口、界面在插件里
  dshr --connect <url>        attach 到已在跑的 host（目前只接受 loopback 地址）
  dshr --resume <sessionId>   启动后直接打开这个已存在的会话
  dshr --help                 显示本帮助
`

export class FlagError extends Error {
  override readonly name = 'FlagError'
}

export type ParsedFlags =
  | { readonly mode: 'help' }
  | {
      readonly mode: 'tui'
      readonly connect?: string
      readonly resume?: string
    }

/** `--connect` 目前只接受 loopback：dsh 的 /api 信任栅栏不是认证（docs/profile.md 安全节）。 */
export function assertLoopbackUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new FlagError(`--connect 的值不是合法 URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FlagError(`--connect 只支持 http/https URL: ${raw}`)
  }
  const host = url.hostname
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  if (!loopback) {
    throw new FlagError(
      `--connect 目前只接受 loopback 地址（收到 ${host}）。\n` +
        'dsh 的 /api 信任栅栏是可达性策略、不是认证；远程 attach 要等 dshr 自带认证层之后才开。',
    )
  }
  return url.origin
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new FlagError(`--port 需要 1-65535 的整数，收到: ${value}`)
  }
  return port
}

/** 取旗标值：支持 `--flag value` 与 `--flag=value` 两种写法。 */
function takeValue(argv: readonly string[], index: number, inline: string | undefined, flag: string): { value: string; next: number } {
  if (inline !== undefined) {
    if (inline === '') throw new FlagError(`${flag} 需要一个值`)
    return { value: inline, next: index + 1 }
  }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new FlagError(`${flag} 需要一个值`)
  }
  return { value, next: index + 2 }
}

export function parseFlags(argv: readonly string[]): ParsedFlags {
  let help = false
  let connect: string | undefined
  let resume: string | undefined

  let i = 0
  while (i < argv.length) {
    const arg = argv[i] ?? ''
    if (arg === '--help' || arg === '-h') {
      help = true
      i += 1
      continue
    }
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    switch (flag) {
      case '--connect': {
        const taken = takeValue(argv, i, inline, '--connect')
        if (connect !== undefined) throw new FlagError('--connect 给了两次')
        connect = assertLoopbackUrl(taken.value)
        i = taken.next
        break
      }
      case '--resume': {
        const taken = takeValue(argv, i, inline, '--resume')
        if (resume !== undefined) throw new FlagError('--resume 给了两次')
        resume = taken.value
        i = taken.next
        break
      }
      default:
        throw new FlagError(`不认识的参数: ${arg}`)
    }
  }

  if (help) return { mode: 'help' }
  return {
    mode: 'tui',
    ...(connect !== undefined ? { connect } : {}),
    ...(resume !== undefined ? { resume } : {}),
  }
}
