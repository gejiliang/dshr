import { useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from '../theme.js'

export interface DialogPromptProps {
  /** 左上角标题，右上角永远是 `esc`（与 DialogSelect 的标题行同构）。 */
  readonly title: string
  /** 初始内容（重命名带当前标题），非受控。 */
  readonly initial?: string
  readonly placeholder?: string
  /** enter 确认；**空文本不提交**（重命名这类空值本来就会被 host 拒，title-invalid）。 */
  readonly onSubmit: (text: string) => void
  /** esc 取消。 */
  readonly onCancel: () => void
}

/**
 * 单行文本输入对话框（重命名用）。`DialogSelect` 是选择用的，这是它的输入型兄弟：
 * 同一套 chrome（标题行 + esc、backgroundPanel 输入行），但内容是一行可编辑文本。
 *
 * 键位：字符在光标处插入、backspace/delete、左右方向键；enter 提交、esc 取消。
 */
export function DialogPrompt({ title, initial = '', placeholder, onSubmit, onCancel }: DialogPromptProps) {
  const [text, setText] = useState(initial)
  const [cursor, setCursor] = useState(initial.length)
  // 与 Composer 同一条纪律：useInput 回调闭包可能过期，状态镜像进 ref 且同步更新。
  const stateRef = useRef({ text, cursor })
  stateRef.current = { text, cursor }
  const apply = (next: { text: string; cursor: number }) => {
    stateRef.current = next
    setText(next.text)
    setCursor(next.cursor)
  }

  useInput((input, key) => {
    const { text: current, cursor: at } = stateRef.current
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      const trimmed = current.trim()
      if (trimmed !== '') onSubmit(trimmed)
      return
    }
    if (key.backspace || key.delete) {
      if (at > 0) apply({ text: current.slice(0, at - 1) + current.slice(at), cursor: at - 1 })
      return
    }
    if (key.leftArrow) {
      apply({ text: current, cursor: Math.max(0, at - 1) })
      return
    }
    if (key.rightArrow) {
      apply({ text: current, cursor: Math.min(current.length, at + 1) })
      return
    }
    if (key.ctrl || key.meta || key.tab || input === '') return
    const inserted = input.replace(/\r/g, '')
    apply({ text: current.slice(0, at) + inserted + current.slice(at), cursor: at + inserted.length })
  })

  const glyph = text[cursor] ?? ' '
  return (
    <Box flexDirection="column">
      {/* 标题行：与 DialogSelect 同（paddingLeft=4 paddingRight=4，标题左、esc 右） */}
      <Box paddingLeft={4} paddingRight={4} justifyContent="space-between">
        <Text color={theme.text} bold>
          {title}
        </Text>
        <Text color={theme.textMuted}>esc</Text>
      </Box>
      <Box height={1} flexShrink={0} />
      {/* 输入行：backgroundPanel 底色、inverse 光标块（同 DialogSelect 的搜索行） */}
      <Box paddingLeft={4} paddingRight={4} backgroundColor={theme.backgroundPanel}>
        <Text color={theme.text}>{text.slice(0, cursor)}</Text>
        <Text backgroundColor={theme.primary}>{glyph === ' ' ? ' ' : glyph}</Text>
        <Text color={theme.text}>{text.slice(cursor + (text[cursor] !== undefined ? 1 : 0))}</Text>
        {text === '' && placeholder !== undefined ? (
          <Text color={theme.textMuted}> {placeholder}</Text>
        ) : null}
      </Box>
      <Box height={1} flexShrink={0} />
      <Box paddingLeft={4} paddingRight={4}>
        <Text color={theme.textMuted}>enter confirm</Text>
      </Box>
    </Box>
  )
}
