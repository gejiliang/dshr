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

| | |
|---|---|
| dsh host contract | ✅ verified live against `0.1.0-rc.6` — see [`docs/dsh-contract.md`](docs/dsh-contract.md) |
| architecture | ✅ [`docs/architecture.md`](docs/architecture.md) |
| `@dshr/protocol` | 🚧 |
| `@dshr/state` | 🚧 |
| `@dshr/tui` | 🚧 |
| `@dshr/shell` | 🚧 |
| `@dshr/orchestrate` | 🚧 |

## Requirements

- Node ≥ 22 (`fetch` and `WebSocket` are built in)
- dsh `0.1.0-rc.6`
- pnpm

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
