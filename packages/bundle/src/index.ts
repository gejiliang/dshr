/**
 * `@dshr/bundle` — the dshr app plugin: consumes the parsed flags through
 * this row's config, provides them as the {@link DSHR_RUNTIME_SERVICE}
 * service, prints one startup line once the Loader tree settles, and owns
 * the surface seam ({@link startSurface}) the TUI later plugs into.
 *
 * This version deliberately mounts no TUI and no webserver row: the default
 * shape is one process with the host plane composed in-process and no port.
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// Type-only import: erased by both tsc and node's type stripping, so tests
// can load this module straight from src without a build step.
import type { DshrStartup } from './startup.js'

/** Stable Cordis plugin name. */
export const name = 'dshr-app'

/**
 * Plugin-level injection: `apiProxy` — the host's dispatch face, provided by
 * the `api-gateway` row (`@deepseek-ai/dsh-host-apiproxy`). The surface talks
 * to the host plane through it, in-process, with no port and no socket.
 *
 * The Loader row separately carries `inject: [dshrStartup]` so its lazy config
 * expressions resolve only after `dshr-startup` has provided the parsed flags.
 * Row-level and plugin-level injection are different lists on purpose: the
 * former gates config evaluation, the latter gates the plugin body.
 */
export const inject: string[] = ['apiProxy']

/** Runtime service holding the resolved invocation values. */
export const DSHR_RUNTIME_SERVICE = 'dshrRuntime'

/**
 * The validated row config. Schemastery fields are optional unless marked
 * `.required()` (there is no `.optional()`); the explicit `.required(false)`
 * below states the same contract as {@link DshrAppConfig} — every key may be
 * absent, because the patch's `!!js ctx.dshrStartup.*` expressions evaluate
 * to `undefined` when the corresponding flag was not passed.
 */
export const Config = z.object({
  host: z.string().required(false),
  port: z.natural().required(false),
  connect: z.string().required(false),
  resume: z.string().required(false),
})

/** Shape of the validated {@link Config}; mirrors the patch row's keys. */
export interface DshrAppConfig {
  host?: string
  port?: number
  connect?: string
  resume?: string
}

/** The resolved invocation, published as the `dshrRuntime` service. */
export interface DshrRuntime {
  /** Host bind host (loopback only until dshr ships an auth layer). */
  host: string
  /** Host listen port. */
  port: number
  /** Attach target URL when attaching to a running host. */
  connect?: string
  /** Session to open directly. */
  resume?: string
}

/** What a mounted surface returns to the app plugin. */
export interface SurfaceHandle {
  close(): Promise<void>
}

/** Options handed to a surface at mount time. */
export interface SurfaceOptions {
  runtime: DshrRuntime
}

/**
 * The surface seam. The TUI (written against `@dshr/shell` + `@dshr/tui`)
 * replaces this stub; wiring it in should touch only this function. The stub
 * mounts nothing and reports that fact through its return value.
 * @param ctx - the app plugin's context.
 * @param options - the resolved runtime the surface renders over.
 * @returns the mounted surface's handle, or `undefined` while no surface exists.
 */
export async function startSurface(ctx: Context, options: SurfaceOptions): Promise<SurfaceHandle | undefined> {
  // `--connect <url>` 明确要求接一台别人的 host：那条路走网络 carrier，不在这里。
  if (options.runtime.connect !== undefined) return undefined

  // 进程内 carrier：`ctx.apiProxy` 由 `api-gateway` 行提供（插件级 inject 已声明）。
  // 上游注释：`new InProcessApiClient(toFetchHandler(api))` never touches the network。
  if (ctx.apiProxy === undefined) {
    // 说人话，别抛 TypeError：profile 少了一行是最容易犯的错，而
    // `--dump-config` 看不出来（组合阶段不检查服务依赖，见 docs/profile.md）。
    throw new Error(
      'dshr: ctx.apiProxy is missing — the profile has no `api-gateway` row ' +
        "(name: '@deepseek-ai/dsh-host-apiproxy'). See docs/profile.md.",
    )
  }
  const { createInProcessClient } = await import('@dshr/protocol')
  const client = createInProcessClient({ api: ctx.apiProxy })
  await client.connect()

  const description = client.state.status === 'ready' ? client.state.host : undefined
  process.stderr.write(
    `dshr: in-process carrier ready (${description?.provider ?? '?'}/${description?.model ?? '?'})\n`,
  )

  return {
    async close() {
      await client.close()
    },
  }
}

/**
 * Mount the dshr app: provide `dshrRuntime`, print one line after the Loader
 * tree settles, and go through the surface seam.
 * @param ctx - plugin context.
 * @param config - validated row config (flags already folded in by the patch's
 *   `!!js ctx.dshrStartup.*` expressions).
 */
export function apply(ctx: Context, config: DshrAppConfig): void {
  const runtime: DshrRuntime = {
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 39080,
    ...config.connect !== undefined && { connect: config.connect },
    ...config.resume !== undefined && { resume: config.resume },
  }
  ctx.provide(DSHR_RUNTIME_SERVICE, runtime)

  // ⚠️ **必须接住**。`startSurface` 现在真的会做事（建进程内 carrier、连 host），
  // 也就真的会失败。裸的 `void startSurface(...)` 会把失败变成 unhandledRejection——
  // 在 Node 里那是**默认杀进程**的，而且报错栈里看不出是 dshr 干的。
  // 踩过：加了 apiProxy 守卫之后，bundle 的单测立刻以「测试结束后的异步活动」形式暴露了这条。
  void startSurface(ctx, { runtime }).catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(`dshr: terminal surface failed to mount: ${message}`)
  })
  const print = (): void => {
    const target = runtime.connect ?? `${runtime.host}:${runtime.port}`
    const suffix = runtime.resume === undefined ? '' : `, resume ${runtime.resume}`
    console.log(`dshr: host plane settled (${target}${suffix}); terminal surface not yet mounted`)
  }
  const settled = ctx.get('loader')?.await() as Promise<unknown> | undefined
  if (settled === undefined) print()
  else void settled.then(print, () => {})
}

// Re-export the startup contract so consumers of the app plugin can name the
// provider's value type without importing the subpath.
export type { DshrStartup }
