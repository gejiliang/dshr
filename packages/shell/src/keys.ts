/**
 * 键位分发：纯状态机，不 import ink。ink 的 key 事件在边界上折算成
 * `KeyStroke` 喂进来，出去的是 `ShellAction`（壳自己消化）或透传（给会话输入框）。
 *
 * 键表是数据（`KeyTable`），这版内置 tmux 风格的默认表；之后要做成可配置，
 * 换一张表即可，状态机不用动。
 */

/** ink `useInput((input, key) => …)` 的最小折算形状。 */
export interface KeyStroke {
  readonly input: string
  readonly ctrl?: boolean
  readonly upArrow?: boolean
  readonly downArrow?: boolean
  readonly leftArrow?: boolean
  readonly rightArrow?: boolean
}

export type ShellAction =
  | { readonly type: 'newTab' }
  | { readonly type: 'nextTab' }
  | { readonly type: 'prevTab' }
  | { readonly type: 'splitVertical' }
  | { readonly type: 'splitHorizontal' }
  | { readonly type: 'focusPane'; readonly direction: 'left' | 'right' | 'up' | 'down' }
  | { readonly type: 'closePane' }
  | { readonly type: 'toggleSidebar' }
  | { readonly type: 'selectWorkspace' }
  | { readonly type: 'newWorkspace' }

export type DispatchResult =
  | { readonly kind: 'action'; readonly action: ShellAction }
  /** 非前缀按键：交还给 pane 内会话的输入框。 */
  | { readonly kind: 'passthrough'; readonly stroke: KeyStroke }
  /** 前缀序列中途或完成后被消费，不再透传。 */
  | { readonly kind: 'consumed' }

/** 前缀键后接的单键 → 动作。 */
export interface KeyTable {
  readonly prefix: KeyStroke
  readonly bindings: Readonly<Record<string, ShellAction>>
}

/** tmux 风格默认表：Ctrl-B 前缀。 */
export const DEFAULT_KEY_TABLE: KeyTable = {
  prefix: { input: 'b', ctrl: true },
  bindings: {
    c: { type: 'newTab' },
    n: { type: 'nextTab' },
    p: { type: 'prevTab' },
    '%': { type: 'splitVertical' },
    '"': { type: 'splitHorizontal' },
    x: { type: 'closePane' },
    s: { type: 'toggleSidebar' },
    w: { type: 'selectWorkspace' },
    W: { type: 'newWorkspace' },
  },
}

function strokesEqual(a: KeyStroke, b: KeyStroke): boolean {
  return (
    a.input === b.input &&
    Boolean(a.ctrl) === Boolean(b.ctrl) &&
    Boolean(a.upArrow) === Boolean(b.upArrow) &&
    Boolean(a.downArrow) === Boolean(b.downArrow) &&
    Boolean(a.leftArrow) === Boolean(b.leftArrow) &&
    Boolean(a.rightArrow) === Boolean(b.rightArrow)
  )
}

const ARROWS: ReadonlyArray<[keyof KeyStroke, 'up' | 'down' | 'left' | 'right']> = [
  ['upArrow', 'up'],
  ['downArrow', 'down'],
  ['leftArrow', 'left'],
  ['rightArrow', 'right'],
]

/**
 * 两态状态机：idle →（前缀键）→ prefix →（一个键）→ idle。
 * prefix 态下认不出的键：消费掉并回 idle（tmux 行为），不透传。
 */
export class KeyDispatcher {
  private inPrefix = false

  constructor(private readonly table: KeyTable = DEFAULT_KEY_TABLE) {}

  /** 供 UI 显示「前缀已按下」。 */
  get awaitingPrefixFollowUp(): boolean {
    return this.inPrefix
  }

  reset(): void {
    this.inPrefix = false
  }

  dispatch(stroke: KeyStroke): DispatchResult {
    if (!this.inPrefix) {
      if (strokesEqual(stroke, this.table.prefix)) {
        this.inPrefix = true
        return { kind: 'consumed' }
      }
      return { kind: 'passthrough', stroke }
    }
    this.inPrefix = false
    for (const [field, direction] of ARROWS) {
      if (stroke[field]) {
        return { kind: 'action', action: { type: 'focusPane', direction } }
      }
    }
    const action = this.table.bindings[stroke.input]
    if (action) return { kind: 'action', action }
    return { kind: 'consumed' }
  }
}
