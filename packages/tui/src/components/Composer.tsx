import { useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { colors } from '../theme.js'
import { when } from '../text-utils.js'

export interface ComposerProps {
  onSubmit: (text: string) => void
  disabled?: boolean
  placeholder?: string
  /** 初始内容（恢复草稿 / 测试用），非受控。 */
  initialText?: string
}

export type ComposerHint = 'command' | 'reference' | null

/** `/` 开头触发命令提示；光标所在 token 以 `@` 开头触发引用提示。 */
export function hintFor(text: string, cursor: number): ComposerHint {
  if (text.startsWith('/')) return 'command'
  const upto = text.slice(0, cursor)
  const tokenStart = Math.max(upto.lastIndexOf(' '), upto.lastIndexOf('\n')) + 1
  if (upto.slice(tokenStart).startsWith('@')) return 'reference'
  return null
}

/** 在 cursor 处插入文本（可含换行）。 */
export function insertText(
  text: string,
  cursor: number,
  insertion: string,
): { text: string; cursor: number } {
  const next = text.slice(0, cursor) + insertion + text.slice(cursor)
  return { text: next, cursor: cursor + insertion.length }
}

/** 光标按行上下移动，尽量保持列。 */
function moveCursorLine(text: string, cursor: number, delta: -1 | 1): number {
  const lines = text.split('\n')
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  let current = lines.length - 1
  for (let i = 0; i < lines.length; i++) {
    const start = starts[i] ?? 0
    const end = start + (lines[i]?.length ?? 0)
    if (cursor <= end) {
      current = i
      break
    }
  }
  const target = current + delta
  if (target < 0 || target >= lines.length) return cursor
  const column = cursor - (starts[current] ?? 0)
  return (starts[target] ?? 0) + Math.min(column, lines[target]?.length ?? 0)
}

/**
 * 底部输入框——整个界面唯一的一条边框（round）。
 *
 * 多行：Shift+Enter（kitty 协议）或 Ctrl+J 插入换行，Enter 提交。
 * 光标用 inverse 渲染；支持左右/上下移动、退格、粘贴多行。
 * `/` 开头触发命令提示、`@` token 触发引用提示；候选列表这一版是空面板。
 */
export function Composer({
  onSubmit,
  disabled = false,
  placeholder = 'Type a message…  (shift+enter / ctrl+j for newline)',
  initialText = '',
}: ComposerProps) {
  const [text, setText] = useState(initialText)
  const [cursor, setCursor] = useState(initialText.length)
  // useInput 回调闭包可能过期、连续按键之间渲染未必已提交（粘贴就是一个事件一串字符），
  // 状态镜像进 ref 且**同步更新**，不能只靠 setState。
  const stateRef = useRef({ text, cursor })
  stateRef.current = { text, cursor }
  const apply = (next: { text: string; cursor: number }) => {
    stateRef.current = next
    setText(next.text)
    setCursor(next.cursor)
  }

  useInput(
    (input, key) => {
      const { text: current, cursor: at } = stateRef.current
      if (key.escape || key.tab) return
      if (key.return) {
        if (key.shift) {
          apply(insertText(current, at, '\n'))
          return
        }
        if (current.trim() !== '') onSubmit(current)
        apply({ text: '', cursor: 0 })
        return
      }
      // 终端的 Backspace 键多数发 '\x7f'，ink 把它解析成 delete——两个都按退格处理。
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
      if (key.upArrow) {
        apply({ text: current, cursor: moveCursorLine(current, at, -1) })
        return
      }
      if (key.downArrow) {
        apply({ text: current, cursor: moveCursorLine(current, at, 1) })
        return
      }
      if (key.ctrl || key.meta || input === '') return
      // '\n'（Ctrl+J / 粘贴里的换行）走通用插入路径，天然支持多行。
      apply(insertText(current, at, input.replace(/\r\n?/g, '\n')))
    },
    { isActive: !disabled },
  )

  const hint = hintFor(text, cursor)
  const before = text.slice(0, cursor)
  const atChar = text[cursor]
  const after = atChar === undefined ? '' : text.slice(cursor + 1)
  const cursorGlyph = atChar === undefined ? ' ' : atChar === '\n' ? ' \n' : atChar

  return (
    <Box flexDirection="column">
      {hint === null ? null : (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>{hint === 'command' ? '/ commands' : '@ references'}</Text>
          <Text dimColor> (no candidates wired yet)</Text>
        </Box>
      )}
      <Box borderStyle="round" paddingX={1} {...when(disabled, { borderColor: colors.chrome })}>
        {text === '' ? (
          <Text>
            <Text inverse> </Text>
            <Text dimColor>{placeholder}</Text>
          </Text>
        ) : (
          <Text>
            {before}
            <Text inverse>{cursorGlyph}</Text>
            {after}
          </Text>
        )}
      </Box>
    </Box>
  )
}
