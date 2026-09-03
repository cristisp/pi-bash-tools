# subagent-herdr

A pi extension that spawns subagents as live pi sessions in their own herdr tabs.

Each subagent runs in a herdr tab labeled `worker-1`, `reviewer-2`, etc. (agent name
plus a persistent per-workspace counter). Its conversation is stored in
`~/.pi/agent/sessions/subagent-<workspace>-<label>.jsonl` and can be reused across
tasks, so hard-won context is never rebuilt from scratch.

## Install

```bash
pi install npm:@ztc/subagent-herdr
```

## Requirements

- herdr (tested with 0.7.5), with a pi session running inside a herdr pane
- The extension is herdr-only: it registers nothing outside a herdr-managed pi
  session (guarded by `HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`)

## Usage

The extension registers two tools, `subagent` and `subagent_stats`. `subagent` modes:

- `subagent(agent, task)` - single task in a fresh session
- `subagent(tasks: [{agent, task}, ...])` - parallel, up to `maxParallelTasks` (default 8)
- `subagent(chain: [{agent, task}, ...])` - sequential; `{previous}` is replaced
  with the previous step's output
- `subagent(reuseLabel, task)` - continue an existing session in place (same tab,
  same context, only the new turn counts as the result)
- `subagent(listSubagents: true)` - list sessions in a compact form; use `listVerbose: true` for pane, session-file, delegation identity, last-run spend, and last-result diagnostics
- `subagent(agents: true)` - list available agents (name, description, source)
  for the current agentScope; the agent should check this before picking an
  agent name. Unknown agent names fail with the available list, a
  "did you mean" suggestion, and a pointer to this mode.
- `subagent_stats(label)` - compact reuse-relevant stats for one session: context size,
  turns, input/output usage, cost, reuse count, recent task history, the last
  error or the path of the last role report, delegation identity, the spend of
  the last run, and relevant warnings.

Optional delegation context (recorded and exported, never behaviour-changing on
its own): `tier` (0-4), `workflowMode` (`initial` | `remediation`), `reviewMode`
(`primary` | `security` | `validation` | `remediation`), `acceptanceCriteria`
(e.g. `["F-001","F-002"]`), and `evidenceScope` (`session` | `flow`). They apply
to every delegation in the call (single, parallel, chain, reuse) and show up on
the registry entry, in `subagent_stats`, and in the telemetry log.

Reuse judgment: before `reuseLabel`, agents should check `subagent_stats` and
judge cost/impact (context size, turn count, prior tasks, reuse history). Reuse
is intended for same-role worker continuation and narrowly scoped remediation.
Prefer fresh sessions for planning, scouting, review, validation, security,
audit, changed scope, or independent reasoning. Start fresh when context
exceeds 100k tokens, the session exceeds 8 turns, reuse is repeated, task
history does not fit, repository or evidence changed materially, or
independence is required. A reused review/audit/verification session anchors on
its earlier findings and may miss newly introduced ones. Record the session
strategy and reason in the orchestration ledger. The TUI shows the reused
session's state on the `reuse` call line (context, reuse count), in warning
color when context is large, so the choice is visible.

Setting up the standard agents:

- `/setup-subagents` - creates or updates the `planner`, `reviewer`, `scout`, `worker`, and
  `validator` agent files in `~/.pi/agent/agents` (they are not bundled with the
  package). Agent files carry no model - the model lives in presets in the
  config file instead. It prompts for a model with an explicit reasoning level
  (`provider/model:thinking_level`, level: `off`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, or `max`; the templates live in `src/templates.ts`) for each
  of the five standard agents, and writes them into the `default` preset. If the
  config already defines presets, it asks first - declining skips the model
  prompts and only touches the agent files; confirming updates the `default`
  preset while preserving other presets and the `defaultPreset` setting. If the
  config has no presets yet, it is created (or seeded) with the `default`
  preset and `defaultPreset: "default"`. Existing agent files are only
  overwritten after confirmation.

## Model presets

