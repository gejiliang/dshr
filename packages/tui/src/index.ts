/**
 * `@dshr/tui`：会话视图与输入框（opencode 风格，Ink）。
 *
 * 数据形状只认 `@dshr/state` 的公开契约；本包不知道 HTTP/WebSocket 的存在。
 */
export { Conversation, ItemRow } from './components/Conversation.js'
export { CommandRow, DividerRow, RetryRow, TodoRow } from './components/AwarenessRows.js'
export type { CommandItem, DividerItem, RetryItem, TodoViewItem } from './components/AwarenessRows.js'
export { QueueDock } from './components/QueueDock.js'
export { Composer, hintFor, insertText, setTerminalColumnsForTest } from './components/Composer.js'
export type { ComposerHint, ComposerProps } from './components/Composer.js'
export { Footer } from './components/Footer.js'
export type { ConnectionStatus, FooterProps } from './components/Footer.js'
export { Sidebar } from './components/Sidebar.js'
export type { SidebarProps } from './components/Sidebar.js'
export { Logo } from './components/Logo.js'
export { DialogSelect, filterOptions, fuzzyScore } from './components/DialogSelect.js'
export type {
  DialogSelectAction,
  DialogSelectOption,
  DialogSelectProps,
} from './components/DialogSelect.js'
export { DialogPrompt } from './components/DialogPrompt.js'
export type { DialogPromptProps } from './components/DialogPrompt.js'
export { CommandPalette } from './components/CommandPalette.js'
export type { CommandPaletteProps } from './components/CommandPalette.js'
export { createCommandRegistry } from './commands.js'
export type { Command, CommandRegistry } from './commands.js'
export { PendingPrompt } from './components/PendingPrompt.js'
export type {
  PendingPromptProps,
  QuestionAnswer,
  QuestionAnswerItem,
} from './components/PendingPrompt.js'
export { theme } from './theme.js'
