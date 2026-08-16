# dshr

**A terminal workspace for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
a TUI, a persistent server, and multi-agent orchestration, as a dsh plugin.**

> ⚠️ **Early development.** dsh itself is a developer preview (`0.1.0-rc.6`), and dshr is younger
> than that. Interfaces will move. Nothing here is stable yet.

`dsh` ships two surfaces: a one-shot `headless` mode and a `web` mode that serves a browser UI.
There is no terminal surface — yet the upstream docs already leave the seat open for one
(`dsh --profile tui --resume <id>`, "assuming the tui profile is installed"), and
`dsh-api-remotes` says its client face "can be reused by Web or **a future TUI**".

dshr is that TUI, plus the thing a browser tab cannot give you: **a workspace**.
Tabs, panes, a sidebar of live agents, and orchestration verbs to put several of them to work.

## What it is

```
┌─ dshr TUI ───────────────────────────────────────┐
│  tabs · panes · sidebar of live agents            │   one pane = one dsh session
│  opencode-style conversation view                 │
├───────────────────────────────────────────────────┤
│  POST /api/<method>  +  two downlink streams      │
├───────────────────▼───────────────────────────────┤
│  dsh host plane — reused as-is, not reimplemented  │
│  workspaces · sessions · subagents · approvals ·   │
│  questions · jobs · projections · goals · skills   │
└───────────────────────────────────────────────────┘
```

Three things fall out of building it this way:

- **The server already exists.** dsh's `web` profile runs a complete host plane. dshr composes
  the same host rows instead of rewriting them, so workspace management, session persistence,
  approvals and subagents come for free.
- **Agent state is authoritative, not scraped.** Terminal multiplexers infer whether an agent is
  busy by parsing its status line — and break the day upstream changes it. dshr reads
  `host/session-status` off the host's own event stream. `idle` / `working` / `blocked` are facts,
  not guesses.
- **Sessions are already durable.** dsh persists every session to disk unconditionally, so
  detach, re-attach and `--resume` are properties of the host, not features dshr had to add.

## Status

**154 tests, all green. The whole stack runs against a real dsh host.**

| | | |
|---|---|---|
| dsh host contract | ✅ | verified live against `0.1.0-rc.6` — [`docs/dsh-contract.md`](docs/dsh-contract.md) |
| `@dshr/protocol` | ✅ | the `/api` wire carrier — 14 tests, 3 against a live host |
| `@dshr/state` | ✅ | frames folded into a renderable model — 13 tests |
| `@dshr/tui` | ✅ | conversation, composer, tool rows, approvals — 32 tests asserting rendered ANSI |
| `@dshr/shell` | ✅ | tabs, panes, sidebar, keys, workspace switching — 57 tests, layout logic pure and ink-free |
| `@dshr/orchestrate` | ✅ | orchestration verbs — 13 tests. **A library; nothing calls it yet** (see below) |
| `@dshr/bundle` | ✅ | the dsh profile bundle — 12 tests, `--dump-config` composes clean |
| `dshr` (cli) | ✅ | assembly + end-to-end — 13 tests. `dshr server` brings up its own host |

## Keys

`Ctrl-B` is the prefix, tmux-style.

| | |
|---|---|
| `c` / `n` / `p` | new tab / next / previous |
| `%` / `"` | split the pane vertically / horizontally |
| arrows / `x` | move focus / close the pane (**detach only — the session stays on the host**) |
| `s` | toggle the sidebar |
| `w` / `W` | switch workspace / create one |

Every new tab and every new pane opens a fresh dsh session in the active workspace.

### What is deliberately not done yet

- **Orchestration is not reachable from the product.** `@dshr/orchestrate` implements and
  tests the verbs — spawn, send, wait, cancel, list, with a configurable hard cap — but
  nothing in the CLI or the bundle calls them. Exposing them as tools a model can invoke
  needs dsh's tool-plugin API, which this pass deliberately stayed out of.
