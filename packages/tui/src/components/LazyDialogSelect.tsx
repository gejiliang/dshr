import { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme.js'
import { DialogSelect, type DialogSelectOption } from './DialogSelect.js'
import type { ReactElement } from 'react'

export interface LazyDialogSelectProps {
  /** 左上角标题，右上角永远是 `esc`。 */
  readonly title: string
  /**
   * 取数（一般是 `@dshr/state` 的只读方法 + dialog-data 的构建器）。
   * **调用方要保证引用稳定**（useCallback）——它进 useEffect 依赖，变了就重取。
   */
  readonly load: () => Promise<readonly DialogSelectOption[]>
  readonly onClose: () => void
  /** 底部说明行（muted），如「去哪配」的指路。 */
  readonly note?: string
  readonly maxHeight?: number
}

type LoadResult =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly options: readonly DialogSelectOption[] }

/**
 * 「先取数、后展示」的只读对话框容器：loading → DialogSelect / 错误行。
 * E 批的设置 / 凭证 / provider / 模型清单全是这个形状——数据在 RPC 后面，
 * 对话框本身没有逻辑。
 *
 * 只读：回车与 esc 都是关。失败**有可读错误行**，不静默（章程：别注册点了没反应的命令）。
 */
export function LazyDialogSelect({
  title,
  load,
  onClose,
  note,
  maxHeight,
}: LazyDialogSelectProps): ReactElement {
  const [result, setResult] = useState<LoadResult>({ status: 'loading' })
  useEffect(() => {
    let alive = true
    setResult({ status: 'loading' })
    load().then(
      (options) => {
        if (alive) setResult({ status: 'ready', options })
      },
      (error: unknown) => {
        if (alive) {
          setResult({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    )
    return () => {
      alive = false
    }
  }, [load])

  // ready 态的键全归 DialogSelect；loading/error 态这里自己收 esc/回车。
  useInput((_input, key) => {
    if (result.status === 'ready') return
    if (key.escape || key.return) onClose()
  })

  if (result.status === 'ready') {
    return (
      <Box flexDirection="column">
        <DialogSelect
          title={title}
          options={result.options}
          onSelect={onClose}
          onCancel={onClose}
          {...(maxHeight !== undefined ? { maxHeight } : {})}
        />
        {note !== undefined ? (
          <>
            <Box height={1} flexShrink={0} />
            <Box paddingLeft={4} paddingRight={4}>
              <Text color={theme.textMuted}>{note}</Text>
            </Box>
          </>
        ) : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {/* 标题行与 DialogSelect 同位：paddingLeft=4 paddingRight=4，标题左、esc 右 */}
      <Box paddingLeft={4} paddingRight={4} justifyContent="space-between">
        <Text color={theme.text} bold>
          {title}
        </Text>
        <Text color={theme.textMuted}>esc</Text>
      </Box>
      <Box height={1} flexShrink={0} />
      <Box paddingLeft={4} paddingRight={4}>
        {result.status === 'loading' ? (
          <Text color={theme.textMuted}>Loading…</Text>
        ) : (
          <Text color={theme.error}>{result.message}</Text>
        )}
      </Box>
      {note !== undefined && result.status !== 'loading' ? (
        <>
          <Box height={1} flexShrink={0} />
          <Box paddingLeft={4} paddingRight={4}>
            <Text color={theme.textMuted}>{note}</Text>
          </Box>
        </>
      ) : null}
    </Box>
  )
}
