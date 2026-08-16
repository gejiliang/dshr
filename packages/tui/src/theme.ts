/**
 * 主题 token：名字与取值都照搬 opencode（`packages/tui/src/theme/assets/opencode.json`
 * 的 dark 变体）。上游用 RGBA，ink 认 hex，值一一对应：
 *
 *   background #0a0a0a   backgroundPanel #141414   backgroundElement #1e1e1e
 *   border    #484848   borderActive    #606060   borderSubtle      #323232
 *   text      #eeeeee   textMuted       #808080
 *   primary   #fab283   secondary       #5c9cf5   accent            #9d7cd8
 *   error     #e06c75   warning         #f5a742   success           #7fd88f
 *   info      #56b6c2
 *
 * 只有状态才上色；chrome 一律 textMuted。上游还有 markdown/syntax/diff 一组
 * token，dshr 暂时不渲染那些视图，先不抄。
 */
export const theme = {
  background: '#0a0a0a',
  backgroundPanel: '#141414',
  backgroundElement: '#1e1e1e',
  border: '#484848',
  borderActive: '#606060',
  borderSubtle: '#323232',
  text: '#eeeeee',
  textMuted: '#808080',
  primary: '#fab283',
  secondary: '#5c9cf5',
  accent: '#9d7cd8',
  error: '#e06c75',
  warning: '#f5a742',
  success: '#7fd88f',
  info: '#56b6c2',
} as const

export type ThemeToken = keyof typeof theme
