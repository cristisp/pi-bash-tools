# Subagent orchestration

This guide is read on demand rather than before every delegation. Trigger: a tier 2 or higher workflow, a parallel fan-out, or a remediation round.

## Composition policy

The boundary and tool description enforce the generated rules below.
`warn` reports violations, `enforce` refuses them, and `off` disables standard-role checks.

{{composition_rules}}

## S4 gate

S4 telemetry is emitted at composition boundaries and analyzed fail closed.
Use its artifacts for evidence only: `ENFORCE_CANDIDATE` never changes `compositionPolicy`; changing the default remains a manual release decision.

## Workflow classification

Classify the task before delegating, using the smallest workflow that preserves independence and safety. A multi-file task alone does not require a scout. Before the first delegation, record the tier and reason, behavior risk, architecture uncertainty, validation complexity, package/persistence/trust-boundary/public-API crossings, and whether current repository evidence is sufficient. Use **Low** for deterministic local work, known architecture, or one focused check; **Medium** for coordinated files/dependencies/checks; and **High** for release-sensitive behavior, unfamiliar architecture, shared APIs, or integration/security validation.

## Workflow tiers

### Tier 0 - Direct main-session work

Non-code, documentation-only, analysis-only, configuration-only, or negligible-risk mechanical work. No subagents are required.

### Tier 1 - Implementation with independent review

```text
worker(initial)
  -> reviewer(primary)
```

Localized, low-risk implementation with simple deterministic verification. No validator. The worker `verify` ref is the validation evidence.

### Tier 2 - Planned implementation

```text
planner(initial)
  -> worker(initial)
    -> reviewer(primary)
```

The affected code is known but the task requires careful sequencing, multiple acceptance criteria, or coordinated tests. Do not use a scout when current repository evidence is already sufficient. Add a validator only when validation complexity is Medium or High, or independence is required.

### Tier 3 - Full investigation and assurance

```text
scout(initial)
  -> planner(initial)
    -> worker(initial)
      -> validator(initial)
        -> reviewer(primary)
```

High-risk or high-uncertainty work: security-sensitive behavior, parsers, analyzers, sandboxing, shared APIs, cross-package changes, or a broad unknown impact radius.

Tier 3 keeps the validator. Pass `evidenceScope: "session"` on the validator delegation when the checks are security-sensitive, environment-sensitive, or release-critical: a `session` child cannot resolve sibling refs, so it must execute.

### Tier 4 - Focused independent review

A primary reviewer plus focused security or validation reviewers only when a specific specialist concern warrants it. Focused reviewers report only on their assigned scope and do not own the overall release decision.

## Validation ownership per tier

Plan validation as one composite `verify` ref plus one review owner.
The session that modifies files, or the session integrating a parallel fan-in, owns the final gate; consumers resolve refs rather than rerunning covered checks.
Use `evidenceScope: "session"` only when independent execution is required.
A resolved ref is evidence only when its lookup succeeded, and a failed, stale, or not-found lookup is `NOT_RUN` or otherwise unverified.
Verify refs (vr_) use the minimal `{ ref }` lookup; read refs (rr_) use the minimal `read_batch` lookup `{ ref }`.
Do not add optional `flowId` or `covers` fields unless the current producer schema is known to support them.
After one failed, stale, not-found, unauthorized, or unsupported-field lookup for a ref, record it as `NOT_RUN`, stop retries for that ref and path batch, and reacquire the required repository files once with a fresh bounded read request.
Reviewers inspect refs and the required `## Files Reviewed` contract; they do not execute project validation.

## Escalation triggers

Escalate to the parent and select a stronger workflow, rather than silently continuing with the original workflow, when:

- A worker discovers shared behavior outside the original scope.
- A required invariant remains ambiguous.
- Validation reveals a different failure family than expected.
- A reviewer finding affects a trust boundary or shared API.
- Remediation repeatedly fails or produces no new evidence.

## Canonical orchestration ledger

Every workflow uses one compact ledger. The main session creates it before the first delegation and passes it through handoffs.

```text
workflow_version: 1
task_id:
attempt:
workflow_tier:
workflow_mode:
review_mode:
delegation_status:
validation_verdict:
review_verdict:
session_strategy:
session_strategy_reason:
finding_scope:
acceptance_criteria:
scope:
out_of_scope:
evidence_refs:
invariants:
changed_files:
validation_refs:
validation_omitted:
evidence_recovery:
findings:
baseline_failures:
environment_blockers:
unresolved_questions:
tier1_discovery_failure:
transition_reason:
recommended_next_action:
budget:
```

Use explicit empty values such as `none`, `[]`, or `{}` instead of omitting fields.
Tier 1 workers without a scout set `tier1_discovery_failure` to `true` when they could not locate the relevant entry points within their discovery budget, and to `none` otherwise.
The main session assigns stable acceptance-criterion IDs such as `AC-001` and preserves them across every transition.
Reviewers assign stable finding IDs such as `F-001` when findings are created and preserve them across remediation attempts.

Keep these states independent:

