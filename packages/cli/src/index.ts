export { FlagError, USAGE, DEFAULT_PORT, assertLoopbackUrl, parseFlags, type ParsedFlags } from './flags.js'
// `host.ts`（spawn `dsh web` + 探活 + 进程保姆）在 2026-08-18 删了：
// dshr 是 dsh 的插件，裸跑走 `dsh --profile dshr`，没有要保姆的子进程。
// 要看它长什么样：`git log -- packages/cli/src/host.ts`。
export { PROFILE_NAME, bundleDir, dshHome, ensureProfile, runProfile, type RunProfileOptions } from './profile.js'
// `SessionApp` 与挂载逻辑搬去了 `@dshr/surface`——插件路与 `--connect` 这条网络路
// 共用同一份，不许各存一份。这里转发一下，别处的 import 不用改。
export { SessionApp, mountSurface, resolveSession, type SessionAppProps } from '@dshr/surface'
