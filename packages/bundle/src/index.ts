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
 * Plugin-level injection: none. The Loader row carries `inject:
 * [dshrStartup]` so its lazy config expressions resolve only after
 * `dshr-startup` has provided the parsed flags.
 */
export const inject: string[] = []

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
  void ctx
  void options
  return undefined
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
  void startSurface(ctx, { runtime })
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
