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
import type { RemoteSlashCommand, SlashCommandSource } from '@dshr/surface'
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

/**
 * `TypertGateway`（`@deepseek-ai/dsh-api-gateway`）的最小结构面。
 * 不 import 上游包：bundle 对它只作类型级引用（同上面 DshrStartup 的先例）。
 */
export interface TypertGatewayLike {
  invoke(request: {
    namespace: string
    method: string
    args: Readonly<Record<string, unknown>>
  }): Promise<unknown>
}

/** `commands/list` 返回值的逐条校验：形状不符的条目丢掉，不让一条坏数据废掉整张表。 */
function coerceCommandDescriptor(item: unknown): RemoteSlashCommand | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const { name, description, input } = item as {
    name?: unknown
    description?: unknown
    input?: unknown
  }
  if (typeof name !== 'string' || name === '') return undefined
  return {
    name,
    ...(typeof description === 'string' && description !== '' ? { description } : {}),
    // `input`（CommandInputDescriptor）存在 = 命令要自由文本参数，enter 只补全不执行。
    ...(typeof input === 'object' && input !== null ? { takesInput: true } : {}),
  }
}

/**
 * 真·斜杠命令来源：走 `ctx.typertGateway.invoke` 打 dsh 的 `CommandRuntime`
 * （`@deepseek-ai/dsh-commands` 的 typert remote service，**不在那 52 个 RPC 里**）。
 *
 * namespace / 方法 / 参数形状是 2026-08-18 在 dsh 0.1.0-rc.6 上实测探出来的
 * （先空 args 打一次，从 `TypertGatewayErrorCode` 的 `arguments-invalid` 报错反推），
 * 细节记在 docs/gap-shapes.md §十一：
 *
 *   list    ← invoke({ namespace: 'commands', method: 'list',    args: { agentId } })
 *             → CommandDescriptor[]（{ name, description, input?: { hint } }）
 *   execute ← invoke({ namespace: 'commands', method: 'execute', args: { agentId, line } })
 *             → CommandExecution | undefined（{ commandId, result: { kind, text? } }）
 *
 * 网关层失败（`service-unavailable` / `context-not-found` / …）抛 `TypertGatewayError`，
 * 直接 reject 出去；业务失败（`result.kind === 'error'`）不 throw，回执文本交给 UI。
 */
export function createTypertSlashCommands(gateway: TypertGatewayLike): SlashCommandSource {
  return {
    async list(sessionId) {
      const result: unknown = await gateway.invoke({
        namespace: 'commands',
        method: 'list',
        args: { agentId: sessionId },
      })
      if (!Array.isArray(result)) {
        throw new Error(`commands/list: unexpected result shape (${typeof result})`)
      }
      const out: RemoteSlashCommand[] = []
      for (const item of result as unknown[]) {
        const descriptor = coerceCommandDescriptor(item)
        if (descriptor !== undefined) out.push(descriptor)
      }
      return out
    },
    async run(sessionId, line) {
      const execution: unknown = await gateway.invoke({
        namespace: 'commands',
        method: 'execute',
        args: { agentId: sessionId, line },
      })
      // undefined = 这行没被任何命令认领；成功结果也没有回执
      // （command/run / command/done 事件已经进会话流）。
      if (typeof execution !== 'object' || execution === null) return undefined
      const result = (execution as { result?: unknown }).result
      if (typeof result !== 'object' || result === null) return undefined
      const { kind, text } = result as { kind?: unknown; text?: unknown }
      if (kind === 'error') return typeof text === 'string' ? text : 'command failed'
      return undefined
    },
  }
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

  // dsh 的斜杠命令表：`typert-gateway` 行在 base 组合里，正常应该在。
  // ⚠️ 不能写 `ctx.typertGateway`——它不在插件级 inject 里（inject 是**硬**依赖，
  // 写上它，profile 少了这行整棵树都起不来），cordis 对未声明的服务访问直接抛
  // 「cannot get property without inject」。可选服务要走 `ctx.reflect.get(name, false)`：
  // 没提供就返回 undefined，我们退化到「只出 dshr 自己的命令」。
  // `--connect` 路不在这里也不注入——typert 没走 `/api`（docs/gap-shapes.md §十一）。
  const reflect = (ctx as unknown as { reflect?: { get(name: string, strict?: boolean): unknown } }).reflect
  const typertGateway = reflect?.get('typertGateway', false) as TypertGatewayLike | undefined
  let slashCommands =
    typertGateway === undefined || typertGateway === null
      ? undefined
      : createTypertSlashCommands(typertGateway)
  // 探针：DSHR_SLASH_DEBUG=<文件> 时把 list/run 的结果与报错落盘（typert 的形状是探出来的）。
  const slashDebug = process.env.DSHR_SLASH_DEBUG
  if (slashCommands !== undefined && slashDebug !== undefined && slashDebug !== '') {
    const inner = slashCommands
    const log = (line: string): void => {
      void import('node:fs').then(({ appendFileSync }) => appendFileSync(slashDebug, `${line}\n`))
    }
    slashCommands = {
      list: (sessionId) =>
        inner.list(sessionId).then(
          (list) => {
            log(`list OK: ${JSON.stringify(list)}`)
            return list
          },
          (error: unknown) => {
            log(`list FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
            throw error
          },
        ),
      run: (sessionId, line) =>
        inner.run(sessionId, line).then(
          (receipt) => {
            log(`run(${line}) OK: ${JSON.stringify(receipt)}`)
            return receipt
          },
          (error: unknown) => {
            log(`run(${line}) FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
            throw error
          },
        ),
    }
  }

  const description = client.state.status === 'ready' ? client.state.host : undefined
  const { mountSurface } = await import('@dshr/surface')
  const surface = await mountSurface({
    client,
    ...(options.runtime.resume !== undefined ? { resume: options.runtime.resume } : {}),
    ...(description?.model !== undefined ? { model: description.model } : {}),
    ...(description?.provider !== undefined ? { provider: description.provider } : {}),
    ...(slashCommands !== undefined ? { slashCommands } : {}),
  })

  // 界面退出（Ctrl-C / 面板里的 Exit）就该收掉整棵树——一个 TUI surface 的进程
  // 没有在界面没了之后继续活着的理由。用 dsh 自己的 `appExit`，别自己 `process.exit`：
  // 那会跳过 Loader 的拆除，把别的行的收尾一起吞掉。
  void surface.waitUntilExit().then((code) => {
    ctx.appExit?.(code)
  })

  return {
    async close() {
      await surface.close()
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
    // ⚠️ 只在**不挂界面**的时候印。挂了界面就闭嘴——ink 接管了这块屏幕，
    // 往同一个终端 `console.log` 会把画面撕开（那行会留在 ink 的渲染区里，
    // 下一帧擦不掉）。`--connect` 那条路不在这里挂界面，才需要这行告诉人它起来了。
    if (runtime.connect === undefined) return
    const suffix = runtime.resume === undefined ? '' : `, resume ${runtime.resume}`
    console.log(`dshr: host plane settled; surface attaches to ${runtime.connect}${suffix}`)
  }
  const settled = ctx.get('loader')?.await() as Promise<unknown> | undefined
  if (settled === undefined) print()
  else void settled.then(print, () => {})
}

// Re-export the startup contract so consumers of the app plugin can name the
// provider's value type without importing the subpath.
export type { DshrStartup }
