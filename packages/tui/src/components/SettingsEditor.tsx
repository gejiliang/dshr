/**
 * 设置编辑器：命名空间 → 字段 → 按类型编辑 的三层下钻（DialogSelect / DialogPrompt 组合）。
 *
 * 为什么存在：`settings.openDocument` 在**宿主机的桌面**上弹编辑器——dshr 是终端工具，
 * 人常常 SSH 过来用，编辑器弹在他看不见的机器上（docs/gap-shapes.md §十一的起因）。
 * 设置必须能在 TUI 里改完。
 *
 * 数据纪律（都是实测过的坑）：
 * - 写只走 `settings.mutate`（按字段路径，CAS 保护）；返回的 view 直接换回本地
 *   （带新 revision），**不再 describe 一次**。
 * - CAS 撞了（`settings-conflict`）与校验失败（`settings-rejected`）都给**可读回执**，不吞。
 * - `role: 'secret'` 的字段：值永不下线，只显示「configured / not configured」，
 *   **不提供输入**。`role: 'credential-ref'` 是环境变量名，明文正常编辑。两者别搞混。
 * - array / dict 这一版只读，标明「暂不支持」——不假装能改。
 */
import { useRef, useState, type ReactElement } from 'react'
import { Box, Text } from 'ink'
import {
  formatSettingValue,
  parseTextInput,
  refindFields,
  sameValue,
  validateNumberInput,
  walkSettingsNamespace,
  type SettingField,
  type SettingsNamespace,
  type SettingsOverview,
  type SettingsPathOp,
} from '@dshr/state'
import { DialogSelect, type DialogSelectOption } from './DialogSelect.js'
import { DialogPrompt } from './DialogPrompt.js'
import { theme } from '../theme.js'
import { truncate } from '../text-utils.js'

export interface SettingsEditorProps {
  /** `settings.describe` 的全量结果（调用方取好再开——取数失败在调用方提示）。 */
  readonly overview: SettingsOverview
  /** 唯一写通道（`DshrState.mutateSetting` 的透传）。 */
  readonly onMutate: (
    ns: string,
    ops: readonly SettingsPathOp[],
    expectedRevision: number,
  ) => Promise<SettingsNamespace>
  /**
   * 重新拉一次 `settings.describe`。**CAS 冲突之后必须用它刷新 revision。**
   *
   * ⚠️ 不给这条通道会死循环：冲突后本地 revision 还是旧的，人再改一次仍然拿旧
   * revision 去写，撞同一个冲突，**只能关掉编辑器重开才能继续**。
   * （跨厂商评审挑出来的。）
   */
  readonly onRefresh?: () => Promise<SettingsOverview>
  readonly onClose: () => void
  readonly maxHeight?: number
}

/** 编辑器内的屏幕栈：enum/input 屏记着回去的 fields 屏位置。 */
type Screen =
  | { readonly kind: 'namespaces' }
  | { readonly kind: 'fields'; readonly ns: string; readonly trail: readonly string[] }
  | {
      readonly kind: 'enum'
      readonly ns: string
      readonly trail: readonly string[]
      readonly field: SettingField
    }
  | {
      readonly kind: 'input'
      readonly ns: string
      readonly trail: readonly string[]
      readonly field: SettingField
    }

