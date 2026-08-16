import './force-color.ts'
import { theme } from '../lib/index.js'

/** ANSI 转义码常量。 */
export const RED = fg(theme.error)
export const YELLOW = fg(theme.warning)
export const CYAN = fg(theme.info)
export const GRAY = fg(theme.textMuted)
export const PRIMARY = fg(theme.primary)
export const SECONDARY = fg(theme.secondary)
export const DIM = '\x1b[2m'
export const ITALIC = '\x1b[3m'

/** hex 颜色 -> chalk truecolor 前景码。 */
export function fg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `\x1b[38;2;${r};${g};${b}m`
}

/** hex 颜色 -> chalk truecolor 背景码。 */
export function bg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `\x1b[48;2;${r};${g};${b}m`
}

/**
 * 造一个 ConversationView 假实现。**不连真 host**--`@dshr/state` 的实现
 * 由另一个 worker 并行写，这里只依赖它的类型形状。
 */
export function makeView(items, opts = {}) {
  const listeners = new Set()
  const view = {
    sessionId: 'session-1',
    status: 'idle',
    hasOlder: false,
    ...opts,
    items,
    async loadOlder() {},
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** 测试辅助：整体替换 items 并通知订阅者（模拟流式增量）。 */
    _update(nextItems) {
      view.items = nextItems
      for (const listener of listeners) listener()
    },
  }
  return view
}

export function makeApproval(overrides = {}) {
  return {
    kind: 'approval',
    rpcId: 'rpc-1',
    approvalId: 'approval-1',
    toolName: 'bash',
    ...overrides,
  }
}

export function makeQuestion(questions) {
  return { kind: 'question', rpcId: 'rpc-2', questions }
}

export function flush(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** ink-testing-library 的完整输出（Static 与动态区都在 frames 里）。 */
export function outputOf(instance) {
  return instance.frames.join('')
}
