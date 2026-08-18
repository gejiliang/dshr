import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTypertSlashCommands, type TypertGatewayLike } from '../src/index.ts'
import type { SessionId } from '@dshr/state'

interface InvokeCall {
  namespace: string
  method: string
  args: Readonly<Record<string, unknown>>
}

/** 假网关：记录调用，按队列返回结果。 */
function fakeGateway(results: unknown[]): { gateway: TypertGatewayLike; calls: InvokeCall[] } {
  const calls: InvokeCall[] = []
  return {
    calls,
    gateway: {
      invoke(request: InvokeCall): Promise<unknown> {
        calls.push(request)
        const next = results.shift()
        if (next instanceof Error) return Promise.reject(next)
        return Promise.resolve(next)
      },
    },
  }
}

const s1 = 'session-1' as SessionId

test('list：打 commands/list，args 是 { agentId }，返回逐条校验过的命令表', async () => {
  const { gateway, calls } = fakeGateway([
    [
      { name: 'help', description: 'Show help' },
      { name: 'compact', description: 'Compact context', input: { hint: 'focus' } },
      { name: '' }, // 坏条目：丢
      'garbage',
    ],
  ])
  const source = createTypertSlashCommands(gateway)
  const list = await source.list(s1)
  assert.deepEqual(calls, [{ namespace: 'commands', method: 'list', args: { agentId: s1 } }])
  assert.deepEqual(list, [
    { name: 'help', description: 'Show help' },
    { name: 'compact', description: 'Compact context', takesInput: true },
  ])
})

test('list：结果不是数组就 reject（形状变了要响，不静默吞）', async () => {
  const { gateway } = fakeGateway([{ not: 'an array' }])
  const source = createTypertSlashCommands(gateway)
  await assert.rejects(() => source.list(s1), /unexpected result shape/)
})

test('run：打 commands/execute，args 是 { agentId, line }', async () => {
  const { gateway, calls } = fakeGateway([undefined])
  const source = createTypertSlashCommands(gateway)
  const receipt = await source.run(s1, '/help')
  assert.deepEqual(calls, [
    { namespace: 'commands', method: 'execute', args: { agentId: s1, line: '/help' } },
  ])
  assert.equal(receipt, undefined, '未被认领的行没有回执')
})

test('run：业务失败（result.kind === error）返回回执文本，成功没有回执', async () => {
  const { gateway } = fakeGateway([
    { commandId: 'c1', result: { kind: 'error', text: 'no active turn to compact' } },
    { commandId: 'c2', result: { kind: 'success' } },
  ])
  const source = createTypertSlashCommands(gateway)
  assert.equal(await source.run(s1, '/compact'), 'no active turn to compact')
  assert.equal(await source.run(s1, '/help'), undefined)
})

test('run：网关层失败直接 reject 出去', async () => {
  const { gateway } = fakeGateway([new Error('service-unavailable: commands')])
  const source = createTypertSlashCommands(gateway)
  await assert.rejects(() => source.run(s1, '/help'), /service-unavailable/)
})
