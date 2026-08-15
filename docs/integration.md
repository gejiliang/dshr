# 装配接缝

> 各包是并行写出来的，`@dshr/shell` 当时还看不到 `@dshr/tui` 的真实 props，
> 于是在 `packages/shell/src/components.ts` 里声明了一组**占位契约**。
> 占位和真实组件有几处对不上。**这份文档是对不上那几处的最终裁决**，
> 由 `packages/cli` 负责落实。

## 现状（实测两边的导出）

| 组件 | `@dshr/shell` 占位 | `@dshr/tui` 真实 |
|---|---|---|
| `Conversation` | `{ view, focused }` | `{ view }` |
| `Composer` | `{ sessionId, focused, disabled?, onSubmit }` | `{ onSubmit, disabled?, placeholder?, initialText? }` |
| `PendingPrompt` | `{ pending, focused }` | `{ pending, onApprove?, onAnswer?, onCancel? }` |
| `StatusLine` | `{ tabCount, activeTitle, activeStatus, prefixPending, sidebarOpen }` | `{ model?, contextUsed?, contextLimit?, turnElapsedMs?, connection?, agentStatus? }` |

## 裁决

### 1. `@dshr/tui` 是真源，`components.ts` 改成 re-export

`packages/shell/src/components.ts` 里那几个 props 接口**删掉**，改成
`import type { … } from '@dshr/tui'` 再 re-export。
**依赖注入这个机制保留**（测试要注入假替身），变的只是类型从哪来。

### 2. 没有 `focused` 这个 prop，用 `disabled`

`Conversation` 是纯展示，不需要焦点。`Composer` 只需要知道自己该不该接收输入——
那正是 `disabled` 的语义：

```tsx
<Composer disabled={!paneFocused || Boolean(pending)} onSubmit={…} />
```

⚠️ **ink 的 `useInput` 是广播模型**，所以「disabled」必须意味着**真的不消费按键**，
不能只是变灰。cli 装配后要有一个测试证明：两个 pane 同时挂载时，
非焦点 pane 的 Composer 不会吃到按键。
（`components.ts` 里那段关于 Ctrl 组合键分层的注释仍然成立，别删。）

### 3. 两个 StatusLine 是两个东西，都要，别合并

- `@dshr/tui` 的 `StatusLine` 是**会话级**的：模型、上下文用量、本轮耗时、连接状态。
- `@dshr/shell` 的是**壳级**的：tab 数、前缀等待态、侧栏开关。

它们回答的是不同问题，硬合并会两头都说不清。做法：

- shell 把自己那条**留在包内自己渲染**，改名 `ShellStatusLine`，
  **从 `ShellComponents` 注入束里去掉**（它不是 tui 的组件，不该被注入）。
- 屏幕最底一行由 shell 组合：左边 `ShellStatusLine`，右边嵌 tui 的 `StatusLine`（当前焦点会话的）。

会话级状态行的数据来自 projections——`contextPressure.contextWindow` 与
`contextBreakdown`（见 [`dsh-contract.md`](dsh-contract.md) 第五之二节），不要自己算。

### 4. `PendingPrompt` 必须把回调接上

占位契约漏了 `onApprove` / `onAnswer`，照现状装出来会是一个**能看不能答的审批条**——
而未决交互是会话卡住时唯一的出口。cli 装配时必须接上：

```tsx
<PendingPrompt
  pending={pending}
  onApprove={(outcome) => state.answerApproval(sessionId, outcome)}
  onAnswer={(answer) => state.answerQuestion(sessionId, answer)}
/>
```

**验收里必须有一条端到端证明**：host 发来 `approval/requested` → TUI 显示 → 作答 →
host 收到 `/api/respond` 且回执 `accepted: true`。这条不过，整个功能就是假的。

### 5. `@dshr/state` 的工厂名

```ts
import { createState } from '@dshr/state'
const state = createState({ client })   // CreateStateOptions
```

（本文最初写的是 `createDshrState`，但那时 state 包已经在并行开发中、看不到这份文档。
实际导出的是 `createState`——包名已经带了 `dshr` 前缀，再重复一遍是冗余。以实现为准。）

### 6. ink 的 `<Static>` 与多 pane 布局不兼容（实测，已改）

`@dshr/tui` 的 `Conversation` 最初用 ink 的 `<Static>` 做「已完成项只追加、永不重绘」的优化——
那是**单窗格全屏 TUI（opencode 那种）的正解**，也是它当初被写进来的理由。

**但 `<Static>` 是文档级的**：它的输出永远写在动态区上方，**无法被限制在某个 Box 里**。
在 dshr 的多 pane 布局下，实测结果是会话内容整个跑到 tab 栏和侧栏**外面**去，
pane 框里只剩一个输入框：

```
│ 把 protocol 包的重连逻辑改成指数退避…      ← 会话内容，跑到布局外面了
│ mock says: the reconnect backoff is in place.
 1                                          ← tab 栏
┌──────────────┐╭──────────────────────╮
│工作区         ││○ (新会话)             │
│dshr          ││╭────────────────────╮│
│ ○ (新会话)   │││ Type a message…    ││   ← pane 里只剩输入框
```

**裁决：`Conversation` 不用 `<Static>`**，全部走普通渲染，用 `maxItems`（默认 200）
的窗口兜住长会话的开销。代价是每帧重绘整棵子树；换来的是内容真的待在它该待的格子里。
**这个取舍对「工作区」这个产品形态是必然的**——只要有第二个 pane，Static 就不能用。

> 这条也说明为什么 `packages/cli/test/e2e.test.ts` 必须断言**渲染帧**而不只是数据模型：
> 数据模型当时完全正确（`items: user, assistant`），错的只有渲染位置。

## 装配顺序（`packages/cli`）

```
解析旗标
  → createDshrClient({ baseUrl })     // @dshr/protocol
  → client.connect()                  // readiness 握手
  → createDshrState({ client })       // @dshr/state
  → render(<Shell state={…} components={{ Conversation, Composer, PendingPrompt }} />)
```

`--connect <url>` 直接连；不带则先探本机端口，探不到就自己起一个 host
（形态见 [`profile.md`](profile.md) 第「三种进程形态」节）。
**默认只绑 loopback**，远程 attach 在 dshr 自带认证之前不开。
