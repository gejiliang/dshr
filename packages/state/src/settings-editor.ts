/**
 * 设置命名空间的 **schema 走查器**：把 `SettingsNamespaceView` 的
 * schemastery 序列化 schema + 脱敏 value 走成一棵可编辑字段树。
 *
 * 纯函数，不碰 RPC（写回是 `DshrState.mutateSetting`）。本包不许 import ink/react。
 *
 * 序列化格式（`Schema.prototype.toJSON`，上游实测，docs/gap-shapes.md §十一）：
 * `{ uid: <根 refId>, refs: { <id>: { type, meta, value?, list?, inner?, sKey?, dict? } } }`
 * ——嵌套引用全是 refId 数字：`dict` 键→refId（object 的字段表）、`inner` 是
 * array/dict 元素的 refId、`list` 是 union 成员的 refId 数组、`value` 是 const 的字面值。
 *
 * 词汇表（11 个命名空间统计出来的全集，不是猜的）：
 * type 只有 const / union / number / string / object / array / dict / boolean 八种；
 * meta 只认 default / required / min / max / step / role 六个键，
 * role 只有 secret（值不下线）与 credential-ref（值是环境变量名，明文可编辑）。
 */
import type { SettingsNamespace, SettingsSecretSlot } from './types.js'

/** 字段在 TUI 里的编辑形态。 */
export type SettingFieldKind =
  /** union of const——枚举，选择列表（57 const / 18 union，主导模式）。 */
  | 'enum'
  /** 单行文本（credential-ref 也走这里——它的值本来就该是明文）。 */
  | 'string'
  /** 数字输入，按 meta.min/max/step 校验。 */
  | 'number'
  /** 就地切换，不弹框。 */
  | 'boolean'
  /** 分组，下钻一层。 */
  | 'object'
  /**
   * 退回文本编辑：union 里含非 const 分支（实测有 `object|object`、
   * `string|const(null)`、`const(false)|dict` 三种）。按 JSON 解析，
   * 解析失败当纯字符串（`string|const(null)` 的直接输入场景）。
   */
  | 'text'
  /** 这一版只读：array / dict / secret / 独立 const / 未识别的 type。 */
  | 'readonly'

/** 字段树的一个节点。不可变——mutate 成功后整棵重走。 */
export interface SettingField {
  /** 字段名（对象里的键）。 */
  readonly key: string
  /** 从命名空间根起的路径（mutate 的 `path` 就是它）。 */
  readonly path: readonly string[]
  readonly kind: SettingFieldKind
  /** schema 的 `type` 原文（readonly 时 TUI 拿它说明原因）。 */
  readonly type: string
  /** 当前值是否存在于脱敏 value 里（secret 永远没有）。 */
  readonly hasValue: boolean
  /** 当前值；`hasValue` 为 false 时缺省。 */
  readonly value?: unknown
  /** enum 的全部选项（const 成员的字面值，可能含 null/false——比较用 `sameValue`）。 */
  readonly options?: readonly unknown[]
  /** 数字约束（meta.min/max/step；step 的基准点是 min，没有 min 时是 0）。 */
  readonly min?: number
  readonly max?: number
  readonly step?: number
  /** meta.role 原文；只出现过 'secret' 与 'credential-ref'。 */
  readonly role?: string
  /** role 为 'secret' 时：槽位配没配（值本身永不下线，上游结构性保证）。 */
  readonly secretSet?: boolean
  /** kind 为 'object' 时的子字段。 */
  readonly children?: readonly SettingField[]
}

// ---- 序列化 schema 的结构化解码（全是 unknown 进、收窄出）----

interface RawRef {
  readonly type?: unknown
  readonly meta?: unknown
  readonly value?: unknown
  readonly list?: unknown
  readonly inner?: unknown
  readonly dict?: unknown
}

