import { useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme.js'
import { truncate, when } from '../text-utils.js'

export interface DialogSelectOption {
  readonly title: string
  /** 标题后面跟的 muted 说明，同一行、无分隔符。 */
  readonly label?: string
  /** 分组标题。 */
  readonly category?: string
  /** 右对齐的键位/标签。 */
  readonly footer?: string
  /** 当前项，gutter 画 ●。 */
  readonly current?: boolean
  /**
   * 标题的非选中色：`default` = theme.text（缺省）、`muted` = theme.textMuted、
   * `error` = theme.error。选中行总是反色（theme.primary 底 + background 字），不看 tone。
   */
  readonly tone?: 'default' | 'muted' | 'error'
  readonly value: string
}

export interface DialogSelectAction {
  readonly label: string
  readonly key: string
}

export interface DialogSelectProps {
  /** 左上角标题，右上角永远是 `esc`。 */
  readonly title: string
  readonly options: readonly DialogSelectOption[]
  /** 底部动作条（`label key` 对）。 */
  readonly actions?: readonly DialogSelectAction[]
  readonly onSelect: (value: string) => void
  readonly onCancel: () => void
  /** 搜索框占位符，默认 `Search`。 */
  readonly placeholder?: string
  /** 列表窗口高度（行）；超出时窗口跟随选中项滚动。不给则不截断。 */
  readonly maxHeight?: number
}

/**
 * fzf 式子序列匹配的简化版：大小写不敏感，逐字符按序命中即匹配；
 * 连续命中与词首（开头/空格/`-`/`/` 之后）命中各加一分。不命中返回 undefined。
 */
export function fuzzyScore(query: string, text: string): number | undefined {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (q === '') return 0
  let score = 0
  let qi = 0
  let lastHit = -2
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    score += 1
    if (ti === lastHit + 1) score += 1
    const prev = t[ti - 1]
    if (ti === 0 || prev === ' ' || prev === '-' || prev === '/') score += 1
    lastHit = ti
    qi++
  }
  return qi === q.length ? score : undefined
}

/**
 * 过滤 + 排序（opencode `dialog-select` 的行为，docs/coverage.md §四）：
 * 匹配 `title` 与 `category`，标题权重 2、分类权重 1，按得分降序（同分保持原序）；
 * **一旦有输入就丢掉 `Suggested` 分组**（实测如此，见 docs/opencode-dialogs.md 搜索态）。
 */
