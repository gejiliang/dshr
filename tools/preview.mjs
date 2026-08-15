#!/usr/bin/env node
/**
 * 把一帧真实的 dshr TUI 画面渲染到 stdout，用假数据。
 *
 * 视觉是产品要求，测试断言不了「好不好看」——这个脚本就是用来肉眼看的。
 *
 *   node tools/preview.mjs            # 正常会话
 *   node tools/preview.mjs approval   # 卡在审批上
 *   node tools/preview.mjs question   # 卡在提问上
 */
import { createElement as h } from 'react'
import { render, Box } from 'ink'
import { Conversation, Composer, StatusLine, PendingPrompt } from '@dshr/tui'

const mode = process.argv[2] ?? 'normal'

const items = [
  { kind: 'user', id: 'u1', text: '把 protocol 包的重连逻辑改成指数退避，上界 10 秒。' },
  {
    kind: 'reasoning',
    id: 'r1',
    streaming: false,
    text: '先看现在的实现——固定 500ms 重试，断线时会打爆 host。需要退避加抖动。',
  },
  { kind: 'assistant', id: 'a0', text: '先看一下当前的重连循环。', streaming: false },
  {
    kind: 'tool',
    id: 't1',
    callId: 'c1',
    name: 'read',
    status: 'ok',
    args: { path: 'packages/protocol/src/client.ts' },
  },
  {
    kind: 'tool',
    id: 't2',
    callId: 'c2',
    name: 'bash',
    status: 'error',
    args: { command: 'node --test packages/protocol/test/reconnect.test.ts' },
    result: { exitCode: 1, stderr: '1 failing' },
  },
  {
    kind: 'assistant',
    id: 'a1',
    streaming: true,
    text: '退避已经加上了：基数 500ms、上界取 maxReconnectDelayMs、50% 抖动。现在跑一下测试',
  },
]

const pending =
  mode === 'approval'
    ? {
        kind: 'approval',
        rpcId: 'rpc-1',
        approvalId: 'ap-1',
        toolName: 'bash',
        reason: 'rm -rf packages/protocol/lib',
      }
    : mode === 'question'
      ? {
          kind: 'question',
          rpcId: 'rpc-2',
          questions: [
            {
              id: 'q1',
              question: '退避上界用哪个值？',
              options: [{ label: '10s（默认）' }, { label: '30s' }],
            },
          ],
        }
      : undefined

const view = {
  sessionId: 'ses_demo',
  items,
  status: pending ? 'blocked' : 'working',
  pending,
  hasOlder: true,
  loadOlder: async () => {},
  subscribe: () => () => {},
}

render(
  h(
    Box,
    { flexDirection: 'column' },
    h(Conversation, { view, key: 'conv' }),
    pending
      ? h(PendingPrompt, { pending, onApprove: () => {}, onAnswer: () => {}, key: 'pend' })
      : null,
    h(Composer, { onSubmit: () => {}, disabled: false, key: 'comp' }),
    h(StatusLine, {
      key: 'status',
      model: 'deepseek-v4-flash',
      contextUsed: 41932,
      contextLimit: 131072,
      turnElapsedMs: 12400,
      connection: 'ready',
      agentStatus: view.status,
    }),
  ),
)

setTimeout(() => process.exit(0), 400)
