# dshr

**A terminal session UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
built to live inside a [herdr](https://herdr.dev) pane.**

> ⚠️ **Early development.** dsh itself is a developer preview (`0.1.0-rc.8`), and dshr is
> younger than that. Interfaces will move. Nothing here is stable yet.

`dsh` ships two surfaces: a one-shot `headless` mode and a `web` mode that serves a browser
UI. There is no terminal surface — yet the upstream docs already leave the seat open for one
(`dsh --profile tui --resume <id>`, "assuming the tui profile is installed"), and
`dsh-api-remotes` says its client face "can be reused by Web or **a future TUI**".

dshr is that TUI. One process, one pane, one session.

## The shape

**dshr is a dsh plugin.** dsh is a cordis plugin graph and everything in it is a plugin, so
the way to add a terminal surface is to contribute a row to that graph — not to write a
separate program that happens to speak dsh's wire protocol.

```
 dsh --profile dshr        one process, no port, no socket
 ────────────────────────────────────────────────────────
 dsh-base                  agent, tools, sessions, LLM
 + storage / workspace     the host plane the Web surface also mounts
 + api-gateway             ctx.apiProxy — the dispatch face
 + dshr-app  ◄─────────────@dshr/bundle: startSurface() mounts the ink TUI
                           over an in-process carrier (no HTTP, no WebSocket)
```

Run it inside herdr and each pane is a dsh session:

```toml
# ~/.config/herdr/config.toml
[terminal]
default_shell = "dshr"
```

Three things fall out of building it this way:

- **The workspace already exists.** herdr has spent its life on tabs, panes, splits and a
  live agent sidebar. dshr renders one pane's worth of content and nothing else. An earlier
  version reimplemented all of herdr beside herdr; it was deleted (`git log -- packages/shell`).
- **The host plane already exists.** The profile mounts the same host rows dsh's own Web
  surface mounts, so workspace registry, session persistence, approvals and subagents come
  for free — in the same process, reached through `ctx.apiProxy` rather than a socket.
- **Agent state is authoritative, not scraped.** Plugins that wrap a foreign TUI have to parse
  its status line and break when it changes. dshr learns `idle` / `working` / `blocked` from
  the host's own event stream and reports it to herdr directly — no watcher process, nothing
  to re-verify when upstream reflows its output.

## Status

**192 tests. The TUI mounts inside `dsh --profile dshr` — one process, no port, no socket.**

dshr calls **26 of dsh's 52 RPC methods**, handles **all 19** downlink frame types, and folds
**18 of 39** session event kinds. What's missing and why — including three things that
*can't* be reached on this deployment — is [`docs/coverage.md`](docs/coverage.md).

| | | |
|---|---|---|
| dsh host contract | ✅ | verified live against `0.1.0-rc.8` — [`docs/dsh-contract.md`](docs/dsh-contract.md) |
| `@dshr/protocol` | ✅ | the `/api` wire carrier — 14 tests, 3 against a live host |
| `@dshr/state` | ✅ | frames folded into a renderable model — 16 tests |
| `@dshr/tui` | ✅ | the session surface, in opencode's shape — [`docs/opencode-port.md`](docs/opencode-port.md) |
| `@dshr/herdr` | ✅ | reports session state to herdr's sidebar — 6 tests |
| `@dshr/surface` | ✅ | mounts the TUI over any carrier — shared by the plugin and `--connect` |
| `@dshr/bundle` | ✅ | the cordis plugin row (`dshr-app`) — `startSurface` mounts the TUI in-process |
| `dshr` (cli) | ✅ | 399 lines: set up the profile, hand the terminal to `dsh` |

## Install

```sh
pnpm install && npx tsc --build
sh tools/install.sh
```

`tools/install.sh` writes a thin wrapper rather than a symlink, because it also has to bring
the credential reference into the environment — dsh resolves `apiKeyEnv` at request time, and
needing a `source` per shell is the difference between a tool and a chore.

Then point it at a model in `~/.dsh/settings.yaml` and supply the key through `~/.dsh/env.sh`.
Both files, and the one trap in them, are in [`docs/using-it.md`](docs/using-it.md).

## Use

```sh
dshr                       # dsh --profile dshr — one process, no port
dshr --resume <sessionId>  # reopen an existing session
dshr --connect <url>       # attach to a host someone else started
```

`dshr` with no flags materialises `$DSH_HOME/profiles/dshr/` (idempotent) and hands the
terminal to `dsh --profile dshr`; the TUI mounts inside that process. `--connect` is the one
path that stays out of the plugin graph — attaching to someone else's host has no use for a
local host plane, and mounting one would fight over the same `$DSH_HOME/sessions`.

Usually you won't type any of these: with `default_shell = "dshr"`, opening a herdr pane is
opening a session. Closing the pane only detaches — dsh persists every session, so
`dshr --resume` picks it back up.

### Keys

Copied from opencode, verified against a real opencode 1.18.18 capture
([`docs/opencode-dialogs.md`](docs/opencode-dialogs.md)):

| key | what |
|---|---|
| `enter` | send · `shift+enter` newline |
| `ctrl+p` | **command palette** — everything below is reachable from here |
| `tab` | cycle the agent preset in place (`standard` → `code` → `minimal` → `cordis`) |
| `esc` | interrupt the current turn · close a dialog |
| `ctrl+c` | quit |

Inside the session-list dialog, `ctrl+r` renames.

### What the palette can do

Switch model · switch session · switch agent preset · fork · rename ·
open/inspect settings · see which credentials are configured · browse providers and the
host model catalog · create/pause/resume/complete/clear a goal.

**Everything in the palette does something.** Commands that can't work right now are hidden
or answer with a readable reason (`fork` needs a completed turn; the host locks the agent
preset after the first turn) — there are no decorative entries.

### What the transcript now shows

Beyond the conversation itself: retries (`↳ Retrying (attempt 1/2) · RATE_LIMIT`, in red —
before this, a retrying gateway looked like a freeze), todo lists, slash-command runs,
subagent tasks, context compaction, and queued messages.

Coverage of dsh's surface — what's wired, what isn't, and why — is tracked in
[`docs/coverage.md`](docs/coverage.md); re-count it with `sh tools/coverage.sh`.

## Verifying it

Don't take the test count on faith — a green suite proved nothing here once already, because
the end-to-end check was satisfied by a sidebar label rather than by the thing it claimed to
test.

```sh
node tools/verify.mjs           # starts its own mock model and host, checks four claims
expect -f tools/verify-tty.exp  # drives a real pty: render, type, submit, Ctrl-C
```

`verify.mjs` needs nothing running: it brings up a fake model and a dsh host on ephemeral
ports in a temp `DSH_HOME`, prints the rendered frame, and tears everything down.

**Then prove the checks can fail.** Revert the worst bug and watch exactly one line go red:

```sh
git checkout HEAD~1 -- packages/state/src/conversation.ts
npx tsc --build && node tools/verify.mjs
```

The pty check exists because everything else renders off-screen, and the two worst bugs in
this project's history lived exactly there: `Ctrl-C` did nothing at all, and once fixed it was
still dropped when pressed while output streamed.

## Development

You do not need an API key. `@deepseek-ai/dsh-llm-mock-server` is a scriptable
OpenAI-compatible endpoint — point a dsh provider at it and the whole stack runs for real with
only the model faked:

```sh
node tools/mock-llm.mjs --port 8100 --text "hello from the mock"
MOCK_API_KEY=mock-key DSH_HOME=/tmp/dshhome npx @deepseek-ai/dsh@0.1.0-rc.8 web --port 39081
node tools/e2e.mjs http://127.0.0.1:39081
```

| tool | what it does |
|---|---|
| `tools/install.sh` | installs the `dshr` command |
| `tools/mock-llm.mjs` | a fake model — success, tool calls, reasoning, disconnects, stalls |
| `tools/verify.mjs` | self-contained end-to-end check |
| `tools/verify-tty.exp` | drives a real terminal |
| `tools/e2e.mjs` | connect, prompt, print the streamed answer |
| `tools/preview.mjs` | render one frame from fake data |
| `tools/probe-events.mjs` | dump the real session-event shapes off a live host |

Run the tests with `npx tsc --build && node --test packages/*/test/*.test.ts`. Tests needing a
host skip themselves when one is not reachable.

> The suite imports each package's **built** output, because Node's type stripping does not
> map a `.js` specifier back to a `.ts` source. Build before testing, always.

## Requirements

- Node ≥ 22 (`fetch` and `WebSocket` are built in)
- dsh `0.1.0-rc.8`, herdr `0.8.0+`, pnpm

> ⚠️ Pin **exactly** — and pin the libraries to the same version as the host you launch.
> dsh's library packages still have `latest` pointing at `0.0.1-rc.1`; the `0.1.x` line
> lives under `next`. `0.1.0-rc.8` is dsh's `next`, one ahead of its `latest` (`rc.7`) —
> tracking `next` is deliberate here, because the libraries are only published there.
> The two tags are not kept in sync with each other, so derive nothing from them:
> see [`docs/dsh-contract.md`](docs/dsh-contract.md) §9 for the five places to bump.

## Security

dsh's `/api` trust fence is a **reachability policy, not authentication** — the upstream web
carrier has no authentication layer, and `--host 0.0.0.0` is deliberately unsupported there.
dshr therefore binds loopback only. Remote attach will require dshr to bring its own
authentication; widening `trustedHosts` is not that.

A set of privileged methods stays pinned to loopback regardless of configuration (directory
picking, opening host paths, the settings and credentials plane, agent-preset authoring), so a
remote client's capability surface is genuinely smaller.

## Not done yet

- **You can't step into a subagent.** The transcript shows the subagent tool row
  (`✓ General Task — …`), but `subagent.list` / `history` / `prompt` / `interrupt` aren't wired,
  so you can't see what it did or talk to it. Blocked on a real problem: measured
  `host/session-added` carries no `parentSessionId` or `origin`, so parent↔child can't be linked
  ([`docs/gap-shapes.md`](docs/gap-shapes.md) §五).
- **Remote attach.** Loopback only, on purpose — see above.

Orchestration used to be here (`@dshr/orchestrate`) and was **deleted** on 2026-08-17: a TUI
client shouldn't own orchestration verbs. That's [herdgent](https://github.com/gejiliang/herdgent)'s
job, and dsh already exposes orchestration as model tools (`subagent`, `workflow`, `ralph`,
`list_agents`, `send_message`, `interrupt_agent`) — the client's job is to render them.

## License

Apache-2.0. dsh itself is MIT.
