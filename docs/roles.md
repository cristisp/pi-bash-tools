# Roles and handoffs

## Role boundaries

The standard files installed by `/setup-subagents` define these responsibilities:

- **Scout:** Read-only reconnaissance of files, symbols, callers, callees, tests, risks, and unknowns.
- **Planner:** Read-only implementation plan with acceptance criteria, exact files, tests, validation, invariants, and blockers.
- **Worker:** Implements the assigned change, updates directly related tests, and reports the checks it attempted.
- **Validator:** Runs approved checks, resolves existing evidence first, and reports objective results without editing the repository.
- **Reviewer:** Audits the implementation, tests, acceptance criteria, and evidence without executing project checks.

The primary reviewer is the only role that owns the overall release decision.
Focused security or validation reviewers decide only within their assigned scope.
A validator's `PASS` is execution evidence, not semantic approval.

## The orchestration ledger

The ledger is the compact state handoff for a flow.
The delegating session writes it at dispatch and result boundaries.
Children read it but cannot write it.

The required fields are:

```text
workflow_version
task_id
attempt
workflow_tier
workflow_mode
review_mode
delegation_status
validation_verdict
review_verdict
session_strategy
session_strategy_reason
finding_scope
acceptance_criteria
scope
out_of_scope
evidence_refs
invariants
changed_files
validation_refs
validation_omitted
findings
baseline_failures
environment_blockers
unresolved_questions
transition_reason
recommended_next_action
budget
```

Use explicit `none`, `[]`, or `{}` values.
Keep delegation, validation, and review states independent.
A successful child process is not automatically a successful validation or review.
Use stable `AC-###` ids for acceptance criteria and `F-###` ids for reviewer findings.
Preserve those ids through remediation.

The child response must include a fenced machine-readable ledger block.
The extension folds selected status, evidence, finding, changed-file, and budget fields into the flow ledger.
Full prose remains in the role report rather than expanding the shared ledger.

## Handoff requirements

Every role should pass the smallest complete context to the next role:

- The original task and stable acceptance criteria.
- The workflow tier, mode, review mode, scope, and out-of-scope areas.
- The current ledger pointer and any transition reason.
- Changed files and relevant tests.
- Validation references with their covered criteria and freshness.
- Baseline failures, environment blockers, unresolved questions, and remaining evidence gaps.

The planner receives scout findings when a scout was used.
The worker receives the plan and must not silently broaden it.
The validator receives changed files, the validation plan, worker report, and every worker reference.
The reviewer receives the implementation, tests, worker and validator reports, review scope, and evidence references.

## Validation states

Use these classifications instead of collapsing uncertainty into success:

- `PASS`: The check or criterion was established.
- `FAIL`: The check or criterion failed.
- `BLOCKED`: The check could not proceed because of an approval, environment, or contention problem.
- `BASELINE_FAILURE`: A known pre-existing failure was observed.
- `NOT_RUN`: No valid evidence established the check.

The reviewer must return exactly one `PASS` or `FAIL` in its `## Verdict` section.
The validator must return exactly one `PASS`, `FAIL`, or `BLOCKED` validation verdict.

## Remediation

A reviewer turns each blocking issue into a stable finding with severity, location, evidence, impact, required fix, regression test, validation requirement, and scope.
A remediation worker reports every finding as `FIXED`, `OPEN`, `BLOCKED`, or `NOT_REPRODUCIBLE`.
A remediation reviewer reports terminal states such as `VERIFIED`, `OPEN`, `REGRESSED`, `DEFERRED`, `ACCEPTED_RISK`, or `NOT_REPRODUCIBLE`, with an explanation for any non-verified state.

Use `workflowMode: "remediation"` rather than creating a new agent definition.
Use targeted remediation by default.
Use full remediation only when findings interact, scope expands, criteria are ambiguous, or the change is cross-cutting.
Do not merge, renumber, silently omit, or close findings without evidence or explicit direction.
