/** 纯文本小工具。全部无副作用，可在 node:test 里裸测。 */

export function firstLine(text: string): string {
  const index = text.indexOf('\n')
  return index === -1 ? text : text.slice(0, index)
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 把任意 JSON 值压成一行短文本，给没有 view 的工具结果兜底。 */
export function compact(value: unknown, max = 80): string {
  let raw: string
  if (typeof value === 'string') {
    raw = value
  } else {
    try {
      raw = JSON.stringify(value) ?? String(value)
    } catch {
      raw = String(value)
    }
  }
  return truncate(firstLine(raw.replace(/\s+/g, ' ').trim()), max)
}

/**
 * 从 ContentBlock[] 形状里抠纯文本。
 * 防御性写法：`@dshr/tui` 不 import dsh-llm 的类型，只认 `{type:'text', text:string}` 结构。
 */
export function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text)
    }
  }
  const joined = parts.join('\n').trim()
  return joined === '' ? undefined : joined
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function formatDuration(ms: number): string {
  // 与 opencode 的 Locale.duration 同构：256ms / 2.1s / 2m 8s / 1h 5m。
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.floor((ms % 60_000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  if (ms < 86_400_000) {
    const hours = Math.floor(ms / 3_600_000)
    const minutes = Math.floor((ms % 3_600_000) / 60_000)
    return `${hours}h ${minutes}m`
  }
  const days = Math.floor(ms / 86_400_000)
  const hours = Math.floor((ms % 86_400_000) / 3_600_000)
  return `${days}d ${hours}h`
}

/** 千分位整数（侧栏 tokens 展示用，与 opencode 的 toLocaleString 同观感）。 */
export function formatCount(n: number): string {
  return Number.isFinite(n) && n > 0 ? Math.round(n).toLocaleString('en-US') : '0'
}

/**
 * exactOptionalPropertyTypes 下安全的有条件 JSX props：
 * `<Text {...when(failed, { color: 'red' })}>`，避免显式传 `undefined`。
 */
export function when<T extends Record<string, unknown>>(
  cond: boolean,
  props: T,
): T | Record<string, never> {
  return cond ? props : {}
}

/** 东亚宽字符算 2 列的近似测宽（wrap 预算用，不追求完美）。 */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    width += wide ? 2 : 1
  }
  return width
}

/** 按显示宽度硬折行（近似）；返回行数，供尾部窗口预算用。 */
export function wrappedLineCount(text: string, width: number): number {
  if (width < 4) return text.split('\n').length
  let lines = 0
  for (const raw of text.split('\n')) {
    const w = displayWidth(raw)
    lines += Math.max(1, Math.ceil(w / width))
  }
  return lines
}
