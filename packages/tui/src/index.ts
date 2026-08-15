/**
 * `@dshr/tui`：会话视图与输入框（opencode 风格，Ink）。
 *
 * 数据形状只认 `@dshr/state` 的公开契约；本包不知道 HTTP/WebSocket 的存在。
 */
export { Conversation, ItemRow } from './components/Conversation.js'
export { Composer, hintFor, insertText } from './components/Composer.js'
export type { ComposerHint, ComposerProps } from './components/Composer.js'
export { StatusLine } from './components/StatusLine.js'
export type { ConnectionStatus, StatusLineProps } from './components/StatusLine.js'
export { PendingPrompt } from './components/PendingPrompt.js'
export type {
  PendingPromptProps,
  QuestionAnswer,
  QuestionAnswerItem,
} from './components/PendingPrompt.js'
export { colors } from './theme.js'