interface Receipt {
  readonly tone: 'ok' | 'error'
  readonly text: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 字段行右侧的当前值（footer，右对齐）。 */
function fieldValueText(field: SettingField): string {
  if (field.role === 'secret') return '—'
  if (field.kind === 'object') return `${field.children?.length ?? 0} fields ›`
  if (field.type === 'array') return `${Array.isArray(field.value) ? field.value.length : 0} items`
  if (field.type === 'dict') {
    const value = field.value
    return `${typeof value === 'object' && value !== null ? Object.keys(value).length : 0} keys`
  }
  if (!field.hasValue) return '—'
  return truncate(formatSettingValue(field.value), 24)
}

/** 字段行标题后的 muted 说明。 */
function fieldLabel(field: SettingField): string | undefined {
  if (field.role === 'secret') {
    return field.secretSet === true
      ? 'secret · configured · value never leaves the host'
      : 'secret · not configured'
  }
  if (field.role === 'credential-ref') return 'environment variable name'
  if (field.kind === 'readonly') {
    if (field.type === 'array' || field.type === 'dict') {
      return `not editable in the TUI yet (${field.type})`
    }
    if (field.type === 'const') return 'fixed by schema'
    return `not editable in the TUI yet (${field.type})`
  }
  if (field.kind === 'text') return 'free text (JSON or plain)'
  if (field.kind === 'enum') return 'select'
  if (field.kind === 'boolean') return 'enter to toggle'
  return undefined
}

export function SettingsEditor({ overview, onMutate, onRefresh, onClose, maxHeight }: SettingsEditorProps): ReactElement {
  // 命名空间列表进 state：mutate 成功后用返回的 view 原地换新（带新 revision）。
  const [namespaces, setNamespaces] = useState(overview.namespaces)
  const namespacesRef = useRef(namespaces)
  namespacesRef.current = namespaces
  const [screen, setScreenState] = useState<Screen>({ kind: 'namespaces' })
  const screenRef = useRef(screen)
  const setScreen = (next: Screen): void => {
    screenRef.current = next
    setScreenState(next)
  }
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [inputError, setInputError] = useState<string | undefined>(undefined)
  const inFlight = useRef(false)

  const findNamespace = (name: string): SettingsNamespace | undefined =>
    namespacesRef.current.find((candidate) => candidate.ns === name)

  /** 一次编辑 = 一个 op；成功换新命名空间并回 fields 屏，失败留可读回执（CAS 冲突不吞）。 */
  const applyEdit = async (
    nsName: string,
    trail: readonly string[],
    op: SettingsPathOp,
    done: (revision: number) => string,
  ): Promise<void> => {
    if (inFlight.current) return
    const current = findNamespace(nsName)
    if (current === undefined) return
    inFlight.current = true
    try {
      const next = await onMutate(nsName, [op], current.revision)
      setNamespaces(namespacesRef.current.map((candidate) => (candidate.ns === nsName ? next : candidate)))
      setReceipt({ tone: 'ok', text: done(next.revision) })
    } catch (error) {
      const message = errorText(error)
      // CAS 冲突（`settings-conflict`）说明别处改过了：**刷新 revision 再让人重试**，
      // 否则拿着旧 revision 重试永远撞同一堵墙（只能关掉重开）。
      // 刷新失败就把两条消息都给人，别把原始冲突原因吞掉。
      if (/settings-conflict/.test(message) && onRefresh !== undefined) {
        try {
          const fresh = await onRefresh()
          setNamespaces(fresh.namespaces)
          setReceipt({
            tone: 'error',
            text: `${message} — reloaded; your edit was not applied, try again`,
          })
        } catch (refreshError) {
          setReceipt({ tone: 'error', text: `${message} (reload failed: ${errorText(refreshError)})` })
        }
      } else {
        setReceipt({ tone: 'error', text: message })
      }
    } finally {
      inFlight.current = false
    }
    setInputError(undefined)
    setScreen({ kind: 'fields', ns: nsName, trail })
  }

  /** 选中一个字段：按 kind 分派（只读的给理由，不静默）。 */
  const onFieldSelect = (ns: SettingsNamespace, trail: readonly string[], fields: readonly SettingField[], key: string): void => {
    const field = fields.find((candidate) => candidate.key === key)
    if (field === undefined) return
    setReceipt(null)
    switch (field.kind) {
      case 'object':
        setScreen({ kind: 'fields', ns: ns.ns, trail: [...trail, field.key] })
        return
      case 'enum':
        // 与 boolean/string/number/text 一致：只读 host 上当场给理由，
        // 别让人选完一圈才收到 host 的拒绝（评审指出的分支不一致）。
        if (!overview.writable) {
          setReceipt({ tone: 'error', text: 'settings are read-only on this host' })
          return
        }
        setScreen({ kind: 'enum', ns: ns.ns, trail, field })
        return
      case 'boolean': {
        if (!overview.writable) {
          setReceipt({ tone: 'error', text: 'settings are read-only on this host' })
          return
        }
        const next = !(field.value === true)
        void applyEdit(ns.ns, trail, { op: 'set', path: [...field.path], value: next }, (rev) => `${field.key} = ${next} (rev ${rev})`)
        return
      }
      case 'string':
      case 'number':
      case 'text':
        if (!overview.writable) {
          setReceipt({ tone: 'error', text: 'settings are read-only on this host' })
          return
        }
        setInputError(undefined)
        setScreen({ kind: 'input', ns: ns.ns, trail, field })
        return
      case 'readonly':
        setReceipt({
          tone: 'error',
          text:
            field.role === 'secret'
              ? `${field.key} is a write-only secret slot — set it in the settings file, it never leaves the host`
              : `${field.key} (${field.type}) is not editable in the TUI yet`,
        })
        return
    }
  }

  /** input 屏提交：number 先本地校验（不合法不许提交），text 按 JSON/纯文本解析。 */
  const onInputSubmit = (nsName: string, trail: readonly string[], field: SettingField, text: string): void => {
    let value: unknown
    if (field.kind === 'number') {
      const checked = validateNumberInput(text, { ...(field.min !== undefined ? { min: field.min } : {}), ...(field.max !== undefined ? { max: field.max } : {}), ...(field.step !== undefined ? { step: field.step } : {}) })
      if (!checked.ok) {
        setInputError(checked.message)
        return
      }
      value = checked.value
    } else if (field.kind === 'text') {
      value = parseTextInput(text)
    } else {
      value = text
    }
    void applyEdit(nsName, trail, { op: 'set', path: [...field.path], value }, (rev) => `${field.key} updated (rev ${rev})`)
  }

  // ── 渲染当前屏 ────────────────────────────────────────────────
  let body: ReactElement
  if (screen.kind === 'namespaces') {
    body = (
      // key 钉住屏幕身份：DialogSelect 的内部高亮/搜索态不跨屏继承（踩过——
      // 同类型同位置复用实例，命名空间屏的高亮会带进字段屏）。
      <DialogSelect
        key="namespaces"
        title="Settings"
        options={namespaces.map((ns) => {
          const parts = [ns.applies === 'restart' ? '⚠ applies on restart' : 'applies live']
          if (ns.secrets.length > 0) {
            const set = ns.secrets.filter((slot) => slot.set).length
            parts.push(`${set}/${ns.secrets.length} secrets set`)
          }
          return {
            title: ns.ns,
            label: parts.join(' · '),
            category: 'Namespaces',
            footer: `rev ${ns.revision}`,
            value: ns.ns,
          }
        })}
        {...(maxHeight !== undefined ? { maxHeight } : {})}
        onSelect={(name) => {
          setReceipt(null)
          setScreen({ kind: 'fields', ns: name, trail: [] })
        }}
        onCancel={onClose}
      />
    )
  } else if (screen.kind === 'fields') {
    const ns = findNamespace(screen.ns)
    const roots = ns !== undefined ? walkSettingsNamespace(ns) : []
    const fields = refindFields(roots, screen.trail) ?? roots
    const title = [screen.ns, ...screen.trail].join(' · ')
    body = (
      <DialogSelect
        key={`fields:${screen.ns}:${screen.trail.join('\u0000')}`}
        title={title}
        options={fields.map((field) => {
          const label = fieldLabel(field)
          return {
            title: field.key,
            ...(label !== undefined ? { label } : {}),
            footer: fieldValueText(field),
            tone: field.kind === 'readonly' ? ('muted' as const) : ('default' as const),
            value: field.key,
          }
        })}
        {...(maxHeight !== undefined ? { maxHeight } : {})}
        onSelect={(key) => {
          if (ns !== undefined) onFieldSelect(ns, screen.trail, fields, key)
        }}
        onCancel={() => {
          setReceipt(null)
          if (screen.trail.length > 0) {
            setScreen({ kind: 'fields', ns: screen.ns, trail: screen.trail.slice(0, -1) })
          } else {
            setScreen({ kind: 'namespaces' })
          }
        }}
      />
    )
  } else if (screen.kind === 'enum') {
    const { field } = screen
    body = (
      <DialogSelect
        key={`enum:${screen.ns}:${field.path.join('\u0000')}`}
        title={`${screen.ns} · ${[...screen.trail, field.key].join(' · ')}`}
        options={(field.options ?? []).map((option, index) => ({
          title: formatSettingValue(option),
          current: field.hasValue && sameValue(option, field.value),
          value: String(index),
        }))}
        {...(maxHeight !== undefined ? { maxHeight } : {})}
        onSelect={(index) => {
          const chosen = field.options?.[Number(index)]
          if (field.hasValue && sameValue(chosen, field.value)) {
            setScreen({ kind: 'fields', ns: screen.ns, trail: screen.trail })
            return
          }
          void applyEdit(screen.ns, screen.trail, { op: 'set', path: [...field.path], value: chosen }, (rev) => `${field.key} = ${formatSettingValue(chosen)} (rev ${rev})`)
        }}
        onCancel={() => setScreen({ kind: 'fields', ns: screen.ns, trail: screen.trail })}
      />
    )
  } else {
    const { field } = screen
    const initial =
      field.kind === 'string'
        ? typeof field.value === 'string'
          ? field.value
          : ''
        : field.hasValue
          ? formatSettingValue(field.value)
          : ''
    body = (
      <DialogPrompt
        key={`input:${screen.ns}:${field.path.join('\u0000')}`}
        title={`${screen.ns} · ${[...screen.trail, field.key].join(' · ')}`}
        initial={initial}
        {...(field.kind === 'number'
          ? {
              placeholder: `number${field.min !== undefined ? ` ≥ ${field.min}` : ''}${field.max !== undefined ? ` ≤ ${field.max}` : ''}${field.step !== undefined ? `, step ${field.step}` : ''}`,
            }
          : {})}
        {...(field.kind === 'text' ? { placeholder: 'JSON or plain text' } : {})}
        {...(inputError !== undefined ? { error: inputError } : {})}
        onSubmit={(text) => onInputSubmit(screen.ns, screen.trail, field, text)}
        onCancel={() => {
          setInputError(undefined)
          setScreen({ kind: 'fields', ns: screen.ns, trail: screen.trail })
        }}
      />
    )
  }

  return (
    <Box flexDirection="column">
      {receipt !== null ? (
        <>
          <Box paddingLeft={4} paddingRight={4}>
            <Text color={receipt.tone === 'error' ? theme.error : theme.info}>{receipt.text}</Text>
          </Box>
          <Box height={1} flexShrink={0} />
        </>
      ) : null}
      {body}
      {screen.kind === 'fields' && findNamespace(screen.ns)?.applies === 'restart' ? (
        <>
          <Box height={1} flexShrink={0} />
          <Box paddingLeft={4} paddingRight={4}>
            <Text color={theme.textMuted}>⚠ this namespace applies on restart — changes take effect after a host restart</Text>
          </Box>
        </>
      ) : null}
    </Box>
  )
}
