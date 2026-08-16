/**
 * 必须最先加载：在任何 ink/chalk import 之前设置 FORCE_COLOR，
 * 否则非 TTY 下 chalk 剥掉颜色，颜色断言全废。取 3（truecolor）：
 * 主题是 hex 值，level 3 下 chalk 原样输出 `38;2;r;g;b`。
 */
process.env['FORCE_COLOR'] = process.env['FORCE_COLOR'] ?? '3'