Subagent models are configured as named presets in
`~/.pi/agent/subagent-herdr.config.json`. Each preset maps agent names to
`provider/model(:thinking_level)` specs; agent files no longer carry a `model:`
frontmatter (a leftover one is ignored).

```json
{
  "modelPresets": {
    "default": {
      "planner": "github-copilot/gpt-5.6-luna:high",
      "reviewer": "github-copilot/gpt-5.6-luna:high",
      "scout": "github-copilot/gpt-5.6-luna:low",
      "worker": "github-copilot/gpt-5.6-luna:high",
      "validator": "github-copilot/gpt-5.6-luna:medium"
    },
    "cheap": {
      "planner": "cortecs/deepseek-v4-flash-0731:low",
      "scout": "cortecs/deepseek-v4-flash-0731",
      "worker": "cortecs/deepseek-v4-flash-0731:medium"
    }
  },
  "defaultPreset": "default"
}
```

Resolution per spawn:

1. The preset selected for the current Pi session (`/select-subagent-preset`),
   falling back to `defaultPreset` when the session has no selection (or the
   selected preset no longer exists in the config).
2. The active preset's entry for the agent name; unknown agents and missing
   entries mean the subagent runs with pi's default model (no `--model` flag).
3. Models are validated against pi's model registry: at session start every
   configured preset is checked and a warning lists agent/spec pairs whose
   model no longer resolves; unavailable entries of the active preset are
   pruned at spawn time so the subagent falls back to pi's default model
   instead of launching with a dead `--model`.
4. Invalid entries in the config are dropped (thinking levels are normalized to
   lowercase), and `defaultPreset` is ignored unless it names a configured
   preset.

Selecting a preset:

- `/select-subagent-preset` - interactive picker listing one preset per line
  with each agent and its model/reasoning in brackets, plus a
  `(use config default)` entry to clear the session override. Esc cancels and
  keeps the current selection.
- `/create-subagent-preset` - interactive preset builder: prompts for a preset
  name, then a model with reasoning level for each agent discovered from the
  agents directories (empty input skips that agent, so it runs on the pi
  default model). Offers a confirmation before overwriting an existing preset
  of the same name; other presets are preserved. The new preset is never set as
  `defaultPreset` - change that in the config file, or select the preset per
  session with `/select-subagent-preset`.

Both commands validate each entered model twice: the spec must be syntactically
valid with an explicit reasoning level, and `provider/model` must resolve in
pi's model registry (unknown models are rejected with a warning and re-prompted;
if the registry is unavailable the check fails open).

The status bar shows the active preset as `subagent preset: <name>` (set on
session start, refreshed after selecting, reverting, or running
`/setup-subagents`; hidden when no preset is effective).

The selection is stored in the session itself, so it survives restarts and
`/resume`, forks inherit it, and different sessions can use different presets.
Prompting a live reused session never changes its model; when a reused pane is
dead and gets relaunched, the relaunch uses the preset resolved at reuse time.
The `subagent(agents: true)` listing shows the resolved model per agent.

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
file, working directory, status, last error, and context size
(`contextTokens` - the context size at the last completed turn, for reuse
vs. new decisions). Entries also track `reuseCount` (how many times the session
was reused) and `tasks` (the last 5 tasks it was given, for topical-fit
judgment), plus the delegation identity (`delegationId`, `flowId`, `tier`,
`workflowMode`, `reviewMode`, `acceptanceCriteria`, `evidenceScope`) and
`lastRun` (tool calls, tool errors, repeated reads, turns, cost, context, wait
time and the report digest summary for the most recent completed turn). It is:

- **Workspace-scoped** - entries are keyed `<workspace>:<label>`, so every herdr
  workspace has its own `worker-1`, `worker-2`, ... and its own session files
- **Locked** - all mutations take an exclusive lock file (with stale-lock
  stealing), so multiple workspaces can spawn concurrently without clobbering
  each other

## Delegation identity

Every delegation gets an identity, exported into the child process as environment
variables and recorded on its registry entry:

