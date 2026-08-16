/**
 * 工具项的折叠文案推导。
 *
 * `ConversationItem.view` 是 host 算好的渲染意图（`for: 'call' | 'result'`）——
 * **有就优先用它**，没有才回退到通用 JSON 摘要。这个模块只做纯函数推导，
 * 渲染在 `components/ToolRow.tsx`。
 */
import type { ConversationItem } from '@dshr/state'
import { compact, contentText, firstLine, truncate } from './text-utils.js'

export type ToolItem = Extract<ConversationItem, { kind: 'tool' }>

/** 没有 call view 时，从 args 里挑一个最有信息量的标量当标题。 */
const SALIENT_ARG_KEYS = [
  'command',
  'path',
  'file_path',
  'filePath',
  'pattern',
  'query',
  'url',
  'prompt',
] as const

function salientArg(args: unknown): string | undefined {
  if (args === null || args === undefined) return undefined
  // 事件流里的 arguments 常是**未解析的 JSON 串**——先解开再走标量挑选，
  // 不然 read 会显示成 `→ Read {"path":"."}` 而不是 `→ Read .`。
  if (typeof args === 'string') {
    try {
      const parsed: unknown = JSON.parse(args)
      if (typeof parsed === 'object' && parsed !== null) return salientArg(parsed)
    } catch {
      // 不是 JSON——就当普通文本参数。
    }
    return args
  }
  if (typeof args === 'object' && !Array.isArray(args)) {
    const record = args as Record<string, unknown>
    for (const key of SALIENT_ARG_KEYS) {
      const value = record[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return compact(args, 60)
}

/** 折叠后那一行括号里的部分：`⏺ bash(npm test)`。 */
export function toolCallTitle(item: ToolItem): string {
  const view = item.view
  if (view?.for === 'call') return truncate(firstLine(view.view.title), 80)
  const salient = salientArg(item.args)
  return salient === undefined ? '' : truncate(firstLine(salient), 80)
}

function fallbackSummary(result: unknown): string | undefined {
  if (result === null || result === undefined) return undefined
  const text = contentText(result) ?? (typeof result === 'string' ? result : undefined)
  if (text !== undefined) {
    const line = firstLine(text.trim())
    return line === '' ? undefined : truncate(line, 60)
  }
  return compact(result, 60)
}

/** 折叠后第二行的 dim 摘要。running 时没有摘要（由行内 `…` 表达）。 */
export function toolResultSummary(item: ToolItem): string | undefined {
  if (item.status === 'running') return undefined
  const view = item.view
  if (view?.for === 'result') {
    const v = view.view
    switch (v.card) {
      case 'generic': {
        return v.title ?? fallbackSummary(v.content) ?? fallbackSummary(item.result) ?? 'done'
      }
      case 'terminal': {
        const parts: string[] = []
        if (typeof v.exitCode === 'number') parts.push(`exit ${v.exitCode}`)
        else if (typeof v.signal === 'string') parts.push(v.signal)
        const output = typeof v.output === 'string' ? firstLine(v.output.trim()) : ''
        if (output !== '') parts.push(truncate(output, 60))
        if (parts.length > 0) return parts.join(' · ')
        return v.title ?? fallbackSummary(item.result) ?? 'done'
      }
      case 'diff': {
        const count = v.diffs.length
        return `${count} file${count === 1 ? '' : 's'} changed`
      }
      case 'search': {
        const noun =
          v.shape === 'matches'
            ? v.total === 1
              ? 'match'
              : 'matches'
            : v.total === 1
              ? 'path'
              : 'paths'
        return `${v.total} ${noun}${v.truncated ? ' (truncated)' : ''}`
      }
      case 'read': {
        return `${v.lines.length} of ${v.totalLines} lines`
      }
      case 'web': {
        if (v.kind === 'search') {
          const count = v.sources.length
          return `${count} source${count === 1 ? '' : 's'}${v.truncated ? ' (truncated)' : ''}`
        }
        return `HTTP ${v.statusCode} · ${truncate(v.url, 60)}`
      }
    }
  }
  return fallbackSummary(item.result) ?? 'done'
}
