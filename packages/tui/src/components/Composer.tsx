import { useRef, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { theme } from '../theme.js'

/** composer 上挂着的一张待发图（字节在 state 层的 ImageDraft 里，这里只拿展示要的）。 */
export interface ComposerAttachment {
  readonly name: string
  readonly bytes: number
}

export interface ComposerProps {
  onSubmit: (text: string) => void
  disabled?: boolean
  placeholder?: string
  /** 初始内容（恢复草稿 / 测试用），非受控。 */
  initialText?: string
  /** 元信息行：模式（agent preset）与模型。opencode 写在输入框内那一行。 */
  preset?: string
  model?: string
  provider?: string
  /**
   * 会话里见过 `plan/mode` 事件（形状还没打到，只有「发生过」一个比特——
   * 在模式位留一个 muted 的 `· plan/mode` 标记，不断言是进还是出）。
   */
  planModeSeen?: boolean
  /** 输入面板宽度（列）。缺省用终端宽度（减去右侧信息列后由外层传入）。 */
  width?: number
  /** agent 在跑时，快捷键提示行的左侧换成 `esc interrupt`（opencode 的运行态提示）。 */
  working?: boolean
  /** esc 中断当前轮。 */
  onInterrupt?: () => void
  /**
   * **按键到达那一刻**再问一次「现在该不该收这个键」。
   *
   * ⚠️ 光靠 `disabled` 这个 prop 不够：它是**上一次渲染**的值，而 ink 是异步渲染。
   * 外壳在前缀动作（如 `Ctrl-B v`）之后要把输入框重新打开，若紧接着的键在重渲染
   * 落地之前到达，就会被当成「还关着」而**永久丢掉**--不是延迟，是没了。
   * 实测：并行跑测试时稳定复现，等 5 秒也等不到那个键。
   *
   * 所以外壳用它传一个**读当前值**的函数（读 ref，不读 state）。
   * 不传则只看 `disabled`。
   */
  acceptsKey?: () => boolean
  /** 已挂上的待发图片；有就画在输入框上方，并能用 ctrl+u 一次清空。 */
  attachments?: readonly ComposerAttachment[]
  /** 清空全部附件（ctrl+u，只在有附件时收这个键）。 */
  onClearAttachments?: () => void
  /** 一条要用户看见的信息（如附件超限被拒的理由），画在输入框上方，error 色。 */
  notice?: string
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

function titlecase(text: string): string {
  return text === '' ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`
}

/** 上游 home 路由的占位例子池（`Ask anything... "<example>"`），每次提交轮换一个。 */
const PLACEHOLDER_EXAMPLES = [
  'Fix a TODO in the codebase',
  'What is the tech stack of this project?',
  'Fix broken tests',
] as const
let placeholderCursor = 0

function defaultPlaceholder(): string {
  return `Ask anything... "${PLACEHOLDER_EXAMPLES[placeholderCursor % PLACEHOLDER_EXAMPLES.length]}"`
}

/** 非组件环境（测试）注入终端宽度；ink 环境下由 useStdout 提供。 */
let columnsOverride = 0
export function setTerminalColumnsForTest(columns: number): void {
  columnsOverride = columns
}

/**
 * 底部输入框：**不是框**。左边一条 `┃`、左下角 `╹`（都是 agent 色--上游 Build =
 * secondary，`tint(theme.border, highlight())`），内容区 `backgroundElement` 底色，
 * 底部 `▀` 横线--没有右边框、没有上边框、没有圆角（opencode `component/prompt`
 * 的逐条对齐）。模式与模型写在框内最后一行（`Standard · model provider`），
 * 下面一行是快捷键提示。
 *
 * 占位提示照上游 home 路由：`Ask anything... "<example>"`，例子池每次提交轮换。
 *
 * 多行：Shift+Enter（kitty 协议）或 Ctrl+J 插入换行，Enter 提交。
 * 光标用 inverse 渲染。`/` 触发命令提示、`@` token 触发引用提示；
 * 候选列表这一版是空面板。
 */
export function Composer({
  onSubmit,
  disabled = false,
  placeholder,
  initialText = '',
  preset,
  model,
  provider,
  planModeSeen = false,
  width: widthProp,
  working = false,
  onInterrupt,
  acceptsKey,
  attachments = [],
  onClearAttachments,
  notice,
}: ComposerProps) {
  const { stdout } = useStdout()
  const liveColumns = stdout !== undefined && stdout.columns > 0 ? stdout.columns : 0
  const width =
    widthProp !== undefined
      ? widthProp
      : columnsOverride > 0
        ? columnsOverride
        : liveColumns > 0
          ? liveColumns
          : 80

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
      // 按键到达那一刻现问一次--`disabled` 是上一次渲染的值，会漏键（见 acceptsKey 的注释）。
      if (acceptsKey !== undefined && !acceptsKey()) return
      const { text: current, cursor: at } = stateRef.current
      if (key.escape) {
        onInterrupt?.()
        return
      }
      if (key.tab) return
      // ctrl+u：清空待发附件（只在有附件时收；没附件时它什么也不是，别吃）。
      if (key.ctrl && input === 'u') {
        if (attachments.length > 0) onClearAttachments?.()
        return
      }
      if (key.return) {
        if (key.shift) {
          apply(insertText(current, at, '\n'))
          return
        }
        if (current.trim() !== '') {
          placeholderCursor += 1
          onSubmit(current)
        }
        apply({ text: '', cursor: 0 })
        return
      }
      // 终端的 Backspace 键多数发 '\x7f'，ink 把它解析成 delete--两个都按退格处理。
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
    // 给了 acceptsKey 就让 ink 始终把键送进来，由上面那行**在按键时刻**判断收不收；
    // 否则回到只看 disabled 的老行为。
    { isActive: acceptsKey !== undefined ? true : !disabled },
  )

  const hint = hintFor(text, cursor)
  const shownPlaceholder = placeholder ?? defaultPlaceholder()
  const lines = text === '' ? [''] : text.split('\n')
  // 光标落在第几行、该行起始偏移
  let cursorLine = 0
  let lineStart = 0
  {
    let offset = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (cursor <= offset + line.length) {
        cursorLine = i
        lineStart = offset
        break
      }
      offset += line.length + 1
      if (i === lines.length - 1) {
        cursorLine = i
        lineStart = offset - (line.length + 1)
      }
    }
  }

  const bar = <Text color={theme.secondary}>┃</Text>
  const fill = (n: number): string => ' '.repeat(Math.max(0, n))

  return (
    <Box flexDirection="column">
      {hint === null ? null : (
        <Box flexDirection="column" paddingLeft={1}>
          <Text color={theme.textMuted}>{hint === 'command' ? '/ commands' : '@ references'}</Text>
          <Text color={theme.textMuted}> (no candidates wired yet)</Text>
        </Box>
      )}
      {notice !== undefined ? (
        <Box paddingLeft={1}>
          <Text color={theme.error}>{notice}</Text>
        </Box>
      ) : null}
      {attachments.length > 0 ? (
        <Box paddingLeft={1}>
          <Text>
            <Text color={theme.secondary}>📎 {attachments.length} image{attachments.length > 1 ? 's' : ''}</Text>
            <Text color={theme.textMuted}>
              {' '}{attachments.map((a) => a.name).join(', ')} · ctrl+u{' '}
            </Text>
            <Text color={theme.text}>clear</Text>
          </Text>
        </Box>
      ) : null}
      {/* 顶 padding 行 */}
      <Text>
        {bar}
        <Text backgroundColor={theme.backgroundElement}>{fill(width - 1)}</Text>
      </Text>
      {/* 输入区：空则一行占位提示；有内容则逐行，光标块落在光标行 */}
      {text === '' ? (
        <Text>
          {bar}
          <Text backgroundColor={theme.backgroundElement}>
            {' '}
            <Text inverse> </Text>
            <Text color={theme.textMuted}>{shownPlaceholder}</Text>
            <Text backgroundColor={theme.backgroundElement}>{fill(width - shownPlaceholder.length - 4)}</Text>
          </Text>
        </Text>
      ) : (
        lines.map((line, index) => {
          const onCursorLine = index === cursorLine
          const at = onCursorLine ? cursor - lineStart : -1
          const glyph = at >= 0 ? (line[at] ?? ' ') : ''
          return (
            <Text key={index}>
              {bar}
              <Text backgroundColor={theme.backgroundElement} color={theme.text}>
                {'  '}
                {onCursorLine ? line.slice(0, at) : line}
                {onCursorLine ? <Text inverse bold>{glyph === '' ? ' ' : glyph}</Text> : null}
                {onCursorLine ? line.slice(at + glyph.length) : ''}
              </Text>
            </Text>
          )
        })
      )}
      {/* meta 行前的空行 */}
      <Text>
        {bar}
        <Text backgroundColor={theme.backgroundElement}>{fill(width - 1)}</Text>
      </Text>
      {/* 模式与模型行：`Standard · model provider` */}
      <Text>
        {bar}
        <Text backgroundColor={theme.backgroundElement}>
          <Text color={theme.secondary}>  {titlecase(preset ?? 'standard')}</Text>
          {planModeSeen ? <Text color={theme.textMuted}> · plan/mode</Text> : null}
          {model !== undefined ? (
            <>
              <Text color={theme.textMuted}> · </Text>
              <Text color={theme.text}>{model}</Text>
              {provider !== undefined ? <Text color={theme.textMuted}> {provider}</Text> : null}
            </>
          ) : null}
        </Text>
      </Text>
      {/* 底线：╹ + ▀ */}
      <Text>
        <Text color={theme.secondary}>╹</Text>
        <Text color={theme.backgroundElement}>{'▀'.repeat(Math.max(0, width - 1))}</Text>
      </Text>
      {/* 快捷键提示行 */}
      <Box justifyContent={working ? 'space-between' : 'flex-end'}>
        {working ? (
          <Text>
            <Text color={theme.text}>… esc </Text>
            <Text color={theme.textMuted}>interrupt</Text>
          </Text>
        ) : null}
        <Box gap={2}>
          <Text>
            <Text color={theme.text}>enter </Text>
            <Text color={theme.textMuted}>send</Text>
          </Text>
          <Text>
            <Text color={theme.text}>shift+enter </Text>
            <Text color={theme.textMuted}>newline</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