```text
delegation_status = success | error | blocked | unknown
validation_verdict = PASS | FAIL | BLOCKED | NOT_RUN
review_verdict = PASS | FAIL | NOT_RUN
workflow_mode = initial | remediation
review_mode = primary | security | validation | remediation
finding_scope = localized | cross-cutting | ambiguous | security-sensitive
```

Record why a role was skipped and why the workflow transitioned. Never infer validation or review approval from delegation completion.

Use `initial` and `remediation` as workflow modes rather than creating separate remediation agent definitions. After a reviewer failure, use targeted remediation by default:

```text
worker(remediation)
  -> reviewer(remediation)
```

Add `validator(remediation)` only when the workflow already carries a validator or a finding questions the evidence itself. Use full remediation only when findings interact, the change is cross-cutting, the acceptance criteria are ambiguous, or the remediation expands beyond the originally reviewed scope, and then re-run the tier's own chain in `remediation` mode rather than restarting scout and planner for every narrow reviewer finding.

## Role budgets and compaction

Budgets are soft guidance for normal work and hard stop conditions when exceeded without a stated reason.
Each handoff reports compact usage in the ledger's `budget` field, such as `tool_calls/reads/validations/output`.

The limits below are the values the extension enforced when this file was generated, and the output limit counts report prose in tokens.

{{role_budgets}}

Workers also have a protected finalization reserve for the final edit boundary, affected-test query, final validation, and report. Once final validation starts, later implementation writes require a fresh remediation attempt.
If a limit is insufficient, stop, record the cause and remaining evidence gap, and request escalation rather than silently exceeding it.
Keep planner reports compact: use one or two bullets per required section, avoid source excerpts and repeated context, and stay within the configured report-output budget.
Rerun `/setup-subagents` after changing `roleBudgets` so this file keeps naming the enforced limits.

On context pressure or a compaction request, stop broad work and emit the current ledger plus a compact role handoff, or stop if that cannot be done safely, preserving task, criterion, and finding IDs, validation references, and verdict states.

## Role boundaries

### Scout

The scout performs read-only reconnaissance: relevant files and symbols, current behavior, callers, callees, tests, risks, unknowns, and a concise handoff for the planner.

### Planner

The planner converts the task and scout report into a plan stating the goal, non-goals, acceptance criteria, steps, tests, and validation commands, plus invariants, negative or unknown cases, regression coverage, and finding-specific validation when needed.
For behavior changes the plan must specify TDD or regression-first sequencing unless a justified exception applies.

### Worker

The worker implements the assigned plan. It may inspect files, edit files, run focused checks, and use the repository's available tools.

The worker must:

- Preserve unrelated user changes, avoid unrelated cleanup and refactoring, and follow repository formatting, linting, and testing instructions.
- Add or update directly related tests, and never edit tests merely to make them pass; follow the TDD or regression-first strategy in the plan.
- Report the `AC-###` statuses, changed files, checks attempted, test evidence, the evidence-recovery marker when a lookup failed, and the owner’s `verify` ref. State whether the cited evidence covers the final post-edit state. Leave the final approval decision to the reviewer.
- Under a parallel fan-out, report `validation_refs: none` and the composite check as `NOT_RUN` unless the worker integrates the fan-in and owns the gate.

### Validator

The validator runs approved final checks and remains read-only.
Runtime permissions restrict it to approved validation surfaces and prevent source or configuration mutation.
Resolve live refs first, execute only uncovered checks once, cite each ref, and use `evidenceScope: "session"` when independent execution is required.
The remainder is `node_build`, applicable `fallow_*` analyses, and project phases not exposed by `verify`.
Report one `PASS`, `FAIL`, or `BLOCKED` verdict and every unverified check; do not approve or reject the code.

```text
executed
reused
resolved
```

`executed` means this role ran the command.
`reused` means this role ran `verify` and the tool returned stored evidence for unchanged state.
`resolved` means this role called `verify` with `{ ref }` and executed nothing.

#### Validation references

Validation evidence is tool-issued and tied to a repository state and `covers` scope.
Consumers resolve refs instead of rerunning covered checks; resolving a ref is not a validation pass.
Use one minimal lookup attempt per ref; after a rejected or stale lookup, mark the check `NOT_RUN`, stop retrying, and reacquire only the required source evidence.
Report freshness as `executed`, `reused`, or `resolved`.
A resolved ref is evidence only when its lookup succeeded, and a failed, stale, or not-found lookup is `NOT_RUN` or otherwise unverified.
Refs minted in a delegation flow resolve for its siblings and travel upward through `validation_refs`; the root session shares the flow id, so refs it mints resolve from children the same way.
Use a compact `V-###` fingerprint only when the project has no composite `verify` gate.
Reuse evidence only when the command, scope, and repository state are unchanged.
A matching reference is evidence reuse, not code approval.

#### Parallel fan-out and validation

One session owns the composite gate for the combined state, normally the integrator after fan-in.
Siblings run focused read-only checks or none, do not run the composite gate, and do not run write-capable checks concurrently.
Declare disjoint files, isolate shared mutable state when needed, and report sibling edits as contention before rechecking after fan-in.
Use separate worktrees when every sibling needs independent full evidence.

