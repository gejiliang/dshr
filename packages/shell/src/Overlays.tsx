/**
 * 覆盖层组件：只负责把 `overlay.ts` 的纯状态画出来。
 * 键处理全部在 Shell 的 useInput 里折算后喂给纯状态机，这里不 useInput。
 */
import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { TextInputModel, WorkspacePickerModel } from './overlay.js'

export function WorkspacePickerOverlay({ model }: { readonly model: WorkspacePickerModel }): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan">
      <Text bold>选择工作区</Text>
      {model.entries.length === 0 ? <Text dimColor>(无工作区)</Text> : null}
      {model.entries.map((e, i) => (
        <Text key={e.id} {...(i === model.index ? { inverse: true } : {})}>
          {`${i + 1}. ${e.title}  ${e.path}`}
        </Text>
      ))}
      <Text dimColor>↑↓ 或数字键移动 · enter 确认 · esc 取消</Text>
    </Box>
  )
}

export function NewWorkspaceOverlay({
  input,
  error,
}: {
  readonly input: TextInputModel
  /** host 回的业务错误（workspace-invalid-path 等），必须可见，不静默吞。 */
  readonly error: string | null
}): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan">
      <Text bold>新建工作区</Text>
      <Text>{`路径: ${input.value}▏`}</Text>
      {error !== null ? <Text color="red">{`⚠ ${error}`}</Text> : null}
      <Text dimColor>输入路径后 enter 提交 · esc 取消</Text>
    </Box>
  )
}
