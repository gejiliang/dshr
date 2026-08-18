import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCommandRegistry } from '../lib/index.js'

test('注册与列出：按注册顺序，hidden 不列出', () => {
  const registry = createCommandRegistry()
  registry.register({ name: 'b.second', title: 'Second', run: () => {} })
  registry.register({ name: 'a.first', title: 'First', run: () => {} })
  registry.register({ name: 'c.hidden', title: 'Hidden', hidden: true, run: () => {} })
  assert.deepEqual(
    registry.list().map((c) => c.name),
    ['b.second', 'a.first'],
  )
})

test('按 name 派发：run 被调用；未知 name 返回 false', () => {
  const registry = createCommandRegistry()
  let calls = 0
  registry.register({ name: 'app.exit', title: 'Exit', run: () => calls++ })
  assert.strictEqual(registry.dispatch('app.exit'), true)
  assert.strictEqual(calls, 1)
  assert.strictEqual(registry.dispatch('no.such.command'), false)
  assert.strictEqual(calls, 1)
})

test('同名再注册：后注册的赢', () => {
  const registry = createCommandRegistry()
  let which = ''
  registry.register({ name: 'x', title: 'old', run: () => (which = 'old') })
  registry.register({ name: 'x', title: 'new', run: () => (which = 'new') })
  registry.dispatch('x')
  assert.strictEqual(which, 'new')
  assert.strictEqual(registry.list().length, 1)
})

test('异步 run：rejection 不炸进程，dispatch 照常返回 true', async () => {
  const registry = createCommandRegistry()
  registry.register({
    name: 'async.fail',
    title: 'Fail',
    run: () => Promise.reject(new Error('boom')),
  })
  assert.strictEqual(registry.dispatch('async.fail'), true)
  // 让 rejection 的 catch 跑完；若没接住这里会触发 unhandledRejection 导致测试进程失败。
  await new Promise((resolve) => setTimeout(resolve, 10))
})

test('命令的元数据形状：desc/category/bindings/suggested 原样保留', () => {
  const registry = createCommandRegistry()
  registry.register({
    name: 'session.new',
    title: 'New session',
    desc: 'Start fresh',
    category: 'Session',
    bindings: ['ctrl+x n'],
    suggested: true,
    run: () => {},
  })
  const command = registry.list()[0]
  assert.ok(command !== undefined)
  assert.strictEqual(command.desc, 'Start fresh')
  assert.strictEqual(command.category, 'Session')
  assert.deepEqual(command.bindings, ['ctrl+x n'])
  assert.strictEqual(command.suggested, true)
})
