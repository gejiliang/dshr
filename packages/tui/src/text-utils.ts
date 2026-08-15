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
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
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
