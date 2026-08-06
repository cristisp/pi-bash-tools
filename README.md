# subagent-herdr

A pi extension that spawns subagents as live pi sessions in their own herdr tabs.

Each subagent runs in a herdr tab labeled `worker-1`, `reviewer-2`, etc. (agent name
plus a persistent per-workspace counter). Its conversation is stored in
`~/.pi/agent/sessions/subagent-<workspace>-<label>.jsonl` and can be reused across
tasks, so hard-won context is never rebuilt from scratch.

## Install

```bash
pi install npm:subagent-herdr
```

Or from git or a local path: `pi install git:github.com/<you>/subagent-herdr`,
`pi install /path/to/subagent-herdr`. The extension then hot-reloads with
`/reload` (or on the next start).

## Requirements

- herdr (tested with 0.7.5), with a pi session running inside a herdr pane
- The extension is herdr-only: it registers nothing outside a herdr-managed pi
  session (guarded by `HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`)

## Usage

The extension registers one tool, `subagent`. Modes:

- `subagent(agent, task)` - single task in a fresh session
- `subagent(tasks: [{agent, task}, ...])` - parallel, up to 8 tasks
- `subagent(chain: [{agent, task}, ...])` - sequential; `{previous}` is replaced
  with the previous step's output
- `subagent(reuseLabel, task)` - continue an existing session in place (same tab,
  same context, only the new turn counts as the result)
- `subagent(listSubagents: true)` - list all sessions in the registry

Setting up the standard agents:

- `/setup-subagents` - creates or updates the `planner`, `reviewer`, `scout`, and
  `worker` agent files in `~/.pi/agent/agents` (they are not bundled with the
  package). It asks for the model first, as `provider/model(:thinking_level)` -
  e.g. `github-copilot/gpt-5.6-luna:high` or `cortecs/deepseek-v4-flash-0731`
  (level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; the templates live in
  `templates.ts`). Existing files are only overwritten after confirmation.

Closing subagents (two entry points, same behavior):

- `subagent_close` tool - the agent may call it only when the user explicitly asks; with an optional `label` it closes just that session-linked subagent (e.g. retire a broken session), without a label it closes all subagents linked to the current session
- `/kill-session-subagents` user command - closes all subagents linked to the current session without involving the agent

Both list the affected subagents, ask for confirmation (warning when any is still running), close the herdr tabs, and remove the entries from the registry. Session files are always preserved.

Agents are discovered from `~/.pi/agent/agents` (and optionally project-local
agents via `agentScope: "both"`).

## Blocked subagents (approval-waiting)

When a subagent blocks (herdr reports `blocked`), the main session is told what it
is waiting for:

- **Approval-waiting** - a tool call (typically a bash command gated by arx) is
  pending approval in the subagent's tab. Detected from the session tail: the
  assistant's tool call is written before the gate, its `toolResult` only after
  approval. The live update shows `[blocked - awaiting approval: bash <cmd>]`,
  a `ui.notify` fires once when the subagent first blocks, and the final result
  renderer shows `blocked - awaiting approval: bash <cmd>, since <HH:MM>
  (approve/reject in tab <ws>:<label>)`.
- **Needs input** - anything else (a steer not yet answered, another prompt).
  Shows `blocked - needs input ... (steer in tab <ws>:<label>)`.

While blocked, the subagent stays `running` in the registry with
`blockedSince`/`blockReason`/`blockedPreview` recorded, so `listSubagents` and
the close-subagents confirmation show `blocked since <HH:MM> (awaiting
approval: ...)` even after the run that spawned it ended. The fields clear when
the subagent unblocks or completes.

## Lifecycle

A session is always in one of two states, tracked in the registry:

| State | Input allowed? | Meaning |
|-------|----------------|---------|
| `running` | yes | A task is in flight (fresh spawn or reuse) |
| `done` | no | The result was delivered to the main agent; the tab is read-only |

Transitions:

1. **Spawn** - a new tab is created, pi is launched with the task, status `running`
2. **Deliver** - once the session settles (idle + stable, with pending steers
   answered), the result returns to the main agent and the status flips to `done`
3. **Reuse** - `reuseLabel` flips the status back to `running` and prompts the
   session in place
4. **Repeat** - delivery locks it again

The read-only enforcement happens in the subagent's own pi process: the extension
intercepts `input` events and blocks them with a warning toast when the session is
`done` and its agent is idle. If the session is actively working or blocked, input
is allowed so steering always works.

## Steering

While a subagent is `running` you can correct its course directly in its tab:

- **Type a message** - it is queued as a steer, folded into the final outcome, and
  the result is marked `[steered]`
- **Esc, then type** - hard-stops the current turn, then your message starts a
  fresh corrected turn; the main agent waits up to 60s after an abort for this
- **Esc with no correction** - the run is reported as aborted after the grace
  window; the tab stays open and reusable

## Registry

`~/.pi/agent/subagent-herdr.json` maps every session to its pane, tab, session
file, working directory, status, last result, and context size
(`contextTokens` - the context size at the last completed turn, for reuse
vs. new decisions). It is:

- **Workspace-scoped** - entries are keyed `<workspace>:<label>`, so every herdr
  workspace has its own `worker-1`, `worker-2`, ... and its own session files
- **Locked** - all mutations take an exclusive lock file (with stale-lock
  stealing), so multiple workspaces can spawn concurrently without clobbering
  each other

## Lifecycle of the main session

Closing or switching the main session (`/new`, `/resume`, tab close, ...) does
**not** kill subagents or drop their context. On every session start (factory
load and `session_start`), a reconciliation pass runs:

- Entries whose tab was closed are pruned from the registry (session files stay
  on disk)
- Entries stuck `running` whose agent is idle (double-checked over 5s) flip to
  `done`, so they lock correctly after the main agent is gone

## Limitations

- No subagent tool outside herdr (the original child-process extension was
  removed; the herdr transport replaces it)
- Nested subagents are disabled: a subagent cannot spawn its own subagents
  (`PI_SUBAGENT_NESTED=1`)
- herdr 0.7.5 has no native pane locking, so read-only is enforced at the pi
  level (input interception); slash commands still work in a locked tab
- To un-archive a session manually, edit the registry and set its `status` back
  to `"running"` or just `reuseLabel` it

## Development

- `npm install` (installs the peer pi packages + typescript), then `npm run typecheck`
- `npm pack` / `npm publish` to distribute; the published tarball contains
  `index.ts`, `agents.ts`, `README.md`, `LICENSE` (see `files` in `package.json`)
- The package is loaded through the `pi` manifest in `package.json`
  (`"pi": { "extensions": ["./index.ts"] }`)
