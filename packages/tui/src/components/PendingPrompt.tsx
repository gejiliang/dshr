import { useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { ApprovalOutcome, PendingInteraction, QuestionItems } from '@dshr/state'
import { theme } from '../theme.js'

export type ApprovalPending = Extract<PendingInteraction, { kind: 'approval' }>
export type QuestionPending = Extract<PendingInteraction, { kind: 'question' }>
export type QuestionItem = QuestionItems[number]

/**
 * `answerQuestion(sessionId, answers)` 里 answers 的形状--
 * dsh `AskUserQuestionAnswer` 的结构等价物（state 层按 `unknown` 接收）。
 */
export interface QuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

export interface QuestionAnswer {
  answers: QuestionAnswerItem[]
}

export interface PendingPromptProps {
  pending: PendingInteraction
  onApprove?: (outcome: ApprovalOutcome) => void
  onAnswer?: (answer: QuestionAnswer) => void
  /** 用户按 esc 放弃这个交互。 */
  onCancel?: () => void
}

/**
 * 审批与提问的交互面（opencode `permission.tsx` / `question.tsx` 的对齐）：
 * 左侧 warning 色 `┃` + `backgroundPanel` 底色的面板，
 * 底部一条 `backgroundElement` 的选项行（chip），选中项 warning 底色。
 */
export function PendingPrompt({ pending, onApprove, onAnswer, onCancel }: PendingPromptProps) {
  if (pending.kind === 'approval') {
    return (
      <ApprovalPrompt pending={pending} onApprove={onApprove ?? null} onCancel={onCancel ?? null} />
    )
  }
  return <QuestionPrompt pending={pending} onAnswer={onAnswer ?? null} onCancel={onCancel ?? null} />
}

const APPROVAL_OPTIONS = [
  { key: 'once', label: 'Allow once', outcome: 'allowed-once' },
  { key: 'reject', label: 'Reject', outcome: 'rejected' },
  { key: 'cancel', label: 'Cancel', outcome: 'cancelled' },
] as const

function ApprovalPrompt({
  pending,
  onApprove,
  onCancel,
}: {
  pending: ApprovalPending
  onApprove: ((outcome: ApprovalOutcome) => void) | null
  onCancel: (() => void) | null
}) {
  const [selected, setSelected] = useState<string>(APPROVAL_OPTIONS[0].key)
  const stateRef = useRef(selected)
  stateRef.current = selected

  const commit = (key: string): void => {
    const option = APPROVAL_OPTIONS.find((o) => o.key === key)
    if (!option) return
    onApprove?.(option.outcome)
  }

  useInput((input, key) => {
    const current = stateRef.current
    if (key.escape) {
      onCancel?.()
      return
    }
    if (key.return) {
      commit(current)
      return
    }
    if (key.leftArrow || input === 'h') {
      const index = APPROVAL_OPTIONS.findIndex((o) => o.key === current)
      const next = APPROVAL_OPTIONS[(index - 1 + APPROVAL_OPTIONS.length) % APPROVAL_OPTIONS.length]
      if (next) setSelected(next.key)
      return
    }
    if (key.rightArrow || input === 'l') {
      const index = APPROVAL_OPTIONS.findIndex((o) => o.key === current)
      const next = APPROVAL_OPTIONS[(index + 1) % APPROVAL_OPTIONS.length]
      if (next) setSelected(next.key)
      return
    }
    // 兼容旧键位：a 允许、r 拒绝、c 取消
    const ch = input.toLowerCase()
    if (ch === 'a' || ch === 'y') onApprove?.('allowed-once')
    else if (ch === 'r' || ch === 'n') onApprove?.('rejected')
    else if (ch === 'c') onApprove?.('cancelled')
  })

  const bar = <Text color={theme.warning}>┃</Text>

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        {bar}
        <Text backgroundColor={theme.backgroundPanel}>
          {'  '}
          <Text color={theme.warning}>△ </Text>
          <Text color={theme.text}>Permission required</Text>
          <Text color={theme.textMuted}> · {pending.toolName}</Text>
          {'  '}
        </Text>
      </Text>
      {pending.reason === undefined ? null : (
        <Text>
          {bar}
          <Text backgroundColor={theme.backgroundPanel} color={theme.textMuted}>
            {'  '}
            {pending.reason}
            {'  '}
          </Text>
        </Text>
      )}
      <Text>
        {bar}
        <Text backgroundColor={theme.backgroundPanel}>{'  '}</Text>
      </Text>
      <Box>
        <Text color={theme.borderActive}>╹</Text>
        <Box backgroundColor={theme.backgroundElement} flexDirection="row" gap={1}>
          {APPROVAL_OPTIONS.map((option) => {
            const active = option.key === selected
            return (
              <Text key={option.key} backgroundColor={active ? theme.warning : theme.backgroundPanel}>
                <Text color={active ? theme.background : theme.textMuted} bold={active}>
                  {' '}
                  {option.label}{' '}
                </Text>
              </Text>
            )
          })}
          <Text color={theme.text}>⇆ </Text>
          <Text color={theme.textMuted}>select</Text>
          <Text color={theme.text}>enter </Text>
          <Text color={theme.textMuted}>confirm</Text>
          <Text color={theme.text}>esc </Text>
          <Text color={theme.textMuted}>dismiss</Text>
          <Text> </Text>
        </Box>
      </Box>
    </Box>
  )
}

