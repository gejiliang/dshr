/**
 * 目标（goal）的**读侧**：`goal` 会话投影的防御性解析。
 *
 * 形状来源（2026-08-17 实测，dsh 0.1.0-rc.6，`tools/probe-goal.mjs` 打出来的）：
 *
 * ```json
 * { "goal": { "id": "goal-…", "revision": 2, "objective": "…", "phase": "blocked",
 *             "blockedReason": { "code": "round-limit", "message": "…" },
 *             "maxGoalRounds": 3 },
 *   "roundsStarted": 3, "createdAt": …, "updatedAt": … }
 * ```
 *
 * 与 `@deepseek-ai/dsh-goal` 的 `GoalProjection` 声明一致；clear 之后投影值是 `null`。
 * 写侧（pause/resume/complete/clear）要的 CAS ref 就是投影里的 `{id, revision}`——
 * 实测 revision 会被模型的自动轮次往前推，**动词必须在派发那一刻现读投影**，
 * 存下来的旧 ref 会撞 `GOAL_STALE_REVISION`。
 *
 * ⚠️ 这只解析 `session/projection` 帧与 history 尾页投影块里的 `goal` 键；
 * `goal/change` **事件**的 `data` 不在这里碰（契约纪律：未实测全操作类型前只认 type）。
 */
import type { GoalInfo, GoalPhase, GoalRefId } from './types.js'

const PHASES: readonly GoalPhase[] = ['active', 'paused', 'blocked', 'complete']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 把 `goal` 投影值折成 `GoalInfo`；没有目标（`null` / 缺键）或形状不符时返回 undefined。
 * 形状不符宁可不显示，也不渲染猜出来的字段。
 */
export function parseGoalProjection(value: unknown): GoalInfo | undefined {
  if (!isRecord(value)) return undefined
  const goal = value['goal']
  if (!isRecord(goal)) return undefined
  const id = goal['id']
  const revision = goal['revision']
  const objective = goal['objective']
  const phase = goal['phase']
  if (typeof id !== 'string' || id === '') return undefined
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return undefined
  if (typeof objective !== 'string') return undefined
  if (typeof phase !== 'string' || !PHASES.includes(phase as GoalPhase)) return undefined

  const blockedReason = goal['blockedReason']
  const roundsStarted = value['roundsStarted']
  const maxGoalRounds = goal['maxGoalRounds']
  return {
    id: id as GoalRefId, // 品牌只是编译期标记，运行时就是字符串
    revision,
    objective,
    phase: phase as GoalPhase,
    ...(isRecord(blockedReason) && typeof blockedReason['message'] === 'string'
      ? { blockedReason: blockedReason['message'] }
      : {}),
    roundsStarted: typeof roundsStarted === 'number' ? roundsStarted : 0,
    maxGoalRounds: typeof maxGoalRounds === 'number' ? maxGoalRounds : 0,
  }
}
