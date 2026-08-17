export { FlagError, USAGE, DEFAULT_PORT, assertLoopbackUrl, parseFlags, type ParsedFlags } from './flags.js'
export {
  defaultProbe,
  defaultSpawnHost,
  ensureHost,
  killChild,
  runServer,
  type EnsureHostOptions,
  type HostHandle,
  type Probe,
  type RunServerOptions,
  type SpawnHost,
} from './host.js'
// `SessionApp` 与挂载逻辑搬去了 `@dshr/surface`——插件路与 `--connect` 这条网络路
// 共用同一份，不许各存一份。这里转发一下，别处的 import 不用改。
export { SessionApp, mountSurface, resolveSession, type SessionAppProps } from '@dshr/surface'
