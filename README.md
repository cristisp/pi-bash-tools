# subagent-herdr

A pi extension that spawns subagents as live pi sessions in their own herdr tabs.

See the [workflow documentation](docs/docs.md) for the current end-to-end workflow, artifact handoffs, and validation model.

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

The extension registers `subagent`, `subagent_override`, and `subagent_stats` tools. `subagent` modes:

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
- `subagent_override(...)` - the explicit opt-in path for a deliberate per-call
  composition-policy override. It accepts the same delegation shapes as
  `subagent` and requires `compositionPolicy` (`warn` | `enforce` | `off`).
  Normal delegations must use `subagent`, which always uses the configured
  policy and does not expose the override field.
- `subagent_stats(label)` - compact reuse-relevant stats for one session: context size,
  turns, input/output usage, cost, reuse count, recent task history, the last
  error or the path of the last role report, delegation identity, the spend of
  the last run, and relevant warnings.

Optional delegation context (recorded and exported, never behaviour-changing on
its own): `taskId` (e.g. `"T-001"`, reused by every remediation attempt of the
same work), `tier` (0-4), `workflowMode` (`initial` | `remediation`), `reviewMode`
(`primary` | `security` | `validation` | `remediation`), `acceptanceCriteria`
(e.g. `["AC-001","AC-002"]`), `scope` (in-scope paths, hunk identifiers, and
out-of-scope areas), and `evidenceScope` (`session` | `flow`). They apply to every
delegation in the call (single, parallel, chain, reuse) and show up on the registry
entry, in `subagent_stats`, and in the telemetry log. Parallel task scopes must be
disjoint. Attempt numbers are counted from the flow ledger rather than trusted from
the call.

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

## S4 composition evidence gate

Composition checks use the configured `compositionPolicy`, which defaults to `warn`.
The standard `subagent` tool records the default policy, while `subagent_override` records deliberate per-call overrides separately.

The S4 analyzer evaluates additive preflight and child-outcome telemetry without changing legacy composition or delegation counts.
It emits `ENFORCE_CANDIDATE`, `RETAIN_WARN`, or `INSUFFICIENT_EVIDENCE`.
A human release owner must still approve any manual change from `warn` to `enforce`.

Run the gate with:

```bash
npm run s4:gate -- ~/.pi/agent \
  --independent-review pending \
  --from 2026-01-01 --to 2026-01-08 \
  --json /tmp/s4-decision.json \
  --markdown /tmp/s4-decision.md
```

The `--from` and `--to` options must be supplied together when an explicit window is required.
The independent-review option defaults to `pending`.
An ordinary reviewer `PASS` does not count as independent-review evidence without an explicit handoff and passing independent-review status.

By default, the gate writes `subagent-herdr.s4-decision.json` and `subagent-herdr.s4-decision.md` under the selected agent directory.
Explicit `--json` and `--markdown` paths are recommended for release artifacts.
The S4 path never rewrites `analysis/MEASUREMENT.md`.
The normal `npm run test:analyze` path remains the command that generates that legacy measurement report.

The fixed version-1 policy is stored in `analysis/s4-policy.json` and requires:

- at least 8 valid preflights;
- a representative window of at least 7 days;
- at least 2 eligible observations for every composition rule;
- at least 1 independent review pass;
- zero unknown evidence, unresolved or abandoned outcomes, and regressions after reviewer pass;
- escalation at or below 25%; and
- zero Tier 1 discovery failures without a scout.

Missing, malformed, uncorrelated, or unknown evidence is insufficient evidence rather than a zero-rate pass.
The gate exits with status `0` only for `ENFORCE_CANDIDATE`, status `1` for a non-candidate decision, and status `2` for invalid CLI options.
See [analysis/TELEMETRY_SCHEMA.md](analysis/TELEMETRY_SCHEMA.md) for the record contract.

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

