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

| | | |
|---|---|---|
| dsh host contract | ✅ | verified live against `0.1.0-rc.6` — [`docs/dsh-contract.md`](docs/dsh-contract.md) |
| `@dshr/protocol` | ✅ | wire carrier; 14 tests, 3 of them against a live host |
| `@dshr/tui` | ✅ | conversation, composer, tool rows, approvals; 32 tests asserting rendered ANSI |
| `@dshr/shell` | ✅ | tabs, panes, sidebar, keys; 40 tests, layout logic is pure and ink-free |
| `@dshr/state` | 🚧 | |
| `@dshr/bundle` | 🚧 | the dsh profile bundle |
| `@dshr/orchestrate` | 🚧 | orchestration verbs |
| `dshr` (cli) | 🚧 | assembly — [`docs/integration.md`](docs/integration.md) |

Proven end to end so far — a client connects to a real dsh host, creates a session,
prompts it, and receives the answer streamed chunk by chunk:

```console
$ node tools/e2e.mjs http://127.0.0.1:39081
· connection: ready
session: session-923994ca-9a17-4567-b0b9-7c8f6b42619f
· session-status running=true
mock says: the reconnect backoff is in place.
· session-status running=false

streamed text : "mock says: the reconnect backoff is in place."
chunk kinds   : block-start, block-end, usage, finish
turn finished : true      history events: 29
```

That run used **no credentials at all** — see [Development](#development).

## Requirements

- Node ≥ 22 (`fetch` and `WebSocket` are built in)
- dsh `0.1.0-rc.6`
- pnpm

> ⚠️ Pin dsh's library packages **exactly**. Their `latest` dist-tag still points at
> `0.0.1-rc.1`; the `0.1.x` line lives under `next`. A `^0.1.0-rc.6` range will surprise you.

## Development

You do not need an API key. `@deepseek-ai/dsh-llm-mock-server` is a scriptable
OpenAI-compatible endpoint — point a dsh provider at it and the whole stack runs for real
with only the model faked:

```sh
node tools/mock-llm.mjs --port 8100 --text "hello from the mock"
MOCK_API_KEY=mock-key DSH_HOME=/tmp/dshhome npx @deepseek-ai/dsh@0.1.0-rc.6 web --port 39081
node tools/e2e.mjs http://127.0.0.1:39081
```

The `settings.yaml` this needs, and the one trap in it, are in
[`docs/profile.md`](docs/profile.md). Other tools: `tools/preview.mjs` renders one TUI
frame so you can look at it, `tools/probe-events.mjs` dumps the real session-event shapes.

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
