/**
 * 键位提示的纯数据：底部提示栏（前缀按下时）与 `?` 帮助覆盖层共用一份行表。
 * 纯数据 + 纯函数，不 import ink / react。
 *
 * 键位真源是 `keys.ts` 的 `DEFAULT_KEY_TABLE`；这里每行的 `tableKeys` 声明
 * 「本行说明的是默认表里的哪些键」，测试用它做漂移检查--
 * 默认表加了绑定而这里没跟上（或反之），测试会挂。
 */

export interface KeybindRow {
  /** 展示用按键串（可以是人读的分组，如 `n / p`）。 */
  readonly keys: string
  readonly label: string
  /** 本行覆盖 `DEFAULT_KEY_TABLE.bindings` 里的哪些键；dispatcher 层的键（前缀、方向）没有。 */
  readonly tableKeys?: readonly string[]
}

/** 底部提示栏用的紧凑子集（形如 herdr 的 NAVIGATE 行）。 */
export const PREFIX_HINT: readonly KeybindRow[] = [
  { keys: 'c', label: 'new tab' },
  { keys: 'n/p', label: 'tab' },
  { keys: '1-9', label: 'tab #' },
  { keys: 'v', label: 'split' },
  { keys: '-', label: 'split─' },
  { keys: 'h/j/k/l', label: 'focus' },
  { keys: 'x', label: 'close' },
  { keys: 'z', label: 'zoom' },
  { keys: 'b', label: 'sidebar' },
  { keys: 'a', label: 'agents' },
  { keys: 'w', label: 'ws' },
  { keys: 'N', label: 'new ws' },
  { keys: '?', label: 'keybinds' },
]

/** `MODE  key label  key label …`，与 herdr 的 NAVIGATE 行同形。 */
export function hintLine(mode: string, rows: readonly KeybindRow[]): string {
  return [mode, ...rows.map((r) => `${r.keys} ${r.label}`)].join('  ')
}

/** `?` 帮助覆盖层的完整表。`s` 一行说明它为何空着，防后人随手绑掉。 */
export const KEYBIND_ROWS: readonly KeybindRow[] = [
  { keys: 'Ctrl-B', label: 'prefix' },
  { keys: 'c', label: 'new tab', tableKeys: ['c'] },
  { keys: 'n / p', label: 'next / prev tab', tableKeys: ['n', 'p'] },
  { keys: '1-9', label: 'go to tab #', tableKeys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] },
  { keys: 'v', label: 'split (side by side)', tableKeys: ['v'] },
  { keys: '-', label: 'split (stacked)', tableKeys: ['-'] },
  { keys: 'h j k l / arrows', label: 'move focus' },
  { keys: 'x', label: 'close pane', tableKeys: ['x'] },
  { keys: 'z', label: 'zoom pane', tableKeys: ['z'] },
  { keys: 'b', label: 'toggle sidebar', tableKeys: ['b'] },
  { keys: 'a', label: 'sidebar agents view', tableKeys: ['a'] },
  { keys: 'w', label: 'workspace picker', tableKeys: ['w'] },
  { keys: 'N', label: 'new workspace', tableKeys: ['N'] },
  { keys: '?', label: 'keybinds', tableKeys: ['?'] },
  { keys: 's', label: '(reserved for settings — intentionally unbound)' },
]