interface RawSchema {
  readonly uid: number
  readonly refs: Readonly<Record<string, RawRef>>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function decodeSchema(schema: unknown): RawSchema | undefined {
  const envelope = asRecord(schema)
  if (envelope === undefined || typeof envelope.uid !== 'number') return undefined
  const refs = asRecord(envelope.refs)
  if (refs === undefined) return undefined
  const out: Record<string, RawRef> = {}
  for (const [id, ref] of Object.entries(refs)) {
    const record = asRecord(ref)
    if (record !== undefined) out[id] = record
  }
  return { uid: envelope.uid, refs: out }
}

function metaOf(ref: RawRef | undefined): Record<string, unknown> {
  if (ref === undefined) return {}
  return asRecord(ref.meta) ?? {}
}

function metaNumber(meta: Record<string, unknown>, key: string): number | undefined {
  const value = meta[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 枚举值相等：字面量可能有 null/false/0，NaN 之外一律 Object.is + JSON 兜底。 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * 走一个命名空间，返回根对象的字段列表。
 * 根不是 object 或 schema 解码失败时返回空——上游 11 个命名空间的根全是 object，
 * 真出现别的形状就让那一层空着，比瞎猜强。
 */
export function walkSettingsNamespace(ns: SettingsNamespace): readonly SettingField[] {
  const schema = decodeSchema(ns.schema)
  if (schema === undefined) return []
  const secretSlots = new Map(ns.secrets.map((slot: SettingsSecretSlot) => [JSON.stringify(slot.path), slot.set]))
  const root = schema.refs[String(schema.uid)]
  if (root?.type !== 'object') return []
  return walkObject(schema, root, ns.value, [], secretSlots)
}

function walkObject(
  schema: RawSchema,
  ref: RawRef,
  container: unknown,
  basePath: readonly string[],
  secretSlots: ReadonlyMap<string, boolean>,
): readonly SettingField[] {
  const dict = asRecord(ref.dict)
  if (dict === undefined) return []
  const fields: SettingField[] = []
  for (const [key, refId] of Object.entries(dict)) {
    const childRef = schema.refs[String(refId)]
    const path = [...basePath, key]
    const record = asRecord(container)
    const hasValue = record !== undefined && key in record
    fields.push(buildField(schema, key, path, childRef, hasValue, hasValue ? record[key] : undefined, secretSlots))
  }
  return fields
}

function buildField(
  schema: RawSchema,
  key: string,
  path: readonly string[],
  ref: RawRef | undefined,
  hasValue: boolean,
  value: unknown,
  secretSlots: ReadonlyMap<string, boolean>,
): SettingField {
  const type = typeof ref?.type === 'string' ? ref.type : 'unknown'
  const meta = metaOf(ref)
  const role = typeof meta.role === 'string' ? meta.role : undefined
  const base = { key, path, hasValue, ...(hasValue ? { value } : {}), ...(role !== undefined ? { role } : {}) }

  // secret：值不下线，显示「已配置/未配置」，永远只读；
  // 显式构造，不从 base 继承 value（上游保证值不在，但别留意外泄漏的缝）。
  if (role === 'secret') {
    return {
      key,
      path,
      kind: 'readonly',
      type,
      hasValue: false,
      role,
      secretSet: secretSlots.get(JSON.stringify(path)) ?? false,
    }
  }

  switch (type) {
    case 'union': {
      const memberIds = Array.isArray(ref?.list) ? ref.list : []
      const members = memberIds.map((id) => schema.refs[String(id)])
      const allConst =
        members.length > 0 && members.every((member) => member?.type === 'const')
      if (allConst) {
        return { ...base, kind: 'enum', type, options: members.map((member) => member?.value) }
      }
      // 含非 const 分支：退回文本（JSON 解析，失败按纯字符串）。
      return { ...base, kind: 'text', type }
    }
    case 'const':
      // 独立 const（不在 union 里）：值是定死的，只读展示字面值。
      return { ...base, kind: 'readonly', type, hasValue: true, value: ref?.value }
    case 'string':
      return { ...base, kind: 'string', type }
    case 'number': {
      const min = metaNumber(meta, 'min')
      const max = metaNumber(meta, 'max')
      const step = metaNumber(meta, 'step')
      return {
        ...base,
        kind: 'number',
        type,
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(step !== undefined ? { step } : {}),
      }
    }
    case 'boolean':
      return { ...base, kind: 'boolean', type }
    case 'object':
      return {
        ...base,
        kind: 'object',
        type,
        children: ref !== undefined ? walkObject(schema, ref, value, path, secretSlots) : [],
      }
    // array / dict / 未识别：这一版只读。
    default:
      return { ...base, kind: 'readonly', type }
  }
}

/** 沿路径从字段树里重新定位子列表（mutate 成功后整树重走，按 stack 的 key 逐层找回去）。 */
export function refindFields(
  roots: readonly SettingField[],
  trail: readonly string[],
): readonly SettingField[] | undefined {
  let fields = roots
  for (const key of trail) {
    const field = fields.find((candidate) => candidate.key === key)
    if (field?.children === undefined) return undefined
    fields = field.children
  }
  return fields
}

// ---- 编辑侧的纯校验 ----

export type NumberValidation = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string }

/** number 字段的输入校验：不合法给可读消息，**不许提交**。 */
export function validateNumberInput(
  text: string,
  constraints: { readonly min?: number; readonly max?: number; readonly step?: number },
): NumberValidation {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, message: 'a number is required' }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return { ok: false, message: `"${trimmed}" is not a number` }
  const { min, max, step } = constraints
  if (min !== undefined && value < min) return { ok: false, message: `must be ≥ ${min}` }
  if (max !== undefined && value > max) return { ok: false, message: `must be ≤ ${max}` }
  if (step !== undefined && step > 0) {
    const origin = min ?? 0
    const steps = (value - origin) / step
    if (Math.abs(steps - Math.round(steps)) > 1e-9) {
      return { ok: false, message: `must be a multiple of ${step}${min !== undefined ? ` above ${min}` : ''}` }
    }
  }
  return { ok: true, value }
}

/** text 字段（含非 const 分支的 union）的输入解析：先试 JSON，失败按纯字符串。 */
export function parseTextInput(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

/** 字段值的单行展示（secret 与缺值由 TUI 的 label 负责，这里只管有值的）。 */
export function formatSettingValue(value: unknown): string {
  if (typeof value === 'string') return value === '' ? '""' : value
  if (value === undefined) return '—'
  try {
    const json = JSON.stringify(value)
    return json ?? String(value)
  } catch {
    return String(value)
  }
}