`/setup-subagents` also writes the orchestration guide to
`~/.pi/agent/agents/subagent_orchestration.md`, beside the agent files. The guide is the workflow
contract for the main session: workflow tiers, the canonical ledger, role boundaries, budgets, session
reuse, and handoff requirements. Its source is `src/orchestration-guide.md`, and the role budget lines
are generated from the budgets in effect (see `roleBudgets`), so changing a budget and rerunning the
command keeps the guidance and the enforcement stating the same numbers. Those lines are a snapshot of
the config at install time, so rerun the command after changing a budget; `subagent_stats` is the live
source for what a session actually spent. Nothing needs to be added to the system prompt: the `subagent`
tool description carries the pointer to the generated path and the triggers for reading it, which are a
multi-worker fan-out, a remediation round, or any task the guide classifies above a single reviewed
worker. An unconditional system-prompt read costs the whole guide before the first delegation. When an older hand-maintained copy such as `~/.pi/agent/SUBAGENTS_GUIDE.md` still
exists, the command reports it as superseded - delete it, because two copies of one contract drift.

The installed `bash-tools` 1.1.6 producer grants one composite operator per project for flow-scoped child seats by default; `paths` are no longer part of that authorization identity.
The extension consumes that policy but does not write the producer policy file.
Workers publish reusable evidence with `publish: { flowId }`, consumers resolve with `{ ref, flowId?, covers? }`, and `fresh: true` is an execution request rather than a lookup.
Single-flight coordination is process-local; flow publication shares completed evidence but does not coordinate active executions across child processes.

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

Approval-waiting is also detected directly from the session tail: child sessions
record pi `ui_prompt_start`/`ui_prompt_end` extension-UI prompt markers in their
session file, and the poller blocks on those markers independently of herdr's
agent status. Children additionally emit the `herdr:blocked` pi event (same
shape arx uses: `{ active: true, label }` on prompt open, `{ active: false }` on
close), which the herdr daemon consumes to surface blocked state on the child's
tab in real time without waiting for the parent poll. This covers any extension
prompt, including bash-tools policy approval dialogs that never surface as herdr
`blocked`. The daemon-blocked path described above remains supported, and both
paths share the same
`blockedSince`/`blockReason`/`blockedPreview` state and notifications, including the live
status tag. While a prompt is open the subagent is never reported as settled. A child's end
marker write is best-effort, so a lost end marker cannot wedge the poll: once the daemon has
reported `idle`/`done` for longer than `uiPromptLostIdleMs` (a genuinely open dialog keeps the
daemon at `working`), the marker is expired silently — the block fields clear and the run
settles normally, without a resolved notification.

Children also patch visual metadata on their own herdr pane while a dialog is
open (`herdr pane report-metadata`, source `subagent-herdr`): a
`working=awaiting input` state label, plus a `summary` token carrying the
bounded prompt title, and both are cleared when the dialog closes. A 30 minute
TTL backstops a lost end report so the pane cannot stay labeled forever. The
metadata is visual-only: herdr's semantic state, waits, and notifications are
unchanged (herdr would need to consume the markers for that upstream). For both to show, the sidebar needs them as tokens in
`ui.sidebar.agents.rows`: `state_text` renders the label and `$summary` renders
the summary token.

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
judgment), plus the delegation identity (`delegationId`, `flowId`, `taskId`,
`tier`, `workflowMode`, `reviewMode`, `acceptanceCriteria`, `evidenceScope`,
`ledgerRevisionAtLaunch`) and `lastRun` (tool calls, tool errors, repeated reads,
turns, cost, context, wait time, the report digest summary, scope, review-surface,
manifest, and the ledger revision and pointer route for the most recent completed
turn). It is:

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
| `PI_ORCHESTRATION_TASK` | `taskId`, when supplied |
| `PI_ORCHESTRATION_EVIDENCE_SCOPE` | Widest evidence scope the child may reuse (`session` or `flow`) |
| `PI_ORCHESTRATION_ROOT_SESSION` | Explicit root Pi session attribution |
| `PI_ORCHESTRATION_PARENT_PANE` | Pane that directly launched the child |

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
- independence is requested per delegation, not owned by config: every role
  inherits `flow` by default, so a validator resolves the worker `verify` ref
  instead of re-running the gate. Pass `evidenceScope: "session"` on a validator
  delegation whose checks are security-sensitive, environment-sensitive, or
  release-critical; a `session` child cannot resolve sibling refs, so it must
  execute them itself
- the environment is fixed when the child process launches. A reuse turn that
  prompts a still-live session cannot change that child's env, so `tier` and
  `workflowMode` updates on a reuse turn land in the registry and the telemetry
  record only. Consumers that key caches on these values should treat the
  launch-time identity as immutable for the life of the child process