export function filterOptions(
  options: readonly DialogSelectOption[],
  query: string,
): DialogSelectOption[] {
  if (query === '') return [...options]
  const pool = options.filter((o) => o.category !== 'Suggested')
  const scored: Array<{ option: DialogSelectOption; score: number }> = []
  for (const option of pool) {
    const titleScore = fuzzyScore(query, option.title)
    const categoryScore =
      option.category !== undefined ? fuzzyScore(query, option.category) : undefined
    const score = Math.max(
      titleScore === undefined ? 0 : titleScore * 2,
      categoryScore === undefined ? 0 : categoryScore,
    )
    if (score > 0) scored.push({ option, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.option)
}

type Row =
  | { readonly kind: 'blank'; readonly key: string }
  | { readonly kind: 'category'; readonly key: string; readonly name: string }
  | { readonly kind: 'option'; readonly key: string; readonly option: DialogSelectOption; readonly index: number }

/** 按 category 分组（首现顺序），组间空一行；无 category 的条目不带标题。 */
function buildRows(options: readonly DialogSelectOption[]): Row[] {
  const groups = new Map<string | undefined, DialogSelectOption[]>()
  for (const option of options) {
    const bucket = groups.get(option.category)
    if (bucket === undefined) groups.set(option.category, [option])
    else bucket.push(option)
  }
  const rows: Row[] = []
  let index = 0
  let first = true
  for (const [category, bucket] of groups) {
    if (!first) rows.push({ kind: 'blank', key: `blank-${category ?? 'none'}` })
    first = false
    if (category !== undefined) rows.push({ kind: 'category', key: `cat-${category}`, name: category })
    for (const option of bucket) {
      rows.push({ kind: 'option', key: `opt-${option.value}-${index}`, option, index })
      index++
    }
  }
  return rows
}

/**
 * 通用可搜索选择对话框（opencode `packages/tui/src/ui/dialog-select.tsx` 的对齐，
 * 布局常数照 docs/coverage.md §四 的表）。opencode 里命令面板、模型对话框、
 * 会话列表都是它的实例。
 *
 * **不是浮层**——ink 没有绝对定位，dshr 的对话框整区接管会话区
 * （docs/opencode-dialogs.md §四第一节，已决策）。
 */
export function DialogSelect({
  title,
  options,
  actions,
  onSelect,
  onCancel,
  placeholder = 'Search',
  maxHeight,
}: DialogSelectProps) {
  const [state, setState] = useState({ query: '', selected: 0 })
  // useInput 回调闭包可能过期、连续按键之间渲染未必已提交，
  // 状态镜像进 ref 且**同步更新**，不能只靠 setState。
  const stateRef = useRef(state)
  stateRef.current = state
  const apply = (next: { query: string; selected: number }) => {
    stateRef.current = next
    setState(next)
  }

  useInput((input, key) => {
    const { query, selected } = stateRef.current
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      const visible = filterOptions(options, query)
      const option = visible[Math.min(selected, visible.length - 1)]
      if (option !== undefined) onSelect(option.value)
      return
    }
    if (key.upArrow) {
      apply({ query, selected: Math.max(0, selected - 1) })
      return
    }
    if (key.downArrow) {
      const visible = filterOptions(options, query)
      apply({ query, selected: Math.min(Math.max(0, visible.length - 1), selected + 1) })
      return
    }
    if (key.backspace || key.delete) {
      if (query !== '') apply({ query: query.slice(0, -1), selected: 0 })
      return
    }
    if (key.ctrl || key.meta || input === '') return
    apply({ query: query + input.replace(/\r/g, ''), selected: 0 })
  })

  const visible = filterOptions(options, state.query)
  const selected = Math.min(state.selected, Math.max(0, visible.length - 1))
  const rows = buildRows(visible)

  // 滚动窗口：超出 maxHeight 时窗口跟随选中项。
  let windowed = rows
  if (maxHeight !== undefined && rows.length > maxHeight) {
    const selectedRow = rows.findIndex((r) => r.kind === 'option' && r.index === selected)
    const start = selectedRow >= maxHeight ? selectedRow - maxHeight + 1 : 0
    windowed = rows.slice(start, start + maxHeight)
  }

  return (
    <Box flexDirection="column">
      {/* 标题行：paddingLeft=4 paddingRight=4，标题左、esc 右 */}
      <Box paddingLeft={4} paddingRight={4} justifyContent="space-between">
        <Text color={theme.text} bold>
          {title}
        </Text>
        <Text color={theme.textMuted}>esc</Text>
      </Box>
      <Box height={1} flexShrink={0} />
      {/* 搜索框：底色 backgroundPanel，光标 primary */}
      <Box paddingLeft={4} paddingRight={4} backgroundColor={theme.backgroundPanel}>
        {state.query === '' ? (
          <>
            <Text backgroundColor={theme.primary}> </Text>
            <Text color={theme.textMuted}>{placeholder}</Text>
          </>
        ) : (
          <>
            <Text color={theme.text}>{state.query}</Text>
            <Text backgroundColor={theme.primary}> </Text>
          </>
        )}
      </Box>
      <Box height={1} flexShrink={0} />
      {/* 列表：paddingLeft=1 paddingRight=1，分组间空一行 */}
      <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
        {rows.length === 0 ? (
          // 空结果：muted，对外 paddingLeft=4（列表的 1 + 这里的 3）
          <Box paddingLeft={3}>
            <Text color={theme.textMuted}>No results found</Text>
          </Box>
        ) : (
          windowed.map((row) => {
            if (row.kind === 'blank') return <Box key={row.key} height={1} flexShrink={0} />
            if (row.kind === 'category') {
              return (
                <Box key={row.key} paddingLeft={3}>
                  <Text color={theme.textMuted}>{row.name}</Text>
                </Box>
              )
            }
            const active = row.index === selected
            const tone = row.option.tone ?? 'default'
            const fg = active
              ? theme.background
              : tone === 'error'
                ? theme.error
                : tone === 'muted'
                  ? theme.textMuted
                  : theme.text
            return (
              // 条目：当前项有 gutter 时 paddingLeft=1（放 ●），否则 3；
              // paddingRight=3；选中行整行底色 theme.primary；标题截断到 61 列。
              <Box
                key={row.key}
                paddingLeft={row.option.current === true ? 1 : 3}
                paddingRight={3}
                justifyContent="space-between"
                {...when(active, { backgroundColor: theme.primary })}
              >
                <Text>
                  {row.option.current === true ? (
                    <Text color={active ? theme.background : theme.textMuted}>● </Text>
                  ) : null}
                  <Text color={fg} bold={active}>
                    {truncate(row.option.title, 61)}
                  </Text>
                  {row.option.label !== undefined ? (
                    <Text color={active ? theme.background : theme.textMuted}>
                      {' '}
                      {row.option.label}
                    </Text>
                  ) : null}
                </Text>
                {row.option.footer !== undefined ? (
                  <Text color={active ? theme.background : theme.textMuted}>{row.option.footer}</Text>
                ) : null}
              </Box>
            )
          })
        )}
      </Box>
      {/* 底部动作条：paddingLeft=4 paddingRight=2，两端对齐 */}
      {actions !== undefined && actions.length > 0 ? (
        <>
          <Box height={1} flexShrink={0} />
          <Box paddingLeft={4} paddingRight={2} justifyContent="space-between">
            <Box gap={2}>
              {actions.map((action) => (
                <Text key={action.key}>
                  <Text color={theme.textMuted}>{action.label} </Text>
                  <Text color={theme.text}>{action.key}</Text>
                </Text>
              ))}
            </Box>
            <Text> </Text>
          </Box>
        </>
      ) : null}
    </Box>
  )
}
