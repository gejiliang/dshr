import { Box, Text } from 'ink'
import { theme } from '../theme.js'

/**
 * dshr 的 ASCII logo，照 opencode `component/logo.tsx` + `logo.ts` 的做法：
 * 左半 textMuted 不加粗、右半 text 加粗，字符语义同上游--
 * `_` 画成「前景色 + 阴影底色的空格」，`^` 画成 ▀（前景），`~` 画成 ▀（阴影），
 * `,` 画成 ▄（阴影）。阴影 = 背景往前景混 25%。
 *
 * 字形沿用上游那套三行方块字风的等价变体（上游 font 里 D 与 O 同形，
 * 这套字本来就是抽象的）：
 *
 *   d = █▀▀█   s = █▀▀▀   h = █▀▀█   r = █▀▀█
 *       █__█       █^^^       █_^█       █▀__
 *       ▀▀▀▀       ▀▀▀▀       ▀▀▀▀       ▀▀▀▀
 */

/** `#rrggbb` 往前景混 25%（上游 `tint(background, fg, 0.25)`）。 */
function tint(hex: string, amount = 0.25): string {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * amount)
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * amount)
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * amount)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

const LOGO_LEFT = [
  '              ',
  '█▀▀█ █▀▀▀ ',
  '█__█ █^^^ ',
  '▀▀▀▀ ▀▀▀▀ ',
]

const LOGO_RIGHT = [
  '       ▄    ',
  '█▀▀█ █▀▀█',
  '█_^█ █▀__',
  '▀▀▀▀ ▀▀▀▀',
]

function LogoLine({ line, fg, shadow, bold }: { line: string; fg: string; shadow: string; bold?: boolean }) {
  return (
    <Text>
      {Array.from(line).map((char, index) => {
        if (char === '_') {
          return (
            <Text key={index} color={fg} backgroundColor={shadow} {...(bold ? { bold: true } : {})}>
              {' '}
            </Text>
          )
        }
        if (char === '^') {
          return (
            <Text key={index} color={fg} {...(bold ? { bold: true } : {})}>
              ▀
            </Text>
          )
        }
        if (char === '~') {
          return (
            <Text key={index} color={shadow} {...(bold ? { bold: true } : {})}>
              ▀
            </Text>
          )
        }
        if (char === ',') {
          return (
            <Text key={index} color={shadow} {...(bold ? { bold: true } : {})}>
              ▄
            </Text>
          )
        }
        return (
          <Text key={index} color={fg} {...(bold ? { bold: true } : {})}>
            {char}
          </Text>
        )
      })}
    </Text>
  )
}

/** 空会话时居中的 logo（上游 Home 路由的做法）。 */
export function Logo() {
  return (
    <Box flexDirection="column" gap={0}>
      {LOGO_LEFT.map((line, index) => (
        <Box key={index} flexDirection="row" gap={1}>
          <LogoLine line={line} fg={theme.textMuted} shadow={tint(theme.textMuted)} />
          <LogoLine
            line={LOGO_RIGHT[index] ?? ''}
            fg={theme.text}
            shadow={tint(theme.text)}
            bold
          />
        </Box>
      ))}
    </Box>
  )
}