- the same immutability applies to the appended system prompt, which is why the
  flow ledger reaches a child as a pointer (see below) instead of as its body

Refs minted by `verify` inherit the scope of the process that minted them.
The extension sets `PI_ORCHESTRATION_FLOW` in the root process at startup and exports it into every delegation launch command, so the main session and its children share one flow id: a ref either side mints is resolvable from the other.
When the main session modifies files and then delegates, the child can resolve the main session's already-run checks instead of reporting them as `NOT_RUN`.
Refs travel child to parent as text, and resolution travels the other way only inside one flow.

## Orchestration store

Alongside the registry, the extension keeps one directory per flow and an
append-only telemetry log:

- `~/.pi/agent/subagent-herdr/flows/<flowId>/flow.json` - root session, participants,
  `createdAt` and `lastUsedAt`
- `~/.pi/agent/subagent-herdr/flows/<flowId>/reports/` - the full report of every
  settled delegation, as `reports/<label>-<timestamp>.md`
- `~/.pi/agent/subagent-herdr/flows/<flowId>/predigest/` - the shared review-surface snapshot and persisted read manifests
- `~/.pi/agent/subagent-herdr/flows/<flowId>/ledger.md` - the flow ledger, one
  machine-readable revision per delegation boundary
- `~/.pi/agent/subagent-herdr.telemetry.jsonl` - append-only records for composition boundaries,
  S4 preflights, and delegation turns. Ordinary delegation records contain identity,
  outcome (`settled` / `failed` / `aborted`), usage, tool-call and failed-tool-call counts,
  repeated reads, turns, and time spent waiting on approvals or steers.
  `reuseCount` is the session's reuse count after this turn, recorded from the registry,
  so `reused: true` implies `reuseCount > 0`

A scoped fan-out receives one flow-level review-surface snapshot containing working-tree status, diff stat, and hunk headers at `predigest/review-surface.md`.
Each child also receives a temporary read manifest containing its allowed paths, prior report paths, established evidence, and do-not-reread paths.
The manifest is persisted under `predigest/manifests/` and its path is included in the role report, registry, `subagent_stats`, and telemetry.
Manifest-protected rereads appear in `subagent_stats` as a warning when a do-not-reread path is read more than once in the turn; the first read is retained as evidence and a documented evidence-gap read is never blocked.

Flow directories idle past `flowRetentionDays` are pruned at session start. The
store is best-effort: when it is unwritable, delegation works normally and only
measurement is lost. Other tools keep their caches under their own roots; they
may read `flow.json` as a liveness hint but must never require it.

## Flow ledger

The ledger is the state a flow carries from one delegation to the next: task
identity, attempt, tier, criteria, evidence scope, and the verdicts each role
returned. It is written by the extension, at two points per turn - a `dispatch`
revision when the child is launched or re-prompted, and a `result` revision when
the turn finishes, which folds the child's own ledger block and report path into
the flow.

Children get a pointer, never the body. A fresh launch receives about 50 tokens in
its appended system prompt:

```text
## Orchestration ledger

Path: ~/.pi/agent/subagent-herdr/flows/f85f194e1b61c28e3/ledger.md
Revision: 4
```

and is told to read that file with its own `read` tool. A reuse turn, whose system
prompt was frozen at launch, gets a one-line `ledger: <path>@<revision>` prefix on
its task text when the revision has advanced. Injecting the body at launch would
have been cheaper per token and wrong on reuse: a reused session would carry its
launch-time ledger forever, and a stale ledger reads as authoritative.

Rules the store enforces rather than requests:

- **Only the delegating session writes.** `ledger.md` is mode `0400`, so a child
  with the `write` or `edit` tool gets `EACCES` when it tries to record its own
  verdict. Roles that only inspect (`scout`, `planner`, `reviewer`, `validator`)
  additionally have no mutating tools in their allowlists.
- **Revision numbers never repeat.** Numbering continues from
  `lastLedgerRevision` in `flow.json`, so a truncated or rewritten ledger cannot
  make one revision mean two things.
- **Attempts are counted, not trusted.** `attempt` is the number of earlier
  `dispatch` revisions carrying the same `taskId`, plus one.
