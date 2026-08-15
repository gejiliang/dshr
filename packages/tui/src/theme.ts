/**
 * 全包唯一一套颜色约定。
 *
 * chrome 一律 gray/dim；只有状态才上色——错误红、阻塞/待办黄。
 * 角色竖线是唯一的例外：用户 cyan、助手 gray，这是区分角色的手段，不是装饰。
 */
export const colors = {
  /** 用户消息左侧竖线。 */
  userBar: 'cyan',
  /** 助手消息左侧竖线。 */
  assistantBar: 'gray',
  /** 错误 / 工具失败。 */
  error: 'red',
  /** 阻塞 / 待审批 / 待回答。 */
  blocked: 'yellow',
  /** 一切 chrome：提示、摘要、状态行。 */
  chrome: 'gray',
} as const
