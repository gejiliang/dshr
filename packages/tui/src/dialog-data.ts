/**
 * E 批对话框的**纯数据**构建器：`@dshr/state` 的只读结果 → `DialogSelectOption`。
 *
 * 不 import ink/react，可在 node:test 里裸测。渲染常数都在 DialogSelect 里，
 * 这里只决定「标题 / muted 说明 / 分组 / ● 当前项」分别放什么。
 */
import type {
  CredentialRefState,
  ModelCatalog,
  ProviderEntry,
  SettingsOverview,
} from '@dshr/state'
import type { DialogSelectOption } from './components/DialogSelect.js'
import { truncate } from './text-utils.js'

/**
 * `View settings`：每个命名空间一行。value 本体不逐字段展开（那是编辑器的事——
 * 上游自带 openDocument 就是让人去编辑器里改），这里只给定位信息：
 * 生效时机（live/restart）、secret 槽位配置进度、有没有用户覆盖层。
 */
export function settingsOptions(overview: SettingsOverview): DialogSelectOption[] {
  return overview.namespaces.map((ns) => {
    const parts = [`applies ${ns.applies}`]
    if (ns.secrets.length > 0) {
      const set = ns.secrets.filter((slot) => slot.set).length
      parts.push(`${set}/${ns.secrets.length} secrets set`)
    }
    if (ns.user !== undefined) parts.push('user overrides')
    return {
      title: ns.ns,
      label: parts.join(' · '),
      category: 'Namespaces',
      footer: `rev ${ns.revision}`,
      value: ns.ns,
    }
  })
}

/**
 * `Configure credentials`：每个已知 ref 一行，**配了的画 ●**。
 * 值永不过线（上游结构性保证），所以状态只有 configured/source/writable。
 */
export function credentialOptions(credentials: readonly CredentialRefState[]): DialogSelectOption[] {
  return credentials.map((credential) => {
    const status = credential.configured
      ? `configured${credential.source !== undefined ? ` via ${credential.source}` : ''}`
      : 'not configured'
    const usedBy = credential.holders.length > 0 ? ` · ${credential.holders.join(', ')}` : ''
    return {
      title: credential.ref,
      label: `${status}${usedBy}`,
      category: credential.configured ? 'Configured' : 'Missing',
      ...(credential.configured ? { current: true } : {}),
      ...(!credential.writable ? { footer: 'read-only' } : {}),
      value: credential.ref,
    }
  })
}

/**
 * `View providers`（实测形状见 docs/gap-shapes.md §八）：
 * `displayName` 作标题、`provider` 作 muted 说明、活跃的进 `Active` 分组并画 ●。
 */
export function providerOptions(providers: readonly ProviderEntry[]): DialogSelectOption[] {
  return providers.map((provider) => ({
    title: provider.displayName,
    label:
      provider.declared === false ? `${provider.provider} · not declared` : provider.provider,
    category: provider.active ? 'Active' : 'Available',
    ...(provider.active ? { current: true } : {}),
    value: provider.provider,
  }))
}

/** `View models`：host 级目录，分组标题 = provider 显示名；拉取失败的进 `Failures`。 */
export function modelOptions(catalog: ModelCatalog): DialogSelectOption[] {
  const options: DialogSelectOption[] = []
  for (const group of catalog.groups) {
    for (const model of group.models) {
      options.push({
        title: model.name,
        ...(model.id !== model.name ? { label: model.id } : {}),
        category: group.name,
        value: `${group.id}/${model.id}`,
      })
    }
  }
  for (const failure of catalog.failures) {
    options.push({
      title: failure.name,
      label: truncate(failure.message, 60),
      category: 'Failures',
      value: `failure-${failure.id}`,
    })
  }
  return options
}
