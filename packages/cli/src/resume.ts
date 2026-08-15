/**
 * `--resume` 的装配实现。
 *
 * `@dshr/shell` 的 Shell 启动时总是开第一个 tab 并调一次 `state.createSession`
 * 给第一个 pane 开会话，它没有「绑定到已有会话」的入口。所以 resume 在这里做成
 * 一个 state 装饰器：**第一次** createSession 不新建，直接返回要 resume 的
 * sessionId——第一个 pane 于是绑到那个已存在的会话上；之后再开 tab/pane 照常新建。
 *
 * 会话本身在 host 上是强制落盘的，state 基线化时就会出现在 sessions 里，
 * conversation(id) 照常工作。
 */
import type { DshrState, SessionId } from '@dshr/state'

export function withResumeSession(state: DshrState, resumeId: SessionId): DshrState {
  let pending = true
  return {
    get sessions() {
      return state.sessions
    },
    get workspaces() {
      return state.workspaces
    },
    subscribe: (listener) => state.subscribe(listener),
    conversation: (sessionId) => state.conversation(sessionId),
    projections: (sessionId) => state.projections(sessionId),
    createWorkspace: (path, title) => state.createWorkspace(path, title),
    createSession: (input) => {
      if (pending) {
        pending = false
        return Promise.resolve(resumeId)
      }
      return state.createSession(input)
    },
    prompt: (sessionId, text) => state.prompt(sessionId, text),
    cancel: (sessionId) => state.cancel(sessionId),
    answerApproval: (sessionId, outcome) => state.answerApproval(sessionId, outcome),
    answerQuestion: (sessionId, answers) => state.answerQuestion(sessionId, answers),
    dispose: () => state.dispose(),
  }
}