| Variable | Meaning |
| --- | --- |
| `PI_DELEGATION_ID` | One id per delegation; stable across every reuse of that session |
| `PI_ORCHESTRATION_FLOW` | Shared by every delegation spawned by one root Pi session |
| `PI_ORCHESTRATION_ROLE` | The agent being delegated to |
| `PI_ORCHESTRATION_TIER` | `tier` from the tool call, when supplied |
| `PI_ORCHESTRATION_MODE` | `workflowMode`, when supplied |
| `PI_ORCHESTRATION_REVIEW_MODE` | `reviewMode`, when supplied |
| `PI_ORCHESTRATION_CRITERIA` | `acceptanceCriteria` ids, comma-separated |
| `PI_ORCHESTRATION_EVIDENCE_SCOPE` | Widest evidence scope the child may reuse (`session` or `flow`) |

The contract:

- ids are opaque and match `[A-Za-z0-9_-]{1,64}`
- main sessions get none of these; only spawned children do, and
  `PI_ORCHESTRATION_FLOW` needs a delegating session with a session file (no
  known root session, no flow id)
- absence means unowned: a tool that sees no flow id behaves exactly as it did
  before this contract existed
- a caller may pass `evidenceScope: "session"` to narrow what a child may reuse.
  Narrowing is honoured, widening past `evidenceScopeByRole` /
  `evidenceScopeDefault` is ignored, and a reuse turn can only narrow the scope
  already resolved for that session
- the environment is fixed when the child process launches. A reuse turn that
  prompts a still-live session cannot change that child's env, so `tier` and
  `workflowMode` updates on a reuse turn land in the registry and the telemetry
  record only. Consumers that key caches on these values should treat the
  launch-time identity as immutable for the life of the child process

## Orchestration store

Alongside the registry, the extension keeps one directory per flow and an
append-only telemetry log:

- `~/.pi/agent/subagent-herdr/flows/<flowId>/flow.json` - root session, participants,
  `createdAt` and `lastUsedAt`
- `~/.pi/agent/subagent-herdr/flows/<flowId>/reports/` - the full report of every
  settled delegation, as `reports/<label>-<timestamp>.md`
- `~/.pi/agent/subagent-herdr/flows/<flowId>/predigest/` - reserved for pre-digested evidence
- `~/.pi/agent/subagent-herdr.telemetry.jsonl` - one record per delegation turn:
  identity, outcome (`settled` / `failed` / `aborted`), usage, tool-call and
  failed-tool-call counts, repeated reads, turns, and time spent waiting on
  approvals or steers. `reuseCount` is the session's reuse count after this turn,
  recorded from the registry, so `reused: true` implies `reuseCount > 0`

Flow directories idle past `flowRetentionDays` are pruned at session start. The
store is best-effort: when it is unwritable, delegation works normally and only
measurement is lost. Other tools keep their caches under their own roots; they
may read `flow.json` as a liveness hint but must never require it.

## Role report and digest

A settled delegation no longer dumps its whole final message into the parent
context. The full report is written to the flow's `reports/` directory, and what
the parent receives is a bounded digest plus the absolute report path:

1. the child's `ledger` block verbatim (machine-parseable, small),
2. the status lines that follow it in the report,
3. as much leading prose as fits in `reportDigestTokens`.

When the child omits the ledger block the digest degrades instead of failing: it
carries the status lines (`delegation_status`, `validation_verdict`,
`review_verdict`, `budget`, ...) and records `ledgerParsed: false`. With
`reportContractPolicy: "reject"` the parent is additionally told to treat the
delegation as unfinished rather than being handed a prose answer to re-interpret.

The digest is a transport optimization, not a source of truth: cross-child
aggregation must read the ledger blocks, not digests. Token counts are estimates
(`chars / 4`) until anchored against real counts, and `perTaskOutputCap` remains
an absolute backstop applied to every result path.

The registry and telemetry record only the counts, the truncation flag, the
ledger-parsed flag and the path - never the report text itself, otherwise the
store that every delegation reads would reintroduce the re-read cost this removes.
The registry holds no report prose at all: a settled turn is represented by its
`lastRun.report` counts plus the report path, and only a failed turn keeps its
error text (bounded to 500 characters), because that is the one diagnosis with no
file behind it. Reports under 64 estimated tokens are treated as acknowledgements,
so short reuse turns are not annotated with a contract note.

