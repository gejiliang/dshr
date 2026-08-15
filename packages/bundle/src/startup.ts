/**
 * `@dshr/bundle/startup` — the dshr app's command-line provider.
 *
 * Parses the `dsh --profile dshr` flag family (`--host`, `--port`,
 * `--connect`, `--resume`) and its `--help` text, then provides the
 * immutable values as {@link DSHR_STARTUP_SERVICE}. Flag-configured rows
 * inject that service, so Loader resolves their expressions only after it
 * exists. Mirrors `@deepseek-ai/dsh-web-app/startup`.
 *
 * `--host 0.0.0.0` is rejected before anything is provided: the dsh `/api`
 * trust fence is a reachability policy, not authentication, and no dshr
 * surface may expose a bind on all interfaces until dshr ships its own auth
 * layer (see docs/profile.md,「安全」一节).
 */
import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'dshr-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const DSHR_STARTUP_SERVICE = 'dshrStartup'

/** The parsed invocation, published as the `dshrStartup` service. */
export interface DshrStartup {
  /** Host bind host; absent when the flag was not passed. */
  host?: string
  /** Host listen port; absent when the flag was not passed. */
  port?: number
  /** Attach target URL for client-only mode; absent when the flag was not passed. */
  connect?: string
  /** Session to open directly; absent when the flag was not passed. */
  resume?: string
}

/** The webserver schema's all-interfaces bind literal; intentionally unsupported. */
const ALL_INTERFACES_HOST = '0.0.0.0'

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
export function dshrCommand(): Command {
  return new Command()
    .name('dsh --profile dshr')
    .description('Open the dshr terminal surface over the dsh host plane.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'host bind host (loopback only; there is no authentication layer)')
    .option('--port <port>', 'host listen port; pass 0 to let the OS pick a free one')
    .option('--connect <url>', 'attach to an already-running host instead of composing one in-process')
    .option('--resume <sessionId>', 'open an existing session directly (sessions are durable)')
    .addHelpText('after', `
Examples:
  dsh --profile dshr                                 single process: host plane + terminal UI, no port
  dsh --profile dshr --port 39080                    pin the host port
  dsh --profile dshr --connect http://127.0.0.1:39080  attach to a running host
  dsh --profile dshr --resume session-<id>           reopen a durable session
`)
}

/**
 * Parse and provide the dshr invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; `--host
 * 0.0.0.0`, a non-numeric `--port`, and `--connect` mixed with `--host` /
 * `--port` are usage errors, so on rejection (and on `--help`) nothing is
 * provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = dshrCommand()
  program.action(() => {
    const options = program.opts<{ host?: string; port?: string; connect?: string; resume?: string }>()
    if (options.host === ALL_INTERFACES_HOST) {
      program.error(
        'error: --host 0.0.0.0 is intentionally not supported for safety: the /api trust fence is a reachability policy, not authentication; dshr binds loopback only until it ships its own auth layer',
      )
    }
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    if (options.connect !== undefined && (options.host !== undefined || options.port !== undefined)) {
      program.error('error: --connect attaches to a running host while --host/--port configure one; pass one family, not both')
    }
    const startup: DshrStartup = {
      ...options.host !== undefined && { host: options.host },
      ...options.port !== undefined && { port: Number(options.port) },
      ...options.connect !== undefined && { connect: options.connect },
      ...options.resume !== undefined && { resume: options.resume },
    }
    ctx.provide(DSHR_STARTUP_SERVICE, startup)
  })
  parseCmdline(ctx, program)
}
