#!/usr/bin/env node
/**
 * 验一件事：**dsh 自带的客户端载体能不能在 Node 里直接用。**
 *
 * `@deepseek-ai/dsh-client-connection/client` 导出 `AbstractApiClient`
 * （只需实现 `doFetch` / `openMux` / `openHost`）与 `WebApiClient`（浏览器实现）。
 * 如果 Node 22+ 的全局 `fetch` / `WebSocket` 够用，`WebApiClient` 可能开箱即跑——
 * 那 `@dshr/protocol` 那 546 行就是在重造上游已有的东西。
 *
 *   node tools/probe-upstream-client.mjs [baseUrl]
 */
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:39081'

const mod = await import('@deepseek-ai/dsh-client-connection/client')
console.log('导出的东西:', Object.keys(mod).sort().join(' '))

const { WebApiClient, AbstractApiClient, RpcId } = mod
console.log('WebApiClient:', typeof WebApiClient)
console.log('AbstractApiClient:', typeof AbstractApiClient)
console.log('全局 fetch:', typeof fetch, ' 全局 WebSocket:', typeof WebSocket)

if (typeof WebApiClient !== 'function') {
  console.log('没有 WebApiClient，跳过实跑')
  process.exit(0)
}

// AbstractApiClient 的构造签名未知，先打出来
console.log('WebApiClient.length (构造参数个数):', WebApiClient.length)

let client
try {
  client = new WebApiClient(new URL(baseUrl))
} catch (error) {
  console.log('用 URL 构造失败:', error instanceof Error ? error.message : String(error))
  try {
    client = new WebApiClient({ baseUrl })
  } catch (error2) {
    console.log('用对象构造也失败:', error2 instanceof Error ? error2.message : String(error2))
    process.exit(0)
  }
}

console.log('实例上的方法:', Object.getOwnPropertyNames(Object.getPrototypeOf(client)).join(' '))
console.log('api 形状:', client.api ? Object.keys(client.api).join(' ') : '(没有 .api)')

// 真打一次 host.describe
try {
  const res = await client.api.host.describe({ payload: {} })
  console.log('host.describe →', JSON.stringify(res).slice(0, 300))
} catch (error) {
  console.log('host.describe 失败:', error instanceof Error ? error.message : String(error))
}
process.exit(0)
