/**
 * 覆盖层（工作区选择器 / 新建工作区输入框）的纯状态机。
 * 与 `keys.ts` / `layout.ts` 同一条纪律：纯数据 + 纯函数，**不 import ink / react**，
 * 可以在 node:test 里裸跑。ink 的 key 事件在 Shell 边界折算成 `OverlayKeyStroke`
 * 喂进来，出去的是纯决策（开 / 取消 / 确认），副作用一个都没有。
 */

/** ink key 事件折算后的最小形状（边界在 Shell.tsx 的 useInput 里）。 */
export interface OverlayKeyStroke {
  readonly input: string
  readonly upArrow?: boolean
  readonly downArrow?: boolean
  readonly returnKey?: boolean
  readonly escape?: boolean
  readonly backspace?: boolean
}

/* ------------------------------------------------------------------ */
/* 工作区选择器                                                        */
/* ------------------------------------------------------------------ */

export interface WorkspacePickerEntry {
  readonly id: string
  readonly title: string
  readonly path: string
}

export interface WorkspacePickerModel {
  readonly entries: readonly WorkspacePickerEntry[]
  /** 当前高亮项。entries 为空时无意义。 */
  readonly index: number
}

export type PickerInput =
  | { readonly kind: 'up' }
  | { readonly kind: 'down' }
  | { readonly kind: 'digit'; readonly digit: number }
  | { readonly kind: 'confirm' }
  | { readonly kind: 'cancel' }

export type PickerOutcome =
  | { readonly kind: 'open'; readonly model: WorkspacePickerModel }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'confirmed'; readonly workspaceId: string }

export function openWorkspacePicker(entries: readonly WorkspacePickerEntry[]): WorkspacePickerModel {
  return { entries, index: 0 }
}

export function pickerInputFromKey(stroke: OverlayKeyStroke): PickerInput | null {
  if (stroke.escape) return { kind: 'cancel' }
  if (stroke.returnKey) return { kind: 'confirm' }
  if (stroke.upArrow) return { kind: 'up' }
  if (stroke.downArrow) return { kind: 'down' }
  if (/^[1-9]$/.test(stroke.input)) return { kind: 'digit', digit: Number(stroke.input) }
  return null
}

/**
 * 数字键与上下键只移动高亮，enter 才确认（tmux choose-tree 的交互形状）。
 * 空列表时 confirm / 方向键都保持原样，只有 esc 能退。
 */
export function pickerKey(model: WorkspacePickerModel, input: PickerInput): PickerOutcome {
  const n = model.entries.length
  switch (input.kind) {
    case 'cancel':
      return { kind: 'cancelled' }
    case 'up':
      return { kind: 'open', model: { ...model, index: n === 0 ? 0 : (model.index - 1 + n) % n } }
    case 'down':
      return { kind: 'open', model: { ...model, index: n === 0 ? 0 : (model.index + 1) % n } }
    case 'digit': {
      const i = input.digit - 1
      if (i >= n) return { kind: 'open', model }
      return { kind: 'open', model: { ...model, index: i } }
    }
    case 'confirm': {
      const entry = model.entries[model.index]
      return entry === undefined ? { kind: 'open', model } : { kind: 'confirmed', workspaceId: entry.id }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 单行文本输入（新建工作区的路径）                                     */
/* ------------------------------------------------------------------ */

export interface TextInputModel {
  readonly value: string
}

export type TextInputInput =
  | { readonly kind: 'char'; readonly ch: string }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'confirm' }
  | { readonly kind: 'cancel' }

export type TextInputOutcome =
  | { readonly kind: 'open'; readonly model: TextInputModel }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'submitted'; readonly value: string }

export function emptyTextInput(): TextInputModel {
  return { value: '' }
}

export function textInputFromKey(stroke: OverlayKeyStroke): TextInputInput | null {
  if (stroke.escape) return { kind: 'cancel' }
  if (stroke.returnKey) return { kind: 'confirm' }
  if (stroke.backspace) return { kind: 'backspace' }
  const cp = stroke.input.codePointAt(0)
  // 只收可打印字符；控制字符（含 ctrl 组合键产生的控制码）不进输入框
  if (cp !== undefined && cp >= 0x20 && cp !== 0x7f) return { kind: 'char', ch: stroke.input }
  return null
}

export function inputKey(model: TextInputModel, input: TextInputInput): TextInputOutcome {
  switch (input.kind) {
    case 'cancel':
      return { kind: 'cancelled' }
    case 'confirm':
      return { kind: 'submitted', value: model.value }
    case 'backspace':
      return { kind: 'open', model: { value: model.value.slice(0, -1) } }
    case 'char':
      return { kind: 'open', model: { value: model.value + input.ch } }
  }
}
