import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { createState } from '@dshr/state'
import { SessionApp } from '../lib/index.js'
import { FakeClient, sid } from '../../state/test/fake-client.ts'

const flush = async (ms = 40): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

test('空白会话上推一条 notice 必须立刻可见（三层回归）', async (t) => {
  t.after(cleanup)
  // 这条钉的是**同一类问题的三层**，每一层单独看都像「没反应」：
  //
  //   1. 动作返回「什么也没做」时被静默吞掉 → 必须给可读回执
  //   2. 空状态判定只认 user/assistant，notice 不算内容 → 画 logo 把通知顶掉
  //   3. SessionApp 只订阅 state、没订阅会话视图，而会话的订阅在 <Conversation>
  //      内部、只在**非空分支**挂载 → 空白会话上推通知时一个订阅者都没有，
  //      界面根本不重绘（临时探针实测：分支进了、notify 调了、屏幕纹丝不动）
  //
  // 三层里任何一层退回去，这条都会红。
  const client = new FakeClient()
  const state = createState({ client })
  const sessionId = sid('session-empty-notice')

  const app = render(h(SessionApp, { state, client, sessionId }))
  await flush()
  assert.ok((app.lastFrame() ?? '').includes('▀'), '一开始是空状态：画 logo')

  state.conversation(sessionId).pushNotice('nothing happened — and you should be told')
  await flush()

  const frame = app.lastFrame() ?? ''
  assert.ok(
    frame.includes('nothing happened — and you should be told'),
    `空白会话上的 notice 必须渲染出来: ${JSON.stringify(frame.slice(0, 400))}`,
  )
  app.unmount()
})
