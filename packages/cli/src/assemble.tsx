/**
 * 装配层：把 `@dshr/tui` 的真实组件适配成 `@dshr/shell` 占位契约要的注入束。
 *
 * 落实 docs/integration.md 的五条裁决里归 cli 的部分：
 *
 * 2. **没有 `focused`，用 `disabled`**：shell 给的 `focused`/`disabled` 在这里折算成
 *    tui `Composer` 的 `disabled`，而 tui 的 `useInput(…, { isActive: !disabled })`
 *    保证 disabled 意味着**真的不消费按键**（ink 的 useInput 是广播模型）。
 * 3. **两条 StatusLine 是两个东西**：壳级信息（tab 数 / 前缀态 / 侧栏）在左边，
 *    tui 的会话级 `StatusLine`（模型 / 连接 / 会话状态）嵌在右边，同一行组合。
 * 4. **`PendingPrompt` 接上 `onApprove` / `onAnswer`**：接到 `state.answerApproval` /
 *    `state.answerQuestion`。漏了审批条就是「能看不能答」。
 *
 * 另外一条本层自己的决定：非焦点 pane 的 PendingPrompt 渲染成一行静态提示
 * （tui 的 PendingPrompt 没有 disabled 语义，它的 useInput 常开——直接挂上会让
 * 非焦点 pane 的审批条也吃按键）。
 */
import { Box, Text } from 'ink'
import { useEffect, useState, type ComponentType, type ReactElement } from 'react'
import type { ConnectionState, DshrClient, RpcId } from '@dshr/protocol'
import type { DshrState, SessionId } from '@dshr/state'
import type {
  ComposerProps as ShellComposerProps,
  ConversationProps as ShellConversationProps,
  PendingPromptProps as ShellPendingPromptProps,
  ShellComponents,
  StatusLineProps as ShellStatusLineProps,
} from '@dshr/shell'
import {
  Composer as TuiComposer,
  Conversation as TuiConversation,
  PendingPrompt as TuiPendingPrompt,
  StatusLine as TuiStatusLine,
  type ConnectionStatus,
} from '@dshr/tui'

/** 未决交互属于哪个会话：pending 里带着应答要回显的 rpcId，按它反查。 */
function findSessionByRpcId(state: DshrState, rpcId: RpcId): SessionId | undefined {
  for (const summary of state.sessions.values()) {
    if (summary.pending !== undefined && summary.pending.rpcId === rpcId) return summary.sessionId
  }
  return undefined
}

function ConversationAdapter({ view }: ShellConversationProps): ReactElement {
  return <TuiConversation view={view} />
}

/** 裁决 2：shell 的 `focused` + `disabled` 都折算成 tui 的 `disabled`。 */
function ComposerAdapter({ focused, disabled, acceptsKey, onSubmit }: ShellComposerProps): ReactElement {
  // ⚠️ `acceptsKey` 必须透传下去。它是**按键到达那一刻**的判活函数，
  // 而 `disabled` / `focused` 是上一次渲染的快照——只传后者会出两种毛病：
  // 前缀动作之后紧接着的键被丢掉，以及 `Ctrl-B ?` 这类键被壳和输入框各收一次
  // （帮助弹出来的同时 `?` 也被打进输入框）。两个都实测见过。
  return (
    <TuiComposer
      onSubmit={onSubmit}
      disabled={disabled === true || !focused}
      {...(acceptsKey !== undefined ? { acceptsKey } : {})}
    />
  )
}

function makePendingPromptAdapter(
  state: DshrState,
  client: DshrClient,
): ComponentType<ShellPendingPromptProps> {
  return function PendingPromptAdapter({ pending, focused }: ShellPendingPromptProps): ReactElement {
    // 非焦点 pane：一行静态提示，不挂任何 useInput——按键只属于焦点 pane。
    if (!focused) {
      return (
        <Text dimColor>
          {pending.kind === 'approval' ? `! 待审批: ${pending.toolName}（切到此 pane 作答）` : '? 待回答问题（切到此 pane 作答）'}
        </Text>
      )
    }

    const sessionId = findSessionByRpcId(state, pending.rpcId)
    const approve =
      sessionId === undefined
        ? undefined
        : (outcome: Parameters<DshrState['answerApproval']>[1]) => {
            void state.answerApproval(sessionId, outcome).catch(() => {})
          }
    const answer =
      sessionId === undefined
        ? undefined
        : (value: unknown) => {
            void state.answerQuestion(sessionId, value).catch(() => {})
          }
    const onCancel =
      pending.kind === 'approval'
        ? approve === undefined
          ? undefined
          : () => approve('cancelled')
        : () => {
            // state 没有「放弃提问」动词；直接在协议层回错误结果，
            // host 会广播 question/resolved{outcome:'cancelled'}，state 随之清掉未决。
            void client
              .respond(pending.rpcId, {
                ok: false,
                error: { code: 'cancelled', message: 'dismissed by user', details: {} },
              })
              .catch(() => {})
          }

    return (
      <TuiPendingPrompt
        pending={pending}
        {...(approve !== undefined ? { onApprove: approve } : {})}
        {...(answer !== undefined ? { onAnswer: answer } : {})}
        {...(onCancel !== undefined ? { onCancel } : {})}
      />
    )
  }
}

/** 裁决 3：壳级状态行 + 右侧嵌 tui 的会话级 StatusLine。 */
function makeStatusLineAdapter(client: DshrClient): ComponentType<ShellStatusLineProps> {
  return function StatusLineAdapter({
    tabCount,
    activeTitle,
    activeStatus,
    prefixPending,
    sidebarOpen,
  }: ShellStatusLineProps): ReactElement {
    const [conn, setConn] = useState<ConnectionState>(client.state)
    useEffect(() => client.onConnectionChange(setConn), [])

    const model = conn.status === 'ready' ? conn.host.model : undefined
    const left = [
      `tabs:${tabCount}`,
      activeTitle !== '' ? activeTitle : '(无会话)',
      ...(prefixPending ? ['前缀已按下'] : []),
      ...(sidebarOpen ? [] : ['侧栏关']),
    ].join(' · ')

    return (
      <Box justifyContent="space-between" width="100%">
        <Text dimColor wrap="truncate-end">
          {left}
        </Text>
        <TuiStatusLine
          connection={conn.status as ConnectionStatus}
          {...(model !== undefined ? { model } : {})}
          {...(activeStatus !== null ? { agentStatus: activeStatus } : {})}
        />
      </Box>
    )
  }
}

export interface AssembleOptions {
  readonly state: DshrState
  readonly client: DshrClient
}

/** 装配出口：给 `<Shell>` 的 components 注入束。 */
export function buildShellComponents({ state, client }: AssembleOptions): ShellComponents {
  return {
    Conversation: ConversationAdapter,
    Composer: ComposerAdapter,
    StatusLine: makeStatusLineAdapter(client),
    PendingPrompt: makePendingPromptAdapter(state, client),
  }
}
