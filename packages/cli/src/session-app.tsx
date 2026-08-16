/**
 * 一个 pane = 一个会话的全屏 TUI。
 *
 * **这里没有 tab、没有 pane、没有侧栏**——那些是 herdr 的活，dshr 跑在它的 pane 里。
 * 曾经有过一个 `@dshr/shell` 复刻了那一整套，是方向性错误，已删除
 * （要看历史：`git log -- packages/shell`）。
 *
 * 视觉判据在 docs/opencode-reference.md（实测截屏），不是凭印象。
 */
import type { DshrClient } from '@dshr/protocol'
import type { DshrState, SessionId } from '@dshr/state'
import { Composer, Conversation, PendingPrompt, StatusLine } from '@dshr/tui'
import { Box } from 'ink'
import { useEffect, useReducer, type ReactElement } from 'react'

export interface SessionAppProps {
  readonly state: DshrState
  readonly client: DshrClient
  readonly sessionId: SessionId
  /** host 的部署默认模型，状态行用。 */
  readonly model?: string
}

/** 从投影里取上下文用量（键名见 docs/dsh-contract.md 第五之二节）。 */
function contextUsage(state: DshrState, sessionId: SessionId): { used?: number; limit?: number } {
  const projections = state.projections(sessionId)
  const pressure = projections.get('contextPressure')
  const breakdown = projections.get('contextBreakdown')
  const limit =
    typeof pressure === 'object' && pressure !== null && 'contextWindow' in pressure
      ? Number((pressure as { contextWindow: unknown }).contextWindow)
      : undefined
  const used =
    typeof breakdown === 'object' && breakdown !== null
      ? Object.values(breakdown as Record<string, unknown>).reduce<number>(
          (sum, v) => sum + (typeof v === 'number' ? v : 0),
          0,
        )
      : undefined
  return {
    ...(used !== undefined && Number.isFinite(used) ? { used } : {}),
    ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
  }
}

export function SessionApp({ state, client, sessionId, model }: SessionAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => state.subscribe(bump), [state])

  const view = state.conversation(sessionId)
  const summary = state.sessions.get(sessionId)
  const pending = summary?.pending
  const { used, limit } = contextUsage(state, sessionId)

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Conversation view={view} />
      {pending !== undefined ? (
        <PendingPrompt
          pending={pending}
          onApprove={(outcome) => void state.answerApproval(sessionId, outcome)}
          onAnswer={(answer) => void state.answerQuestion(sessionId, answer)}
          onCancel={() => {
            // state 没有「放弃交互」动词：直接在协议层回错误，host 会广播 resolved。
            void client
              .respond(pending.rpcId, {
                ok: false,
                error: { code: 'cancelled', message: 'dismissed by user', details: {} },
              })
              .catch(() => {})
          }}
        />
      ) : (
        <Composer onSubmit={(text) => void state.prompt(sessionId, text)} />
      )}
      <StatusLine
        {...(model !== undefined ? { model } : {})}
        {...(used !== undefined ? { contextUsed: used } : {})}
        {...(limit !== undefined ? { contextLimit: limit } : {})}
        {...(summary !== undefined ? { agentStatus: summary.status } : {})}
        connection={client.state.status === 'ready' ? 'ready' : client.state.status === 'lost' ? 'lost' : 'connecting'}
      />
    </Box>
  )
}
