# Operations

## Reuse

Reuse is an optimization for same-role continuation or narrow remediation, not the default workflow.
First list sessions, copy the exact bare label shown after `reuseLabel:`, and call `subagent_stats` for that label.
Use the stats and task history to judge context size, turns, reuse count, cost, and topical fit.

Prefer a fresh session for planning, scouting, review, validation, security, audit, changed scope, or independent reasoning.
Start fresh when context is above 100k tokens, the session is above eight turns, reuse is repeated, the task history no longer fits, evidence changed materially, or independence is required.
Reusing a review or validation session can anchor it on earlier findings.
A live reused process keeps its launch-time environment and system prompt, so every new turn receives a refreshed authoritative current handoff that supersedes stale task, scope, evidence, and context instructions.

## Status, steering, and blocking

The registry has two public states:

| State | Meaning |
| --- | --- |
| `running` | A fresh task or reuse turn is in flight, and input is allowed. |
| `done` | The result was delivered, and the idle session is read-only until reused. |

While running, a child can be steered by typing in its herdr tab.
A normal message is queued and folded into the final result.
Pressing Escape first aborts the current turn, then a correction starts a fresh turn.
Escape with no correction reports an aborted run after the grace period.

A blocked child remains `running` in the registry.
Approval-waiting means a tool call is pending approval in its tab.
Needs-input means the child is waiting for a steer or another prompt.
The live update and registry keep a bounded preview and start time.
Approve or reject the tool in the child tab, or steer the child there.

## Closing and reconciliation

`subagent_close` may be used only after the user explicitly asks to close subagents.
With a label it closes one session-linked child.
Without a label it closes all children linked to the current Pi session.
The `/kill-session-subagents` command closes all linked children without involving the agent.
Both paths show the affected sessions, warn when work is still running, close the herdr tabs, remove registry entries, and preserve session files.

Changing or closing the main session does not kill its children.
At session start, reconciliation removes registry entries whose panes are gone and marks running entries `done` after a stable idle check.

## Models and presets

Models are configured in `~/.pi/agent/subagent-herdr.config.json` under `modelPresets`.
A preset maps agent names to `provider/model(:thinking_level)` values.
`defaultPreset` supplies the fallback when the current session has no override.

Use `/create-subagent-preset` to build a named preset from discovered agents.
Use `/select-subagent-preset` to select a preset for the current session or return to the config default.
The selection is stored in the session, survives restart and resume, and is inherited by forks.
A live reused process does not change model mid-session.
If a dead reused process is relaunched, the selected preset is resolved at relaunch time.
Unavailable model entries are reported and omitted at spawn so Pi's default model is used instead.

## Configuration

The config file is reread on every use.
Missing or invalid values fall back to defaults.
The most operationally important settings are:

- `maxParallelTasks` and `maxConcurrency` for fan-out size.
- Polling, startup, settle, status-loss, abort, and steer timeouts.
- `perTaskOutputCap` and `reportDigestTokens` for result transport.
- `compositionPolicy` for standard preflight handling.
- `ledgerPointers` and `ledgerMaxRevisions` for ledger handoff.
- `roleBudgets` for tool, discovery, worker pre-implementation discovery, finalization-reserve calls and validation passes, validation, failed-call, repeated-read, output, and wall-time limits.
- `evidenceScopeDefault` and `evidenceScopeByRole` for reusable validation evidence.
- `mutatingCommandRoles`, `validationExecutionRoles`, and `repositoryWriteLock` for safety boundaries.
- `defaultAgentScope` and `confirmProjectAgents` for agent discovery and trust prompts.
- `flowRetentionDays` for flow artifact cleanup.

A `steer` budget breach sends one automatic budget message and then permits only ledger or report reads.
An `abort` breach stops the turn.
Workers retain a protected finalization reserve after implementation for the affected-test query, final validation, and report; writes after final validation require a fresh remediation attempt.
Validation usage is provisional until the matching tool result arrives, so validation-limit breaches are deferred while accepted validation calls are unsettled.
A structured producer preflight rejection refunds only the provisional validation pass and does not undo the attempted tool-call charge or an error charge.
Finalization begins only after a matching executed validation result; duplicate, mismatched, or identity-less results cannot start it.
A breach first observed on the final report is recorded as `report_only` because there is no remaining work to stop.
A declared scope grants additional tool and discovery calls per in-scope path up to the configured ceiling.

## Limitations

The extension has no useful operation outside herdr.
Nested subagents are disabled.
Read-only session enforcement is implemented inside Pi because herdr does not provide native pane locking.
Slash commands still work in a locked tab.
The flow store and telemetry are best-effort and are not required for a child to run.
