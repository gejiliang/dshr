import { Box, Text } from 'ink'
import { theme } from '../theme.js'

/**
 * dshr 的 ASCII logo，照 opencode `component/logo.tsx` + `logo.ts` 的做法：
 * 左半 textMuted 不加粗、右半 text 加粗，字符语义同上游--
 * `_` 画成「前景色 + 阴影底色的空格」，`^` 画成 ▀（前景），`~` 画成 ▀（阴影），
 * `,` 画成 ▄（阴影）。阴影 = 背景往前景混 25%。
 *
 * ## 字形出处
 *
 * ⚠️ 早先这里是**自己近似出来的**「等价变体」，四个字母都不成形——
 * `d` 是个光秃秃的闭合方框（其实是 `o`），`s` 是 `█▀▀▀/█▀▀▀/▀▀▀▀`，根本读不出 dshr。
 * 2026-08-18 去拿了上游真字库（`sst/opencode` 的 `packages/tui/src/logo.ts`）重做。
 *
 * 上游那张表是给 "opencode" 写死的，从中能解出六个真字形：
 *
 *   o = █▀▀█   p = █▀▀█   e = █▀▀█   n = █▀▀▄   c = █▀▀▀
 *       █__█       █__█       █^^^       █__█       █___
 *       ▀▀▀▀       █▀▀▀       ▀▀▀▀       ▀~~▀       ▀▀▀▀
 *
 * **关键规则**：上游 `right` 的第 0 行是 `             ▄     `，那个 `▄` 落在第三个
 * 字形（`d`）的右立柱正上方——所以在这套字里 **`d` = `o` + 右立柱上方一个升部点**。
 * 「D 与 O 同形」只对方框部分成立，少了那一点就真的变成 o 了，这正是原来的 bug。
 *
 * `s` / `h` / `r` 上游没有（"opencode" 用不到），按同一套构形规则补出来。
 * **这三个是设计，不是抄来的**——所以判据只能是渲染出来给人读：
 *
 * ```sh
 * node tools/logo.mjs
 * ```
 *
 * 现在这版（第三稿，前两稿分别被读成 `dsbc` 和 `oshr`）：
 *
 * ```
 *    ▄      █
 * █▀▀█ █▀▀▀ █▀▀▄ █▀▀▄
 * █  █ ▀▀▀█ █  █ █
 * ▀▀▀▀ ▀▀▀▀ ▀  ▀ ▀
 *  d    s    h    r
 * ```
 */

/** `#rrggbb` 往前景混 25%（上游 `tint(background, fg, 0.25)`）。 */
function tint(hex: string, amount = 0.25): string {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * amount)
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * amount)
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * amount)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

/** 左半 `ds`：muted、不加粗（上游 `open` 的位置）。`▄` 是 d 的升部点。 */
const LOGO_LEFT = [
  '   ▄     ',
  '█▀▀█ █▀▀▀',
  '█__█ ^^^█',
  '▀▀▀▀ ▀▀▀▀',
]

/**
 * 右半 `hr`：text 色、加粗（上游 `code` 的位置）。
 *
 * ⚠️ 这两个字形返工过两次，**两次都是被人一眼读错才发现的**：
 *
 * - h 的底部原来写成 `▀~~▀`（照抄上游 n 的暗色中段）。暗色在终端里几乎看不出来，
 *   碗看着是闭合的，**读出来是 b**。改成真空格 `▀  ▀`：两条腿，跟 b 划清界限。
 * - h 的升部原来是 `▄`（照抄 d 的小凸起），不够重。改成整块 `█`——
 *   h 的立柱本来就该是通高的，这不是装饰。
 * - r 原来带一整条底边 `▀▀▀▀`，四面围起来，**读出来是 c**。r 的肩下面什么都没有，
 *   底边只留立柱那一格。
 *
 * 判据只能是**渲染出来给人读**：`node tools/logo.mjs`。别对着字符串推。
 */
const LOGO_RIGHT = [
  '█        ',
  '█▀▀▄ █▀▀▄',
  '█__█ █   ',
  '▀  ▀ ▀   ',
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
