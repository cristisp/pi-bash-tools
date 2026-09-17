# Workflow

## Preconditions and setup

The extension loads only when Pi is running inside herdr with `HERDR_ENV`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID` available.
The root session owns orchestration; nested child sessions are marked with `PI_SUBAGENT_NESTED=1` and cannot spawn more children.

Agent definitions are Markdown files with `name` and `description` frontmatter.
User agents are discovered from `~/.pi/agent/agents`.
Project agents are discovered from the nearest `<config-dir>/agents` directory when `agentScope` is `project` or `both`.
Project-local agents require confirmation by default because they are repository-controlled.

Run `/setup-subagents` to create the standard `planner`, `reviewer`, `scout`, `worker`, and `validator` files and the generated orchestration guide.
The command also prompts for models and updates the `default` model preset.
Run it again after changing role budgets so the generated guide reflects the live configuration.

## Choose a workflow

Classify risk, uncertainty, validation complexity, and boundary crossings before delegating.
Use the smallest workflow that preserves the required independence.

| Tier | Shape | Use when |
| --- | --- | --- |
| 0 | Main session only | Documentation, analysis, configuration, or negligible-risk mechanical work |
| 1 | `worker(initial)` then `reviewer(primary)` | Localized implementation with simple deterministic validation |
| 2 | `planner(initial)` then `worker(initial)` then `reviewer(primary)` | Coordinated implementation with multiple criteria or checks |
| 3 | `scout` then `planner` then `worker` then `validator` then `reviewer` | High-risk, unfamiliar, security-sensitive, or broad-impact work |
| 4 | Primary review plus a focused security or validation review | A specific independent concern needs its own reviewer |

A reviewer owns semantic approval.
A validator owns objective validation only and never approves the implementation.
After a reviewer failure, targeted `worker(remediation)` then `reviewer(remediation)` is the default.
Add a validator to remediation when the evidence itself is questioned or the workflow already includes one.
Stop after two unsuccessful reviews of the same finding family and escalate instead of repeating unchanged work.

Read the generated guide before a Tier 2 or higher workflow, a parallel fan-out, or a remediation round.

## Call modes

The `subagent` tool accepts exactly one of these modes:

```json
{"agent":"worker","task":"..."}
{"tasks":[{"agent":"worker","task":"...","scope":{"paths":["src/a.ts"]}}]}
{"chain":[{"agent":"planner","task":"..."},{"agent":"worker","task":"Use this plan:\n{previous}"}]}
{"reuseLabel":"worker-1","task":"Continue the narrowly scoped remediation."}
{"listSubagents":true}
{"agents":true}
```

A chain substitutes `{previous}` with the previous step's final output.
Parallel work is capped by `maxParallelTasks` and `maxConcurrency`.
Every parallel review scope must have disjoint `scope.paths`.
All children share the same working tree, so a parallel child must not treat its local view as an independent checkout.

Call `subagent({"agents":true})` before selecting an agent name when the available definitions are not already known.
Use the exact discovered name.
Call `subagent({"listSubagents":true})` before reuse, then call `subagent_stats` with the exact bare `reuseLabel` shown for the active session.

## Boundary preflight

Before any child is launched, the extension records an S4 preflight and evaluates the standard composition rules.
The configured `compositionPolicy` is `warn` by default.
`warn` reports a violation and still launches, `enforce` refuses the boundary, and `off` disables the checks.
Only `subagent_override` can deliberately supply a per-call policy override.

The rules are:

- **R1:** The first validator should use the worker's `verify` reference rather than duplicate the deterministic gate.
- **R2:** Multiple parallel reviewers need non-empty, disjoint `scope.paths`.
- **R3:** A Tier 2 or lower validator that is intended to be independent must use `evidenceScope: "session"`.
- **R4:** A Tier 3 worker needs a completed planner before it runs, which means a preceding planner in a chain rather than array order in a fan-out.

Warnings are included in the parent result and telemetry.
A refusal returns before child creation.
The S4 analyzer is evidence for a future policy decision and never changes `compositionPolicy` automatically.

## Launch and execution

A fresh delegation receives a persistent label such as `worker-1` and a session file under `~/.pi/agent/sessions`.
The label counter is persistent per herdr workspace and agent name.
The extension creates a herdr tab, starts Pi with the child task and agent system prompt, and polls the child until it settles.

The task carries the assigned paths, hunks, out-of-scope areas, review-surface pointer, read-manifest pointer, ledger pointer, current context mode, evidence state, and final-state validation requirements when those artifacts exist.
The child also receives orchestration environment variables for its delegation id, flow, role, tier, mode, task id, review mode, criteria, evidence scope, root session, parent pane, and scope size.

A fresh child receives a compact current handoff and treats the ledger and manifest as bounded recovery pointers rather than mandatory historical preloads.
A reused child receives the same refreshed current handoff, including an authoritative scope and policy that supersede the frozen launch prompt.
Bounded recovery is limited to one named stale, rejected, ambiguous, or otherwise required evidence gap; failed or stale evidence remains `NOT_RUN`.
Full context is explicit and reserved for audit, integration, or recovery handoffs.
The child emits one compact fenced ledger block in its final response.
The extension owns the flow ledger and folds selected child fields into the result revision.

The agent definition determines the child tool set, while the role and live budget determine which operations are allowed.
Workers can implement and validate within the configured policy.
Reviewers are read-only and can resolve validation references but cannot execute the validation gate.
Validators can execute approved validation surfaces without modifying source or configuration.

## Completion and handoff

A settled child with report output writes its full output to a flow role report when a flow exists.
The parent receives a digest containing the child ledger block, status signals, and bounded leading prose, plus the full report path and ledger revision.
The configured `perTaskOutputCap` is an additional absolute output backstop.

The parent should use the ledger for cross-child state, the report for detail, and the registry for session identity and reuse diagnostics.
It should not infer validation or review approval from a child process merely settling successfully.
The next role receives the current task, stable acceptance criteria, findings, validation references, and explicit transition reason.
