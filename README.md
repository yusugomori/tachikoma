# Tachikoma

[日本語版](README.ja.md)

![Tachikoma live terminal demo: three Claude agents and three Codex agents split one weather request across a six-pane tmux session](https://raw.githubusercontent.com/yusugomori/tachikoma/main/assets/tachikoma-multi-agent-weather-demo.gif)

One `/tachikoma` prompt can fan out across named live agents in different
runtimes, then gather their replies into the same thread. This recording shows
three Claude sessions and three Codex sessions launched in `/tmp/dev` with
`tachikoma claude` and `tachikoma codex`. One Claude session asks for weather
across six cities, Tachikoma routes the work to the other live agents, and
their replies return into the same thread. Permissions were pre-approved so the
demo could run without stopping for confirmations.

Tachikoma is a realtime agent workspace for named, parallel coding agents
working in the same repository.

Start a few named sessions, such as `loki`, `musashi`, `triton`, and `tomoe`.
They can run on Codex, Claude, or any supported agent runtime. Tachikoma treats
the runtime as a delivery detail; the shared workspace is organized around
named live agents. Each agent can be called from another TUI, can reply in the
same thread, and can keep several conversations moving at once.

The workspace is reachable from outside the sessions too. A terminal command
can send an instruction to any named agent; if that agent is live, the directive
lands in its TUI, and if it is not live yet, the work waits in its inbox. Humans,
scripts, and other tools can kick work into the same workspace without being
inside any one conversation.

Tachikoma is not a CLI wrapper or a memory file. It is a realtime multi-agent
workspace where already-running sessions can call on each other while durable
project facts are recorded behind the scenes.

Tachikoma is built around durable project coordination, not chat history. A
message can move attention to another agent, but the lasting facts are tasks,
assignments, implementation claims, review findings, verification results,
decisions, handoffs, and reports.

## What Tachikoma Is

- A local-first coordination layer for coding agents working in one repository.
- A realtime message path among named TUI sessions, independent of runtime.
- Multiple open conversation threads that can move in parallel across live
  agents.
- A CLI control plane for launching runtime sessions, attaching TUIs, and
  sending instructions into the agent workspace from outside a session.
- A repository-scoped memory for structured project state.
- A named routing system for active or later-started agent sessions.
- Generated Codex/Claude skills for primary coordination, optional relay, sync,
  boot, and stale inbox cleanup from inside the TUI.
- Realtime TUI-to-TUI delivery through Codex app-server workers and Claude
  hooks/Monitor.
- A shared command and event layer behind CLI, MCP, hooks, and reports.
- A way to make handoff, review, and verification state explicit.

## What Tachikoma Is Not

- It is not a cloud coordination service.
- It does not replace Codex, Claude, or other agent runtimes.
- It is not a generic chat app.
- It is not a raw transcript recorder.
- It is not an MCP-first architecture. MCP is one adapter over the local
  service/store contract.
- It is not a report generator with state hidden inside Markdown.

## Capabilities

Tachikoma includes the local CLI, SQLite-backed event store, projections, MCP
server, named sessions, directed conversations, realtime delivery, structured
review records, verification records, and report generation.

The system is designed around explicit commands and inspectable state. Messages
move attention between agents; structured records preserve the facts that later
sessions should trust.

## Prerequisites

- Node.js 22 or newer.
- pnpm for a source checkout, or npm for the global install script.
- Codex CLI and/or Claude Code for live agent sessions.

## Five-Minute Quickstart

For source checkout development:

```bash
pnpm install
pnpm build
pnpm tachikoma init
pnpm tachikoma status
```

To install the CLI globally from GitHub (no npm registry account needed):

```bash
curl -fsSL https://raw.githubusercontent.com/yusugomori/tachikoma/main/install.sh | sh
tachikoma init
tachikoma status
```

The installer downloads the prebuilt tarball from the latest GitHub release and
runs `npm install -g` on it, so only `node` and `npm` are required (no build
toolchain). Pin a specific release with `TACHIKOMA_VERSION` (e.g.
`TACHIKOMA_VERSION=v0.1.0`), or point `TACHIKOMA_PACKAGE` at any npm name, git
spec, or tarball to override the source.

`init` initializes project state and installs local agent integration:
`.tachikoma/project.toml`, `.tachikoma/agent-instructions.md`, the managed
`.gitignore` block, generated skills, `.mcp.json`, and Codex/Claude host hook
activation files. Restart Codex or Claude after initialization, then **trust the
project and approve the hooks** when prompted (required for Codex — see
[Codex Project Trust And Hook Approval](#codex-project-trust-and-hook-approval-required)),
and check `/mcp`. Some Codex CLI sessions do not load a
repository-local `.mcp.json`; if `/mcp` does not list `tachikoma`, register the
server with `codex mcp add` as shown below and restart Codex.

The generated skills and the CLI are complementary. Skills are the workspace
controls for live agents talking from inside their own TUI. The CLI is the
outside control plane: it sets up integration, starts or attaches runtime
sessions, and can send instructions into the same workspace. The skill prefix
reflects the TUI you are typing in, not the kind of agent you are sending to:

| Runtime | Skills |
| --- | --- |
| Codex | `$tachikoma`, `$tachikoma-relay`, `$tachikoma-sync`, `$tachikoma-boot`, `$tachikoma-dismiss` |
| Claude | `/tachikoma`, `/tachikoma-relay`, `/tachikoma-sync`, `/tachikoma-boot`, `/tachikoma-dismiss` |

Use `$tachikoma` and `/tachikoma` as the primary TUI controls: they can send to
named agents, reply to threads, sync delivered work, and record structured
state. Use relay only as an optional send/reply shortcut when you do not want
the skill to perform the requested work or record structured state. Use boot for
explicit manual join, dismiss only for stale inbox cleanup, and the CLI when you
want to start sessions, inspect state, or send work from outside the TUI.

Start named runtime entries so other agents and the user can route work to
them. Use separate terminals or host sessions for long-running realtime TUI
sessions:

```bash
tachikoma claude
tachikoma codex
```

Both runtime launch commands print a small Tachikoma banner before startup
details. The banner is colored in TTY output, follows `NO_COLOR`, and can be
forced with `FORCE_COLOR=1`.

`tachikoma codex` starts or reuses a Codex app-server worker, opens a Codex TUI
attached to that worker, and runs delivery while the TUI is attached. Use
`tachikoma codex --watch` for a headless worker, or use the `codex start`,
`codex attach`, `codex deliver`, and `codex stop` subcommands for lower-level
worker control.

`tachikoma claude` joins a named Tachikoma session, opens Claude TUI with
Tachikoma identity in its hook environment, and submits bare `/tachikoma-boot`
as the Claude startup trigger unless `--no-auto-boot` is set. The agent name and
role come from `tachikoma claude --name ... --role ...`, not from the boot
prompt. Existing Claude TUI sessions should use `/tachikoma-boot <name>` for
explicit manual join before using `/tachikoma`. Claude Monitor uses
`tachikoma hook monitor --name <name> --watch` for realtime delivery.

Inside a live TUI, agents can pull other named agents into the work immediately:

```text
# In a Codex TUI, to any named agent
$tachikoma Send musashi: "Implement the current task and report blockers."
$tachikoma Send triton: "Verify the fix in parallel."
$tachikoma-sync

# In a Claude TUI, to any named agent
/tachikoma Send tomoe: "Take the docs side of this."
/tachikoma Send loki: "Please review my latest claim."
/tachikoma-sync
```

For a narrow send/reply-only shortcut, use `$tachikoma-relay` or
`/tachikoma-relay`.

Tachikoma routes each message by agent name. Codex app-server delivery and
Claude host hooks/Monitor are just the transports that put directives into live
TUIs. When agents reply in a thread, Tachikoma routes the follow-up back to the
other participants. The result is not a route matrix; it is a live set of named
agents keeping multiple conversations moving without a human polling
`tachikoma inbox`.

From outside any TUI, the CLI can inject work into the same workspace:

```bash
tachikoma ask musashi "Implement the current task and report blockers."
tachikoma ask triton "Verify the fix in parallel."
tachikoma thread list
tachikoma inbox --as musashi
tachikoma memory
```

If the target agent is attached to a live delivery path, the instruction appears
in its TUI. If it is offline, the message remains as pending work for that named
endpoint. The CLI also controls runtime delivery paths such as `tachikoma
codex start`, `tachikoma codex attach`, `tachikoma codex deliver`, and
`tachikoma claude`.

When several agents share a role, route by name. Tachikoma should not silently
guess between multiple possible targets.

## Naming The Current Session

Agent names are project-local routing handles. They are not global identities.
Roles are optional project-local routing labels; they affect role-targeted
Tachikoma routing, not the behavior of the Codex or Claude TUI.

Common examples:

- `loki` for a Codex reviewer session.
- `musashi` for a Claude implementer session.
- `triton` for a Codex QA or verification session.

Use the runtime commands for normal operation:

```bash
tachikoma codex --name loki --role reviewer
tachikoma claude --name musashi --role implementer
```

Use `tachikoma codex --watch --name loki` when you want a headless Codex worker
instead of an attached TUI.

`join` remains the low-level primitive behind these commands. From an
MCP-connected agent session, call `tachikoma_session_join` with the same name,
runtime, and optional role when you need that lower-level behavior.

Queued inbox work for the name can be claimed when the session joins. Later
sessions can join the same named endpoint and recover pending work from
Tachikoma state.

## Codex And Claude Integration Setup

If you are using a source checkout, build the local CLI first:

```bash
pnpm build
```

For the standard local setup, run:

```bash
pnpm tachikoma init
```

This writes local integration files by default. Use `--no-host-hooks` if you
want MCP and skills without automatic hook delivery.

Setup command behavior:

| Command | Behavior |
| --- | --- |
| `tachikoma init` | Creates or opens the event store and installs local repository integration. |
| `tachikoma init --store-only` | Creates or opens only the event store; writes no repository integration files. |
| `tachikoma init --dry-run` | Prints the init and bootstrap plan without creating the store or writing files. |
| `tachikoma install` | Reapplies repository integration without creating the event store. It fails before writing if tracked integration files would change. |
| `tachikoma install --dry-run` | Prints the repository integration plan without writing files or failing on blocked tracked writes. |
| `tachikoma install --skills` | Regenerates generated Tachikoma skills without rewriting project identity, `.gitignore`, host hooks, or MCP config. |
| `tachikoma reset --dry-run` | Previews the destructive reset of local Tachikoma state without deleting files or recreating the store. |
| `tachikoma reset --force` | Deletes the local event store and runtime binding state, then recreates an empty initialized store. Repository integration files (`project.toml`, `AGENTS.md`, `CLAUDE.md`, `.mcp.json`, skills, hooks) are left intact. |

Common setup options:

| Option | Applies to | Behavior |
| --- | --- | --- |
| `--runtime codex` / `--runtime claude` | `tachikoma init`, `tachikoma install` | Limits generated runtime-specific skills and host hooks. |
| `--all` | `tachikoma init`, `tachikoma install` | Installs runtime-specific integration for all supported runtimes. |
| `--no-host-hooks` | `tachikoma init`, `tachikoma install` | Skips `.codex/hooks.json` and `.claude/settings.local.json`. |
| `--no-codex-trust` | `tachikoma init`, `tachikoma install` | Skips registering the project as trusted in the user-global Codex `config.toml`. |
| `--no-mcp` | `tachikoma init`, `tachikoma install` | Skips `.mcp.json`. |
| `--force` | `tachikoma init`, `tachikoma install` | Allows writes to tracked Tachikoma integration files. |

The global `--store <path>` option only chooses the event store location. It
does not skip repository integration; use `init --store-only` for that.

For a globally installed CLI, run the same setup without `pnpm`:

```bash
tachikoma init
tachikoma install --dry-run
```

You can inspect or reapply the non-destructive repository integration plan:

```bash
pnpm tachikoma install --dry-run
```

### Codex Project Trust And Hook Approval (Required)

Codex gates project-local config, hooks, and exec policies behind **two
separate approvals**. Until both are granted, `.codex/hooks.json` does **not**
run, so the launcher identity is never delivered to the skill context and a
`tachikoma codex` session reports *"launcher identity is not visible in this
skill context."*

1. **Project trust** — Codex only runs project-local hooks for *trusted*
   directories, keyed by exact path (a trusted parent does not cover a
   subdirectory). `tachikoma init` / `tachikoma install` register this for you
   by adding the following to your user-global Codex config
   (`~/.codex/config.toml`, or `$CODEX_HOME/config.toml`):

   ```toml
   [projects."/absolute/path/to/your/project"]
   trust_level = "trusted"
   ```

   Pass `--no-codex-trust` to skip it. Verify with `tachikoma doctor`
   (`codex trust: ok`).

2. **Hook approval** — the first time you open the project in a Codex TUI after
   trusting it, Codex shows *"Hooks need review — N hooks are new or changed"*.
   These are the four Tachikoma delivery hooks (`SessionStart`,
   `UserPromptSubmit`, `PostToolUse`, `Stop`) defined in `.codex/hooks.json`.
   Choose **"Trust all and continue"** (or review them first). This approval is
   intentionally interactive and cannot be automated by `tachikoma init`; it
   only reappears when the hook contents change.

Choosing *"Continue without trusting"* leaves the hooks disabled and the
identity-binding error will persist.

Codex may need explicit user-level MCP registration even when `.mcp.json` has
been generated. Register manually only if `/mcp` does not show `tachikoma`.
`TACHIKOMA_CWD` points at the project repository, not at the Tachikoma install
location.

For a globally installed CLI, register Codex like this:

```bash
PROJECT=/path/to/your/project
codex mcp add \
  --env TACHIKOMA_CWD="$PROJECT" \
  tachikoma \
  -- tachikoma mcp
```

Register Claude Code like this:

```bash
PROJECT=/path/to/your/project
claude mcp add tachikoma \
  --scope local \
  -e TACHIKOMA_CWD="$PROJECT" \
  -- tachikoma mcp
```

For Tachikoma source checkout development, replace `tachikoma mcp` with
`pnpm --dir "$TACHIKOMA_CHECKOUT" tachikoma mcp`; keep `TACHIKOMA_CWD` pointed
at the project repository.

Restart Codex or Claude after registration, then check `/mcp` in the agent
session. Tachikoma should appear as an available MCP server.

You can confirm registration before restarting:

```bash
codex mcp list
claude mcp list
```

## Common Review Loop

One common workflow is to ask Claude to implement and Codex to review:

```bash
pnpm tachikoma codex --name loki --role reviewer
pnpm tachikoma claude --name musashi --role implementer
pnpm tachikoma ask musashi "Implement the open review findings."
```

After implementation, record structured state instead of leaving the result only
in chat:

```bash
pnpm tachikoma claim record \
  --summary "Implemented requested changes" \
  --expect "pnpm test" \
  --request-review \
  --reviewer loki

pnpm tachikoma review finding \
  --summary "Missing cleanup path" \
  --to musashi

pnpm tachikoma verification record \
  --status passed \
  --summary "pnpm test passed" \
  --command "pnpm test"
```

The conversation thread carries messages. The claim, finding, and verification
records define what is true.

## Claude Monitor Delivery Check

For a focused Claude Monitor delivery check, this example uses two named Claude
runtimes. The general model is still any named agent to any named agent.
Initialize integration, restart Claude Code, approve/review hooks, then start
the sessions:

```bash
pnpm tachikoma init --force
pnpm tachikoma claude --name max --role reviewer
pnpm tachikoma claude --name musashi --role implementer
# from max
/tachikoma Send musashi: "ping"
```

If you are already inside a Claude TUI that was not launched by
`tachikoma claude`, use `/tachikoma-boot <name>` for explicit manual join
before using `/tachikoma` or the optional `/tachikoma-relay` shortcut.

Expected behavior: `musashi` receives the ping in its Claude TUI through
Monitor delivery and replies or records state without a human running
`tachikoma inbox`.

Fallback commands when monitor delivery is unavailable:

```bash
pnpm tachikoma hook monitor --name musashi --watch
pnpm tachikoma hook receive --runtime claude --name musashi --format text --event UserPromptSubmit
pnpm tachikoma inbox --as musashi
```

Use `pnpm tachikoma doctor` if delivery does not arrive. Check that the TUI or
monitor command is still running, the session exists, Claude hook trust was
approved, the agent name is not bound to another live session, and delivery mode
supports the path you are using.

## Codex App-Server Diagnostics

Normal Codex realtime delivery uses `tachikoma codex`. The app-server probe is a
diagnostic command for classifying local Codex installs:

```bash
pnpm tachikoma codex probe \
  --app-server-stdio \
  --cwd "$PWD" \
  --agent loki \
  --message "Tachikoma remote-control probe. Reply with exactly: PONG" \
  --wait-ms 120000
```

The probe does not mark Tachikoma messages delivered.

## Reports And Handoffs

Reports and handoffs are regenerated from projections over the event log. They
are readable artifacts, not the source of truth.

```bash
pnpm tachikoma report export .tachikoma/reports/project.md --format markdown
pnpm tachikoma report export .tachikoma/reports/project.json --format json
pnpm tachikoma report handoff .tachikoma/reports/handoff.md --summary "Ready for review"
```

Use reports to share a compact view of state. Use handoffs when another agent or
future session needs to continue from a specific point.

## Reference

For the full command surface and per-command options, use the built-in help:

```bash
pnpm tachikoma --help
pnpm tachikoma <command> --help
```

`tachikoma init` also writes `.tachikoma/agent-instructions.md` into your
repository — the in-repo guidance agents read during coordination.

## Uninstall

`tachikoma uninstall` reverses what `init` wrote into the repository: it removes
`.tachikoma/` (state, store, and project config), the generated `.claude` and
`.codex` skills, the Tachikoma host-hook and MCP entries, the managed
`.gitignore`, `AGENTS.md`, and `CLAUDE.md` blocks, and the project's trust entry
in the user-global Codex `config.toml`. Edits are surgical — other hooks, MCP
servers, trusted projects, and your own instructions are preserved, and
now-empty `.claude`/`.codex` directories are pruned.

```bash
tachikoma uninstall --dry-run   # preview every target without changing files
tachikoma uninstall --force     # apply the removal
```

Uninstall touches repository integration only. Remove the global CLI separately
with `npm rm -g @yusugomori/tachikoma`. A relocated store (`--data-root` or
`TACHIKOMA_HOME` outside the repo) is reported but left in place.

## Development

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Useful local commands:

```bash
pnpm tachikoma --help
pnpm tachikoma doctor
pnpm tachikoma memory
```

## Local-First Safety Notes

- Core state is local and repository-scoped.
- The default store is local SQLite under `.tachikoma/state`; `--data-root`,
  `--store`, or `TACHIKOMA_HOME` can move it.
- The event log is canonical. Projections can be rebuilt.
- Bootstrap should be non-destructive by default.
- Raw transcripts are not ingested by default.
- Tachikoma can launch Codex and Claude wrapper runtimes, but the host tools
  still own their UI/process behavior. Stop attached TUI sessions in the host
  UI; stop Tachikoma-started Codex app-server workers with
  `tachikoma codex stop`.
