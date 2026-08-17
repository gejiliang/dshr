import { useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme.js'

export interface DialogPromptProps {
  /** 左上角标题，右上角永远是 `esc`。 */
  readonly title: string
  /** 输入框占位符（muted）。 */
  readonly placeholder?: string
  /** 标题下一行的 muted 说明。 */
  readonly hint?: string
  readonly onSubmit: (value: string) => void
  readonly onCancel: () => void
}

/**
 * 最小单行文本输入对话框（`Attach image` 这类要一个路径/名字的入口）。
 * C 批没留下 `DialogPrompt`，这是那个位置的最小实现：布局照 `DialogSelect`
 * 的标题行与搜索框（标题 paddingLeft=4、输入区 backgroundPanel 底色 + primary 光标块）。
 * 单行编辑：追加、退格、enter 提交、esc 取消——不做光标移动（输路径用不到）。
 */
export function DialogPrompt({ title, placeholder = '', hint, onSubmit, onCancel }: DialogPromptProps) {
  const [text, setText] = useState('')
  // useInput 回调闭包可能过期、连续按键之间渲染未必已提交——镜像进 ref 且同步更新。
  const textRef = useRef(text)
  textRef.current = text
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
      const value = textRef.current.trim()
      if (value !== '') onSubmit(value)
      return
    }
    if (key.backspace || key.delete) {
      apply(textRef.current.slice(0, -1))
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
      {hint !== undefined ? (
        <Box paddingLeft={4} paddingRight={4}>
          <Text color={theme.textMuted}>{hint}</Text>
        </Box>
      ) : null}
      <Box height={1} flexShrink={0} />
      {/* 输入框：底色 backgroundPanel，光标 primary */}
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
      <Box height={1} flexShrink={0} />
      <Box paddingLeft={4}>
        <Text>
          <Text color={theme.textMuted}>submit </Text>
          <Text color={theme.text}>enter</Text>
        </Text>
      </Box>
    </Box>
  )
}
