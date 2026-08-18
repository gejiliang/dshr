#!/usr/bin/env node
/**
 * 把启动页那个方块字 logo 单独渲染出来看。**不需要 host、不需要模型。**
 *
 *   node tools/logo.mjs
 *
 * 为什么要有这个：logo 是四个 4×3 的抽象字形，**对着字符串推是推不出它读起来像什么的**。
 * 这一处返工过两次，两次都是人一眼读错才发现的（先被读成 `oshr`，再被读成 `dsbc`）。
 * 单测只能钉住「字形没被改掉」，钉不住「读不读得出来」——那只能靠眼睛。
 *
 * 改完 `packages/tui/src/components/Logo.tsx` 记得先 `npx tsc --build`，
 * 这个脚本跑的是构建产物。
 */
import { createElement as h } from 'react'
import { render } from 'ink'
import { Logo } from '@dshr/tui'

const app = render(h(Logo))
// 渲染一帧就够；给 ink 一点时间把帧刷出去再收摊。
setTimeout(() => {
  app.unmount()
}, 150)
