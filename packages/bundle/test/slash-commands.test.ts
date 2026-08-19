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
  const outcome = await source.run(s1, '/help')
  assert.deepEqual(calls, [
    { namespace: 'commands', method: 'execute', args: { agentId: s1, line: '/help' } },
  ])
  assert.deepEqual(outcome, { kind: 'unclaimed' }, 'host 返回 undefined = 没被任何命令认领')
})

test('run：成功与「没被认领」必须分得开（回归）', async () => {
  // ⚠️ 这条测试的前身**是那个 bug 的共犯**：它断言「成功没有回执」并把成功和
  // 未认领都写成 `undefined`，于是把错误契约钉成了「正确行为」。
  // 真实后果：正常会话上成功执行一条命令，界面弹「did nothing — need a started
  // session」，自相矛盾。跨厂商评审（DeepSeek）挑出来的；我自己只测了 error 那条路。
  const { gateway } = fakeGateway([
    { commandId: 'c1', result: { kind: 'error', text: 'no active turn to compact' } },
    { commandId: 'c2', result: { kind: 'success' } },
    undefined,
  ])
  const source = createTypertSlashCommands(gateway)
  assert.deepEqual(await source.run(s1, '/compact'), { kind: 'error', text: 'no active turn to compact' })
  assert.deepEqual(await source.run(s1, '/plan'), { kind: 'ok' }, '成功必须是 ok，不能退化成 unclaimed')
  assert.deepEqual(await source.run(s1, '/nope'), { kind: 'unclaimed' })
})

test('run：execution 有值但 result 形状意外时按成功处理，不倒回 unclaimed（回归）', async () => {
  // 有 execution 就说明命令被认领并跑过了；此时倒回 unclaimed 会重现那句假回执。
  // 事件流（command/run / command/done）才是权威。
  const { gateway } = fakeGateway([{ commandId: 'c3' }, { commandId: 'c4', result: 'weird' }])
  const source = createTypertSlashCommands(gateway)
  assert.deepEqual(await source.run(s1, '/x'), { kind: 'ok' })
  assert.deepEqual(await source.run(s1, '/y'), { kind: 'ok' })
})

test('run：网关层失败直接 reject 出去', async () => {
  const { gateway } = fakeGateway([new Error('service-unavailable: commands')])
  const source = createTypertSlashCommands(gateway)
  await assert.rejects(() => source.run(s1, '/help'), /service-unavailable/)
})
