/**
 * 凭证引用的发现：**哪些 ref 存在**是从设置里读出来的，不是 credentials 域给的——
 * 上游契约原文（credentials.d.ts）："clients learn which references exist from
 * settings schemas and values (apiKeyEnv fields)"，credentials 域**故意没有枚举方法**。
 *
 * 实测（2026-08-17，`tools/probe-config.mjs`）：
 * - 字段名就是 `apiKeyEnv`，值是 ref 名（如 `MOCK_API_KEY` / `DEEPSEEK_API_KEY`）
 * - provider 的 profile 在 `settingsNs` 命名空间的 `value` 里，`settingsPath` 指进去
 * - 命名空间的 `value` 已过红线（`role('secret')` 字段永不下线），这里读不出任何密钥值
 */
import type { ProviderEntry, SettingsOverview } from './types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 递归找 value 里所有 `apiKeyEnv` 字符串字段的值。 */
function collectEnvRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEnvRefs(item, into)
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (key === 'apiKeyEnv' && typeof item === 'string' && item !== '') {
      into.add(item)
    } else {
      collectEnvRefs(item, into)
    }
  }
}

/** 按 settingsPath 从命名空间的 value 里解析出 provider 的 profile 对象。 */
function resolvePath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

/**
 * 收集全 deployment 已知的 credential ref → 引用它的 holder
 * （provider 显示名，兜底命名空间名）。返回 Map 保持发现顺序：
 * 先是 provider 目录序，再是其余命名空间里的散件。
 */
export function collectCredentialRefs(
  settings: SettingsOverview,
  providers: readonly ProviderEntry[],
): Map<string, string[]> {
  const holders = new Map<string, string[]>()
  const add = (ref: string, holder: string): void => {
    const list = holders.get(ref)
    if (list === undefined) holders.set(ref, [holder])
    else if (!list.includes(holder)) list.push(holder)
  }
  const nsValues = new Map(settings.namespaces.map((ns) => [ns.ns, ns.value]))
  for (const provider of providers) {
    const profile = resolvePath(nsValues.get(provider.settingsNs), provider.settingsPath)
    if (!isRecord(profile)) continue
    const ref = profile['apiKeyEnv']
    if (typeof ref === 'string' && ref !== '') add(ref, provider.displayName)
  }
  for (const ns of settings.namespaces) {
    const refs = new Set<string>()
    collectEnvRefs(ns.value, refs)
    for (const ref of refs) add(ref, ns.ns)
  }
  return holders
}