- **Values stay scalar.** Every field is flattened to one line and bounded to 200
  characters, and only an allowlist of child verdict fields is folded in, so the
  file a later child reads cannot grow into a report.
- **It degrades silently.** An unwritable store means no ledger and no pointer, not
  a failed delegation.

`ledgerMaxRevisions` caps how many revisions are kept; the oldest are dropped when
appending, and the whole file ages out with its flow directory.
`ledgerPointers: false` turns the whole mechanism off, including the writes.

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
Analyzer-facing telemetry fields are documented in [analysis/TELEMETRY_SCHEMA.md](analysis/TELEMETRY_SCHEMA.md).
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
  "uiPromptLostIdleMs": 30000,
  "perTaskOutputCap": 51200,
  "reportDigestTokens": 250,
  "scopeCallAllowancePerPath": 2,
  "scopeCallAllowanceMax": 32,
  "reportContractPolicy": "flag",
  "compositionPolicy": "warn",
  "ledgerMaxRevisions": 60,
  "ledgerPointers": true,
  "registryLockTimeoutMs": 10000,
  "registryLockStaleMs": 5000,
  "herdrCliTimeoutMs": 8000,
  "defaultAgentScope": "user",
  "confirmProjectAgents": true,
  "flowRetentionDays": 14,
  "evidenceScopeDefault": "flow",
  "evidenceScopeByRole": {},
  "mutatingCommandRoles": ["worker"],
  "validationExecutionRoles": ["worker", "validator"],
  "repositoryWriteLock": true,
  "roleBudgets": {
    "scout": { "toolCalls": 20, "discoveryCalls": 8, "fullValidationPasses": 2, "failedToolCalls": 3, "repeatedReads": 3, "outputTokens": 800, "wallTimeMs": 600000, "budgetPolicy": "steer" },
    "planner": { "toolCalls": 20, "discoveryCalls": 6, "fullValidationPasses": 2, "failedToolCalls": 3, "repeatedReads": 3, "outputTokens": 800, "wallTimeMs": 600000, "budgetPolicy": "steer" },
    "worker": { "toolCalls": 24, "discoveryCalls": 24, "implementationDiscoveryCalls": 12, "fullValidationPasses": 2, "failedToolCalls": 3, "repeatedReads": 3, "outputTokens": 1000, "wallTimeMs": 600000, "budgetPolicy": "steer" },
    "validator": { "toolCalls": 20, "discoveryCalls": 12, "fullValidationPasses": 3, "failedToolCalls": 3, "repeatedReads": 3, "outputTokens": 800, "wallTimeMs": 600000, "budgetPolicy": "steer" },
    "reviewer": { "toolCalls": 32, "discoveryCalls": 28, "fullValidationPasses": 2, "failedToolCalls": 3, "repeatedReads": 3, "outputTokens": 4000, "wallTimeMs": 600000, "budgetPolicy": "steer" }
  },
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
| `uiPromptLostIdleMs` | 30000 | Treat an open ui-prompt marker as lost (and allow settling again) once the daemon has reported `idle`/`done` for this long |
| `perTaskOutputCap` | 51200 | Per-task byte cap in parallel summaries (bytes) |
| `reportDigestTokens` | 250 | Token budget for the digest a child's report is reduced to |
| `reportContractPolicy` | `"flag"` | `"flag"` or `"reject"` a report that omits its ledger block |
| `compositionPolicy` | `"warn"` | Composition handling for standard delegations: `warn`, `enforce`, or `off` |
| `ledgerMaxRevisions` | 60 | Ledger revisions kept per flow before the oldest are dropped |
| `ledgerPointers` | true | Whether children receive ledger pointers (and the ledger is written at all) |
| `registryLockTimeoutMs` | 10000 | Max wait for the registry lock |
| `registryLockStaleMs` | 5000 | Steal the registry lock after this age |
| `herdrCliTimeoutMs` | 8000 | Timeout for each herdr CLI call |
| `defaultAgentScope` | `"user"` | Default `agentScope` when the tool call omits it (`"user"`, `"project"`, `"both"`) |
| `confirmProjectAgents` | `true` | Default for the project-agent confirmation prompt |
| `flowRetentionDays` | 14 | Days a flow directory survives without a delegation before pruning removes it |
| `evidenceScopeDefault` | `"flow"` | Widest evidence scope a delegated child may reuse (`"session"` or `"flow"`) |
| `evidenceScopeByRole` | `{}` | Per-role overrides of `evidenceScopeDefault`; empty means every role, the validator included, inherits `flow` and can resolve a sibling ref |
| `mutatingCommandRoles` | `["worker"]` | Roles whose children may run commands that write to the repository. Enforcement covers `project_command` ids that write, where a variant of a family that has a writing form is refused unless it names a `check`, `verify`, or `ci` form, and any `verify` call that overrides a phase through `scripts`, because each phase accepts an arbitrary package script and its defaults are the read-only checks. The rule is shaped by command names, so a write-capable script in a family with no known writing form is not recognised as a write |
| `validationExecutionRoles` | `["worker","validator"]` | Roles permitted to execute validation. Every other role, the reviewer included, may call `verify` with `{ ref, flowId?, covers? }` for lookup; `publish` and `fresh` remain execution-capable and are refused, so evidence handoff is enforced rather than requested |
| `repositoryWriteLock` | `true` | Serialize repository-writing `project_command` calls across child sessions and refuse a validation check that would run while a sibling holds a write in flight. The lock is keyed by repository root, so it also covers two flows sharing one checkout, and an abandoned hold is dropped after 5 minutes. Exclusion fails open: an unusable lock store allows the call rather than wedging every write in a flow |
| `roleBudgets` | role defaults | Live limits for tool calls, discovery, worker pre-implementation discovery, validation, failed calls, repeated reads, output tokens, wall time, and enforcement policy |
| `scopeCallAllowancePerPath` | 2 | Extra tool and discovery calls granted per path declared in a child's assigned scope |
| `scopeCallAllowanceMax` | 32 | Ceiling on the extra calls the scope allowance can add to a role budget |
| `modelPresets` | `{}` | Named subagent model presets (see [Model presets](#model-presets)); entries map agent names to `provider/model(:thinking_level)` |
| `defaultPreset` | - | Name of the preset used when the session has no `/select-subagent-preset` selection; must name a configured preset |

Role budgets accept positive finite numeric limits and either `steer` or `abort` as the policy.
Invalid per-role values are ignored and fall back to the role defaults.
A `steer` breach sends one automatic budget message, then permits only reads of the active flow ledger or persisted reports.
An `abort` breach stops the child turn.
Live usage and breach state are shown in registry status, child results, and telemetry.
`outputTokens` bounds report prose: output emitted on a turn that issued a tool call is recorded as
`budget.usage.toolArgumentTokens`, and the reasoning share reported by the provider is recorded as
`budget.usage.reasoningTokens`, because both are already bounded by the call and wall-time limits.
The last turn of a child run is the report itself, so a breach first seen there is recorded and marked
`report_only` without steering or aborting; an intervention at that point would only produce a second,
shorter report to replace the one already delivered.
A delegation that declares `scope.paths` gets `scopeCallAllowancePerPath` more tool and discovery
calls per in-scope path, up to `scopeCallAllowanceMax` in total, so a review of ten paths is not cut
off while acquiring the ten reads it was asked to inspect; the child prompt states the effective numbers.
A single `verify` call is one full validation pass, because it runs the format, lint, typecheck, and test
gate in order. A `verify` call that supplies a `ref` resolves stored evidence instead of running the gate,
so it is not charged against `fullValidationPasses` and stays available as the cheap alternative to a
rerun. Minted and resolved refs are recorded per delegation as `metrics.validationRefs` with the verdict
and whether the call reused or executed, which is what makes reuse auditable. A ref minted by a child seat
inside a flow resolves for every sibling in that flow, observed: a worker minted refs and a validator seat
resolved both by bare `{ ref }` lookup without executing anything. A ref minted by a root session lives only
in that process, so refs travel from child to parent and never the other way round. Two caveats stay true.
Minting depends on the exact `verify` call shape being authorized without a prompt, because a child cannot
answer an authorization prompt (the `F9` authorization boundary). A lookup reports the recorded and current repository
state through `repositoryStateStatus`: `matches` can be cited, `mismatch` requires re-execution, and `unreadable`
must be reported as `NOT_RUN` (`F5`). A sibling ref you cannot resolve is still a capability gap to report, not
evidence to trust.
For workers, `implementationDiscoveryCalls` limits discovery before the first implementation tool call.
After that allowance, the runtime blocks further non-report tools until the worker attempts an implementation tool call.

### Parallel workers and the shared tree

Every child of a fan-out works in the same working tree, so a check one sibling runs observes all siblings' edits.
A `verify` ref minted in that moment describes the union of the in-flight changes rather than the change that worker was asked to make, and no amount of hashing fixes that.
The rule is therefore about ownership rather than caching: the composite gate runs once per state with one owner, normally the session that integrates the fan-in, and siblings run focused read-only checks over their declared paths or none.
The guide states this in `Parallel fan-out and validation`.

Two mechanical guards back the prose while `repositoryWriteLock` is on. A command that writes the repository takes an exclusive per-repository hold for the duration of that call, so a second sibling attempting one is refused with the holder's label, command, and age whenever the entry can be parsed; when it cannot, the refusal says so instead of naming a session it did not read: that class is a formatter, a lint fix, a `verify` call carrying a `scripts` override, and also a command that writes generated output rather than tracked sources, such as `node_build` or a coverage or snapshot-updating test variant. Exclusion is deliberately wider than permission here, because a validator may legitimately run a build without being allowed to rewrite sources. A check that reads the tree, meaning a `verify` execution or a validation `project_command`, refuses to start while another session holds that write, because its result would be evidence about a half-written tree.

The details that decide whether this helps or wedges the work: a session is identified by label *and* flow, so two flows sharing one checkout contend even when both allocate a `worker-1`, and a session never blocks on its own hold. A `{ ref }` lookup is never blocked. A refusal costs a tool call and no validation pass, because the command did not run, and the block reason says to report the contention after three retries. The hold is taken only once the call has cleared every other refusal, so a budget-refused command cannot exclude its siblings for a write that never happened. The key is the nearest ancestor holding `.git`, or the working directory itself outside any checkout, so unrelated directories never contend, and each key is the first 32 hex characters of the SHA-256 of that path stored as `<agent directory>/subagent-herdr/repo-locks/<hash>.lock`, which is the file to inspect or delete when a hold looks stuck. A hold left behind by a killed child expires after 5 minutes, an entry that cannot be decoded stops excluding anyone after 2 seconds, and an unusable lock store allows the call rather than blocking every write in the flow. An entry this session cannot *read* is the one case it will not clear on your behalf: it is held until it is older than the TTL plus a minute of clock headroom, and only then removed by whoever finds it, because a reader that cannot inspect a hold is not entitled to free it. A hold that is genuinely stuck is the operator's to delete, and the refusal names the holder, the command and the age, so nobody has to guess which session to interrupt.

Classification is conservative before execution because the consumer must decide whether a command may run before the producer returns its result. `bash-tools` also reports `mutating` on execution and decision records. A project script that writes through an unrecognised name is therefore not excluded, and an unrecognised variant of a family that has a writing form is excluded conservatively; the guide rule about who owns the gate is what covers the remainder.

### Upgrading from an earlier configuration

`evidenceScopeByRole` no longer ships a `validator: "session"` entry, because that entry is what forced a
validator to re-execute evidence the worker had already minted. A config file written from an older sample
overrides the new default, so delete that line to let validators resolve refs; independence is now requested
per delegation with `evidenceScope: "session"`. The validator's `fullValidationPasses` default dropped from
8 to 3 for the same reason: a validator that resolves refs executes at most the uncovered remainder, and a
validator that needs eight passes is re-running evidence that exists.

Both `verify` and the ref-first prompts live in the installed agent definitions, so after updating the
extension run `/setup-subagents` to regenerate them. Until you do, delegated children keep the previous
tool allowlists and cannot mint or resolve refs.

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
- `npm run test:analyze` measures the orchestration against the live stores in the agent
  directory and rewrites `analysis/MEASUREMENT.md` (delivered `subagent` result sizes before
  and after the report cutoff, digest-to-report ratio, ledger compliance, root carry). It is
  not part of `npm test` because it reads real session history instead of fixtures
- The package is loaded through the `pi` manifest in `package.json`
  (`"pi": { "extensions": ["./index.ts"] }`)