- **Remote attach.** The host binds loopback only, on purpose — see [Security](#security).

The end-to-end test renders the **whole Shell** against a live host, submits a prompt, and
asserts the streamed answer reaches the rendered frame — the only test that crosses all
five packages:

```
 1
┌──────────────┐╭───────────────────────────────────────────────╮
│工作区         ││○ (新会话)                                      │
│dshr          ││ 把 protocol 包的重连逻辑改成指数退避，上界 10 秒。 │
│ ○ (新会话)   ││ mock says: the reconnect backoff is in place.  │
│              ││╭─────────────────────────────────────────────╮│
│              │││ Type a message…                             ││
│              ││╰─────────────────────────────────────────────╯│
└──────────────┘╰───────────────────────────────────────────────╯
tabs:1                                    mock-model · idle · connected
```

That run used **no credentials at all** — see [Development](#development).

It also earned its keep: it caught two defects no unit test could have, because both only
exist between packages. `session.create` rejects `workspaceId` and `cwd` together, and
ink's `<Static>` is document-level — so the conversation escaped its pane and rendered
above the tab bar. Details in [`docs/integration.md`](docs/integration.md).

## Requirements

- Node ≥ 22 (`fetch` and `WebSocket` are built in)
- dsh `0.1.0-rc.6`
- pnpm

> ⚠️ Pin dsh's library packages **exactly**. Their `latest` dist-tag still points at
> `0.0.1-rc.1`; the `0.1.x` line lives under `next`. A `^0.1.0-rc.6` range will surprise you.

## Development

**Install and build first — the tools import the built packages, not the sources:**

```sh
pnpm install
npx tsc --build
```

You do not need an API key. `@deepseek-ai/dsh-llm-mock-server` is a scriptable
OpenAI-compatible endpoint — point a dsh provider at it and the whole stack runs for real
with only the model faked. Three terminals, or background the first two:

```sh
# 1) the fake model
node tools/mock-llm.mjs --port 8100 --text "hello from the mock"

# 2) a dsh host wired to it — settings.yaml is in docs/profile.md
MOCK_API_KEY=mock-key DSH_HOME=/tmp/dshhome npx @deepseek-ai/dsh@0.1.0-rc.6 web --port 39081

# 3) drive it
node tools/e2e.mjs http://127.0.0.1:39081     # prints the streamed answer
node tools/demo-live.mjs                       # prints the assembled TUI frame
```

The `settings.yaml` this needs, and the one trap in it, are in
[`docs/profile.md`](docs/profile.md).

| tool | what it does |
|---|---|
| `tools/mock-llm.mjs` | a scriptable fake OpenAI endpoint — success, tool calls, disconnects, stalls |
| `tools/e2e.mjs` | connects, creates a session, prompts, prints the streamed answer |
| `tools/demo-live.mjs` | renders the assembled TUI against a live host and prints the frame |
| `tools/preview.mjs` | renders one TUI frame from fake data, for looking at the design |
| `tools/probe-events.mjs` | dumps the real session-event shapes off a live host |

Run the tests with `npx tsc --build && node --test packages/*/test/*.test.ts`. Tests that
need a host skip themselves when one is not reachable.

> The suite imports each package's **built** output (`lib/`), because Node's type stripping
> does not map a `.js` specifier back to a `.ts` source. Build before testing, always.

## Security

dsh's `/api` trust fence is a **reachability policy, not authentication** — the upstream web
carrier has no authentication layer, and `--host 0.0.0.0` is deliberately unsupported there.
dshr therefore binds loopback only. Remote attach will require dshr to bring its own
authentication; widening `trustedHosts` is not that, and will not be treated as that.

A set of privileged methods stays pinned to loopback regardless of configuration (directory
picking, opening host paths, the whole settings and credentials plane, and agent-preset
authoring). A remote client's capability surface is genuinely smaller, and the UI says so
rather than pretending otherwise.

## License

Apache-2.0. dsh itself is MIT.
