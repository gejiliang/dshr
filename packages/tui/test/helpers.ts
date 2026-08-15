/**
 * 测试共享工具。
 *
 * 必须在任何 ink/chalk import 之前加载本模块——非 TTY 下 chalk 会剥掉颜色，
 * 颜色断言（失败红、竖线色）依赖 FORCE_COLOR。
 */
process.env['FORCE_COLOR'] = process.env['FORCE_COLOR'] ?? '2'

/** ANSI 转义码常量。 */
export const RED = '[31m'
export const YELLOW = '[33m'
export const CYAN = '[36m'
export const GRAY = '[90m'
export const DIM = '[2m'
export const ITALIC = '[3m'

/**
 * 造一个 ConversationView 假实现。**不连真 host**——`@dshr/state` 的实现
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
