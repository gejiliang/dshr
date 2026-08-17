import { useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme.js'
import type { ReactElement } from 'react'

export interface TextPromptDialogProps {
  /** 左上角标题，右上角永远是 `esc`。 */
  readonly title: string
  /** 输入框占位符（muted）。 */
  readonly placeholder?: string
  /** 底部说明行（muted）。 */
  readonly hint?: string
  /** 回车提交（空串不提交，防手滑）。 */
  readonly onSubmit: (text: string) => void
  readonly onCancel: () => void
}

/**
 * 单行文本输入对话框（E 批用来给 `goal.create` 收 `objective`）。
 * 布局照 DialogSelect 的标题行 + 搜索框两行：标题左 esc 右，
 * 输入行底色 backgroundPanel、光标 primary。esc 取消，回车提交。
 */
export function TextPromptDialog({
  title,
  placeholder = 'Type here',
  hint,
  onSubmit,
  onCancel,
}: TextPromptDialogProps): ReactElement {
  const [text, setText] = useState('')
  // 与 DialogSelect 同一个理由：useInput 回调闭包可能过期，文本镜像进 ref 同步更新。
  const textRef = useRef(text)
  const apply = (next: string): void => {
    textRef.current = next
    setText(next)
  }

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      const trimmed = textRef.current.trim()
      if (trimmed !== '') onSubmit(trimmed)
      return
    }
    if (key.backspace || key.delete) {
      if (textRef.current !== '') apply(textRef.current.slice(0, -1))
      return
    }
    if (key.ctrl || key.meta || input === '') return
    apply(textRef.current + input.replace(/\r/g, ''))
  })

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
      {/* 输入行：底色 backgroundPanel，光标 primary（与 DialogSelect 搜索框同式） */}
      <Box paddingLeft={4} paddingRight={4} backgroundColor={theme.backgroundPanel}>
        {text === '' ? (
          <>
            <Text backgroundColor={theme.primary}> </Text>
            <Text color={theme.textMuted}>{placeholder}</Text>
          </>
        ) : (
          <>
            <Text color={theme.text}>{text}</Text>
            <Text backgroundColor={theme.primary}> </Text>
          </>
        )}
      </Box>
      {hint !== undefined ? (
        <>
          <Box height={1} flexShrink={0} />
          <Box paddingLeft={4} paddingRight={4}>
            <Text color={theme.textMuted}>{hint}</Text>
          </Box>
        </>
      ) : null}
    </Box>
  )
}
