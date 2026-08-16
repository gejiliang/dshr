/**
 * `@dshr/tui` 组件的最小 props 占位。
 *
 * tui 包的实现此刻在并行开发，shell 只认这组**结构契约**：真实组件由
 * 上层（cli）装配后注入，测试里注入假替身。等 tui 落地后，这里改做
 * `import type { … } from '@dshr/tui'` 的 re-export，形状不变。
 *
 * 形状刻意贴着 `@dshr/state` 的类型走，不发明自己的数据模型。
 */
import type { ComponentType } from 'react'
import type { AgentStatus, ConversationView, PendingInteraction, SessionSummary } from '@dshr/state'

/** 会话消息流。`focused` 由 shell 的 pane 焦点给出。 */
export interface ConversationProps {
  readonly view: ConversationView
  readonly focused: boolean
}

/** 底部输入框。`onSubmit` 由 shell 接到 `state.prompt()`。 */
export interface ComposerProps {
  readonly sessionId: SessionSummary['sessionId']
  readonly focused: boolean
  /** 有未决交互时输入框应让位给 PendingPrompt。 */
  readonly disabled?: boolean
  readonly onSubmit: (text: string) => void
  /**
   * **按键到达那一刻**再问一次该不该收。
   *
   * ⚠️ 只靠 `focused` / `disabled` 这两个 prop 会漏键：它们是上一次渲染的值，
   * 而 ink 异步渲染。前缀动作（`Ctrl-B v` 之类）之后输入框要重新打开，
   * 紧接着的键若在重渲染落地前到达就被**永久丢掉**——实测并行跑测试时稳定复现。
   * shell 传的是读 ref 的函数，永远是当前值。
   */
  readonly acceptsKey?: () => boolean
}

/**
 * 键位分层契约：Ctrl 组合键是 shell 前缀层的领域。
 * ink 的 useInput 是广播模型——前缀键（Ctrl-B）到达的同一拍 Composer 也会看到，
 * 而 shell 的 `prefixPending` 抑制要等下一拍才生效。
 * 所以 **Composer 必须忽略 `key.ctrl` 的按键**（正规文本输入框本来也这么做），
 * shell 侧则保证前缀后续键那一拍 `focused=false`。两层合起来才没有泄漏。
 */

/** pane 内的待决交互（审批 / 提问）提示条。 */
export interface PendingPromptProps {
  readonly pending: PendingInteraction
  readonly focused: boolean
}

/** 整壳状态行的数据片。 */
export interface StatusLineProps {
  readonly tabCount: number
  readonly activeTitle: string
  readonly activeStatus: AgentStatus | null
  /** 前缀键已按下、等待后续键——给用户一个可见提示。 */
  readonly prefixPending: boolean
  readonly sidebarOpen: boolean
}

/** 上层注入的 tui 组件束。 */
export interface ShellComponents {
  readonly Conversation: ComponentType<ConversationProps>
  readonly Composer: ComponentType<ComposerProps>
  readonly StatusLine: ComponentType<StatusLineProps>
  readonly PendingPrompt: ComponentType<PendingPromptProps>
}