## Configuration

All defaults can be overridden with a JSON config file at
`~/.pi/agent/subagent-herdr.config.json`. Missing keys fall back to the
defaults; invalid values (non-numeric, negative, ...) are ignored per key. The
file is re-read on every use, so edits take effect without a restart. Running
`/setup-subagents` creates this file with all defaults if it does not exist yet.

```json
{
  "maxParallelTasks": 8,
  "maxConcurrency": 4,
  "pollIntervalMs": 1500,
  "startupTimeoutMs": 30000,
  "settleStabilityMs": 5000,
  "statusLossTimeoutMs": 60000,
  "abortGraceMs": 60000,
  "steerTimeoutMs": 60000,
  "perTaskOutputCap": 51200,
  "reportDigestTokens": 600,
  "reportContractPolicy": "flag",
  "registryLockTimeoutMs": 10000,
  "registryLockStaleMs": 5000,
  "herdrCliTimeoutMs": 8000,
  "defaultAgentScope": "user",
  "confirmProjectAgents": true,
  "flowRetentionDays": 14,
  "evidenceScopeDefault": "flow",
  "evidenceScopeByRole": { "validator": "session" },
  "modelPresets": {},
  "defaultPreset": "default"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `maxParallelTasks` | 8 | Hard cap on `tasks` in one `subagent(...)` call |
| `maxConcurrency` | 4 | How many parallel tasks actually run at once |
| `pollIntervalMs` | 1500 | Poll cycle for subagent status and session tail |
| `startupTimeoutMs` | 30000 | Give up if the subagent produces no output within this after launch |
| `settleStabilityMs` | 5000 | Stable idle time before a run counts as finished |
| `statusLossTimeoutMs` | 60000 | Give up if the herdr agent status vanishes for this long |
| `abortGraceMs` | 60000 | Grace period after an abort before finishing |
| `steerTimeoutMs` | 60000 | Wait for a steer while blocked before finishing |
| `perTaskOutputCap` | 51200 | Per-task byte cap in parallel summaries (bytes) |
| `reportDigestTokens` | 600 | Token budget for the digest a child's report is reduced to |
| `reportContractPolicy` | `"flag"` | `"flag"` or `"reject"` a report that omits its ledger block |
| `registryLockTimeoutMs` | 10000 | Max wait for the registry lock |
| `registryLockStaleMs` | 5000 | Steal the registry lock after this age |
| `herdrCliTimeoutMs` | 8000 | Timeout for each herdr CLI call |
| `defaultAgentScope` | `"user"` | Default `agentScope` when the tool call omits it (`"user"`, `"project"`, `"both"`) |
| `confirmProjectAgents` | `true` | Default for the project-agent confirmation prompt |
| `flowRetentionDays` | 14 | Days a flow directory survives without a delegation before pruning removes it |
| `evidenceScopeDefault` | `"flow"` | Widest evidence scope a delegated child may reuse (`"session"` or `"flow"`) |
| `evidenceScopeByRole` | `{"validator":"session"}` | Per-role overrides of `evidenceScopeDefault`; keeps validators independent of the evidence they audit |
| `modelPresets` | `{}` | Named subagent model presets (see [Model presets](#model-presets)); entries map agent names to `provider/model(:thinking_level)` |
| `defaultPreset` | - | Name of the preset used when the session has no `/select-subagent-preset` selection; must name a configured preset |

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
- Quality gates: `npm run lint` (oxlint, configured in `.oxlintrc.json` - errors
  fail, warnings fail via `--deny-warnings`), `npm run format` / `npm run format:check`
  (oxfmt, configured in `.oxfmtrc.json`), `npm test` (vitest) - the GitLab CI
  pipeline runs all of them plus `tsc` on every push
- `npm pack` / `npm publish` to distribute; the published tarball contains
  `index.ts`, `src/`, `README.md` (see `files` in `package.json`)
- The package is loaded through the `pi` manifest in `package.json`
  (`"pi": { "extensions": ["./index.ts"] }`)