interface QuestionState {
  index: number
  answers: QuestionAnswerItem[]
  mode: 'menu' | 'text'
  draft: string
  picked: string[]
}

const INITIAL_QUESTION_STATE: QuestionState = {
  index: 0,
  answers: [],
  mode: 'menu',
  draft: '',
  picked: [],
}

function QuestionPrompt({
  pending,
  onAnswer,
  onCancel,
}: {
  pending: QuestionPending
  onAnswer: ((answer: QuestionAnswer) => void) | null
  onCancel: (() => void) | null
}) {
  const [state, setState] = useState<QuestionState>(INITIAL_QUESTION_STATE)
  // useInput 回调闭包可能过期、连续按键之间渲染未必已提交，
  // 状态镜像进 ref 且**同步更新**，不能只靠 setState。
  const stateRef = useRef(state)
  stateRef.current = state
  const apply = (next: QuestionState) => {
    stateRef.current = next
    setState(next)
  }

  const commit = (item: QuestionAnswerItem) => {
    const current = stateRef.current
    const answers = [...current.answers, item]
    if (current.index + 1 >= pending.questions.length) {
      onAnswer?.({ answers })
    } else {
      apply({ ...INITIAL_QUESTION_STATE, index: current.index + 1, answers })
    }
  }

  useInput((input, key) => {
    const current = stateRef.current
    const question = pending.questions[current.index]
    if (!question) return
    const options = question.options ?? []
    const multi = question.multiSelect === true
    const inText = current.mode === 'text' || options.length === 0

    if (key.escape) {
      if (current.mode === 'text' && options.length > 0) {
        apply({ ...current, mode: 'menu', draft: '' })
      } else {
        onCancel?.()
      }
      return
    }

    if (inText) {
      if (key.return) {
        commit({
          id: question.id,
          selected: current.picked,
          ...(current.draft !== '' ? { custom: current.draft } : {}),
        })
      } else if (key.backspace || key.delete) {
        apply({ ...current, draft: current.draft.slice(0, -1) })
      } else if (!key.ctrl && !key.meta && input !== '') {
        apply({ ...current, draft: current.draft + input.replace(/\r/g, '') })
      }
      return
    }

    if (key.return) {
      if (multi && current.picked.length > 0) commit({ id: question.id, selected: current.picked })
      return
    }
    if (input.toLowerCase() === 'e') {
      apply({ ...current, mode: 'text' })
      return
    }
    const digit = Number.parseInt(input, 10)
    if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) {
      const option = options[digit - 1]
      if (!option) return
      if (multi) {
        const picked = current.picked.includes(option.label)
          ? current.picked.filter((label) => label !== option.label)
          : [...current.picked, option.label]
        apply({ ...current, picked })
      } else {
        commit({ id: question.id, selected: [option.label] })
      }
    }
  })

  const question = pending.questions[state.index]
  if (!question) return null
  const options = question.options ?? []
  const multi = question.multiSelect === true
  const inText = state.mode === 'text' || options.length === 0
  const total = pending.questions.length
  const header =
    question.header ?? (question.intent?.kind === 'plan-review' ? 'plan review' : 'question')

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.accent}>┃</Text>
        <Text backgroundColor={theme.backgroundPanel}>
          {'  '}
          <Text color={theme.accent}>? </Text>
          <Text color={theme.text} bold>
            {header}
            {total > 1 ? ` (${state.index + 1}/${total})` : ''}
          </Text>
          {'  '}
        </Text>
      </Text>
      <Text>
        <Text color={theme.accent}>┃</Text>
        <Text backgroundColor={theme.backgroundPanel} color={theme.text}>
          {'  '}
          {question.question}{' '}
        </Text>
      </Text>
      {question.detail === undefined ? null : (
        <Text>
          <Text color={theme.accent}>┃</Text>
          <Text backgroundColor={theme.backgroundPanel} color={theme.textMuted}>
            {'  '}
            {question.detail}{' '}
          </Text>
        </Text>
      )}
      {options.map((option, index) => {
        const isPicked = state.picked.includes(option.label)
        const marker = multi ? (isPicked ? '[x]' : '[ ]') : `[${index + 1}]`
        return (
          <Text key={option.label}>
            <Text color={theme.accent}>┃</Text>
            <Text backgroundColor={theme.backgroundPanel}>
              {'  '}
              {marker} {option.label}
              {isPicked ? <Text color={theme.success}> ✓</Text> : null}
              {option.description === undefined ? null : (
                <Text color={theme.textMuted}> - {option.description}</Text>
              )}{' '}
            </Text>
          </Text>
        )
      })}
      {inText ? (
        <Text>
          <Text color={theme.accent}>┃</Text>
          <Text backgroundColor={theme.backgroundPanel}>
            {'  › '}
            {state.draft}
            <Text inverse> </Text>{' '}
          </Text>
        </Text>
      ) : (
        <Text>
          <Text color={theme.accent}>┃</Text>
          <Text backgroundColor={theme.backgroundPanel} color={theme.textMuted}>
            {'  '}
            {multi ? '1-9 toggle · enter confirm' : 'press number to answer'}
            {options.length > 0 ? ' · [e] custom text' : ''} · esc dismiss{' '}
          </Text>
        </Text>
      )}
    </Box>
  )
}