For each check, distinguish these classifications:

```text
PASS
FAIL
BLOCKED
BASELINE_FAILURE
NOT_RUN
```

Do not turn `BLOCKED` or `BASELINE_FAILURE` into a pass; pass those results to the reviewer with their evidence.

### Reviewer

The reviewer audits implementation, tests, acceptance criteria, and validation evidence without executing project checks.
The primary reviewer reviews the complete change and owns the overall release decision; focused reviewers report only on their assigned scope.
Treat removed, skipped, weakened, broadened, or rewritten assertions as findings unless the worker explains why the prior test was wrong or the contract intentionally changed.
Validator output is execution evidence, not semantic approval, and a required check without live evidence is a finding.

## Worker modes

Use the existing `worker` agent with an explicit workflow mode.

Use `initial` when implementing a new task from a user request and planner report: only the assigned scope, every acceptance criterion addressed, focused checks where useful, and failures, blockers, and unverified work reported.

Use `remediation` after a reviewer returns `FAIL`, against the structured finding ledger with stable finding IDs. The worker must address every supplied finding ID and report its status, inspect directly affected neighboring behavior, add or update the required regression tests, preserve unrelated user changes, avoid expanding the remediation scope without explaining why, and never silently omit, merge, or close a finding. It must not mark a finding `DEFERRED` or `ACCEPTED_RISK` without explicit direction from the main session or user.

## Subagent session discovery and reuse

Never infer, increment, or guess a subagent session label. Labels are scoped per herdr workspace and to the current Pi session, and only the bare value shown after `reuseLabel:` is reusable: not a qualified `workspace:label` value, and not the next numeric suffix after a failed lookup.

Call `subagent` with `listSubagents: true`. Copy the bare label from the active workspace and current Pi session, and check it with `subagent_stats` before reusing it. The main session owns the reuse decision, prefers a fresh session for planning, scouting, review, validation, security, audit, or any work needing independence, and starts fresh when context is above 100k tokens, the session exceeds 8 turns, or reuse is repeated. Record `session_strategy` as `fresh`, `reuse`, or `not_applicable`, with the decision in `session_strategy_reason` and `transition_reason`.

## What each task must carry

The main session passes compact structured context between agents, never a full conversation transcript. Every task carries the original task, the acceptance criteria with stable `AC-###` IDs, the existing user-change constraints, the current orchestration ledger, and its mode: `Workflow mode: initial` or `Workflow mode: remediation` for a worker, and `Review mode: primary`, `security`, or `validation` for a reviewer.

In addition:

- The planner task carries the scout report.
- The worker task carries the planner report.
- The validator task carries:
  - Changed files
  - Planner validation section
  - Worker completion report
  - Worker `verify` refs with their verdicts, `covers` lists, and repository state
  - Required `AC-###` and `F-###` ids
  - The evidence scope in force
  - Applicable project test rules
- The primary reviewer task carries the review scope, out-of-scope areas, planner report, worker completion report, and validator report, and a focused reviewer task narrows the same shape to its assigned scope and prior findings.

## Remediation workflow

When the primary reviewer returns `FAIL`, convert each blocking finding into a stable finding ID carrying the fields the reviewer finding format defines.

The finding scope and regression requirements select the workflow: targeted remediation is the default and full remediation applies only under the condition named with the ledger. The remediation scout investigates only the listed findings and directly affected behavior.

When a remediation carries a validator, it resolves the worker refs for every finding ID first and runs the checks no live ref covers, expanding only when the remediation changes shared or cross-cutting behavior. The remediation reviewer verifies every finding ID and checks neighboring behavior affected by the fix, and must not repeat an unrelated full review.

The remediation worker reports every finding ID using one of:

```text
FIXED
OPEN
BLOCKED
NOT_REPRODUCIBLE
```

Every remediation attempt increments the attempt count and records what changed, which new test or evidence addresses each finding, the hypothesis for any retry, new validation references, and the current finding status. Stop when the request, command, patch, or evidence is unchanged, or after two unsuccessful reviews of the same finding family, and then mark the findings `OPEN` and escalate, because the finding scope changed, evidence stopped improving, or resolution needs user risk acceptance.

After remediation review, the reviewer classifies each finding as one of:

```text
VERIFIED
OPEN
REGRESSED
DEFERRED
ACCEPTED_RISK
NOT_REPRODUCIBLE
```

Non-verified terminal states require an explanation.

## Reviewer scope and verdict

Focused reviewers may return `PASS` or `FAIL` for their assigned scope only, and their `PASS` does not approve the complete change; the primary reviewer must receive their reports before issuing the overall verdict.

The reviewer returns exactly one machine-readable `PASS` or `FAIL` verdict in a `## Verdict` section. `PASS` requires every in-scope acceptance criterion satisfied, no Critical or High finding, sufficient validation evidence, no release-critical check unverified, and remaining Medium or Low findings explicitly non-blocking; `FAIL` applies otherwise, including a violated fail-closed or security invariant.

## Handoff

Every handoff preserves the ledger block above in full, including required regression tests and compact budget usage.

Only the primary reviewer owns the final release decision.
