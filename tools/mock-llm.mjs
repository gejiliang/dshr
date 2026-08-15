#!/usr/bin/env node
/**
 * 起一个假的 OpenAI 兼容端点，让 dshr 在**没有任何密钥**的情况下跑通全链路。
 *
 * `@deepseek-ai/dsh-llm-mock-server` 是一个库，不是 dsh 插件，也没有可执行文件
 * （它的 README 原文："exposes no installable binary"）——所以这个几行的启动器是必需的。
 *
 *   node tools/mock-llm.mjs --port 8100 --text "hello from the mock"
 *   node tools/mock-llm.mjs --sequence tool_call_success,success   # 测工具卡片渲染
 *
 * 然后把 dsh 的 provider 指过去（$DSH_HOME/settings.yaml）：
 *
 *   llm-pi-ai:
 *     providers:
 *       mock:
 *         api: openai-completions
 *         baseURL: http://127.0.0.1:8100/v1
 *         models: [ { id: mock-model } ]
 *
 * 不配 apiKey 时它接受任意 token。
 */
import { parseArgs } from 'node:util'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8100' },
    text: { type: 'string', default: 'hello from the dshr mock endpoint' },
    sequence: { type: 'string', default: 'success' },
    'tool-name': { type: 'string', default: 'bash' },
    'tool-arguments': { type: 'string', default: '{"command":"echo hi"}' },
    seed: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  console.log(
    [
      'Usage: node tools/mock-llm.mjs [options]',
      '',
      '  --port <n>            listen port (default 8100)',
      '  --text <s>            text the `success` behavior streams',
      '  --sequence <a,b,...>  FIFO of behaviors; the last one repeats',
      '  --tool-name <s>       tool name for `tool_call_success`',
      '  --tool-arguments <s>  JSON arguments for `tool_call_success`',
      '  --seed <n>            seed for the `random` behavior',
      '',
      'Behaviors worth knowing: success, slow_success, reasoning_success,',
      'tool_call_success, partial_disconnect, stream_disconnect, stall,',
      'rate_limit, server_error, random.',
    ].join('\n'),
  )
  process.exit(0)
}

const sequence = values.sequence.split(',').map((s) => s.trim()).filter(Boolean)

const server = await startMockLlmServer({
  port: Number(values.port),
  sequence,
  // 不 repeat 的话脚本耗尽后返回结构化 500，一轮对话就用完了。
  repeatLast: true,
  successText: values.text,
  toolName: values['tool-name'],
  toolArguments: values['tool-arguments'],
  ...(values.seed ? { randomSeed: Number(values.seed) } : {}),
})

console.log(`mock llm: ${server.baseURL}`)
console.log(`sequence: ${sequence.join(' → ')} (last repeats)`)
if (server.randomSeed !== undefined) console.log(`seed: ${server.randomSeed}`)

const shutdown = async () => {
  await server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
