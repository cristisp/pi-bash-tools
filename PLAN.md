# Plan: subagent-herdr

This file tracks only unfinished work and the decisions needed for future work.
Completed implementation history, review rounds, and superseded plans remain available in Git history and the analysis artifacts.

## Current status

- S1 registry write-path optimization is complete.
- S3 review-surface invalidation is complete.
- S4 composition checks are implemented and the configured policy remains `warn`.
- S5 evidence-reuse instrumentation and the `@ztc/bash-tools` 1.0.2 handoff are complete.
- S2 repository-lock deletion is not authorized and the lock remains enabled.
- S7 identity-path consolidation remains deferred.
- The S8 producer artifact-alignment analysis is complete and all seven consumption items are implemented below.
- The S8 implementation is committed as `align producer evidence contract ...` (1.8.0).
- The optional S9 consumption of `read_batch` evidence refs and structured producer lookup outcomes is implemented and committed on top of head `dec0dc08`.
- The T-014 blocked-subagent notification flow is implemented and uncommitted on top of the S9 measurement-semantics fixes.
- The S10 spawn-boundary item is implemented and review-clean (reviewer-47 remediation pass): subagent spawns whose cwd resolves outside the root session folder are refused before launch, including the reuse pane-recreation path; it shares the same uncommitted tree.
- The current uncommitted tree carries four workstreams: S4 measurement-semantics fixes, T-014 blocked-subagent reporting, the spawn boundary, and S11 evidence-reacquisition and Tier 2 finalization hardening.
- S11 implementation is present in the uncommitted tree. The current `@ztc/bash-tools` 1.1.7 source confirms the `{ ref }` lookup contract and flow publication schema; its fresh-process runtime completion gate remains open.

## S4: decide whether `warn` can become `enforce`

The standard `subagent` tool uses the configured policy.
Deliberate per-call policy changes use `subagent_override` and remain separately visible in telemetry.
The current configured value is `compositionPolicy: "warn"`.

### Current evidence

The clean default-policy window is flow `fcb7b5447b11b875a` with cutoff `1788908340848`.
It contains four delegations, two composition warnings, zero refusals, and no per-call overrides.
The observed warnings are R1 and R4.
R3 used the compliant `evidenceScope: "session"` path and therefore produced no warning.
R2 was not rerun because its overlapping-scope safety boundary is already confirmed.

This window closes the default-versus-override provenance gap, but it is too small and incomplete to authorize `enforce`.
The independent rollout review recommends retaining `warn`.

### First full gate run (2026-09)

The first `s4:gate` run over the accumulated window returned `INSUFFICIENT_EVIDENCE` with 192 preflights, 251 outcomes, and 29 boundary rejections.
Three measurement-semantics defects were found and fixed:

1. `unresolvedOrAbandoned` read reviewer `findings` and `baseline_failures` as blocking signals, inflating the rate to 97.7%.
   Blocking now covers only `environment_blockers`, `unresolved_questions`, and `validation_omitted`, with tolerant none/no parsing.
2. Rejected outcomes were reported under one generic correlation message; the analyzer now names the specific defect for every rejection.
   The delegation context also carries `compositionBoundaryId` so the outer record and the nested correlation always agree.
3. Tier 1 discovery failure defaulted to failure whenever the ledger signal was absent; the guardrail now counts only explicit `true` values and reports unknown otherwise.
   The orchestration-guide ledger adds `tier1_discovery_failure` so tier 1 workers report the signal.

The run also produced real findings: R4 was violated by 32 of 35 eligible calls, and regression after review pass measured 9 of 58.
Both argue for retaining `warn`.

### Remaining S4 work

- [ ] Accumulate a fresh default-policy window of at least 7 days with the corrected signals and no deliberate overrides.
- [ ] Measure unresolved or abandoned tasks in a representative default-policy window.
- [ ] Measure regressions discovered after a reviewer reports `PASS`.
- [ ] Measure escalation rate and direction by orchestration tier.
- [ ] Measure Tier 1 worker discovery failures when no scout is present.
- [ ] Record eligible-call denominators, compliant and violating paths, spawn outcomes, and completion outcomes for every decision-relevant rule.
- [ ] Decide the R1 and R2 denominator policy: per-rule minimums or documented alternative evidence, since R2 rarely has a real eligible candidate in ordinary usage.
- [ ] Reconsider `enforce` only after the quality guardrails and representative rule measurements support it.

An unobserved guardrail is an evidence gap, not a zero rate.
Do not treat zero refusals under `warn` as evidence that `enforce` would produce no harmful refusals.
Do not rerun the overlapping R2 probe unless a future product requirement changes its scope.

### S4 decision gate

Move the configured policy to `enforce` only when all of the following are documented:

1. Default-policy events are distinguishable from deliberate overrides.
2. Each decision-relevant rule has a meaningful eligible-call denominator.
3. The four quality guardrails have measured results over a representative window.
4. The independent rollout review finds no release-blocking evidence gap.
5. A fresh validation run passes after any configuration or documentation change.

Otherwise, retain `warn` and record the specific missing evidence.

## S2: retain the repository write lock

The repository write lock remains the authority for writer-versus-reader coordination.
The producer's single-flight implementation is process-local and does not coordinate separate Pi or child-session processes.
Flow publication shares completed evidence but does not serialize active executions.

The deletion gate requires a complete later measurement window with both:

- zero repository-lock contention refusals; and
- zero producer executions flagged with `stateDrift`.

The current evidence does not satisfy that gate.
Keep the lock frozen and do not spend engineering time on it unless telemetry shows a wedge or another writer class appears.
Delete it only after the deletion gate passes and an independent review confirms the result.

## S7: deferred identity-path consolidation

Revisit S7 only if S1 telemetry shows that orchestration identity writes remain a material delegation cost.
If that happens, evaluate a single per-delegation identity artifact referenced by the registry, telemetry, flow manifest, ledger, and report metadata.
Do not consolidate the stores merely for aesthetic consistency.

## S8: consume the shared producer artifact alignment

`@ztc/bash-tools` and `codegraph-runner` now store tool-call artifacts against the same contract.
Both accept `publish: { flowId }` with `covers`, authorize through `PI_ORCHESTRATION_FLOW`, and describe evidence in a producer-neutral envelope with a shared `workspace` block (`repositoryId`, `head`, `dirtyDigest`, `status`).
Physical bounds match: 2 MiB per record, 50 MiB per scope, seven-day retention, atomic writes with validate-on-read.
Only `head` equality is authoritative for cross-producer comparison; `repositoryId`, `dirtyDigest`, and any degraded status make a comparison unknown.
The orchestration layer needs consumption work, not structural change.

### S8 work items

- [x] Read the shared `workspace` block as the primary freshness input in `src/metrics.ts` validation-field extraction, keeping the producer detail fields and snake_case aliases as fallback.
- [x] Carry known flow refs with verdict and freshness in the read manifest instead of prior-report prose, so later roles resolve evidence through lookups instead of rereading report files.
- [x] Normalize the two publication vocabularies (`published` plus `error` in bash-tools, `state` plus `reason` in codegraph-runner) in one helper before surfacing publication outcomes in digests, reports, or telemetry.
- [x] State the stale-ref rule once in role templates, `docs/evidence.md`, and `orchestration-guide.md`: a resolved ref is evidence only when its lookup succeeded, and a failed, stale, or not-found lookup is `NOT_RUN`.
- [x] Document in `docs/artifacts.md` that codegraph-runner flow publication uses the same `PI_ORCHESTRATION_FLOW` environment variable and produces `cg_` references resolvable by `codegraph_artifact` from flow siblings.
- [x] Record the git head alongside the review-surface fingerprint so reports can compare against a published evidence `workspace.head` without recomputing state.
- [x] Decide whether the root session should publish its own evidence into the derived flow.
Implemented: the root process now sets `PI_ORCHESTRATION_FLOW` from its own session at startup, so root-minted refs resolve from children the same way sibling refs do, and the fan-in validator can resolve the integrating session's gate instead of re-running it.
Accepted trade-off: the root is not a delegation and can publish evidence outside any orchestration context; consumers still confirm every ref by lookup, and the value of the change is revisited after real usage.

### S8 boundaries

Do not enumerate or read producer flow directories from this repository.
Refs are the only sanctioned transport, and codegraph-runner scope directories are hash-addressed by design.
Keep the repository write lock and the review-surface dirty-path computation: the envelope carries digests, never path lists.
Keep refs opaque and non-replayable in the orchestration layer; it transports evidence and never resolves or reinterprets it.

## S9: consume read_batch evidence refs and structured producer lookup outcomes

The producer contract already carries everything needed, so both items stay inside this repository.
Item A turns cross-turn `read_batch` reuse into first-class evidence: the producer stamps every read-batch result with an `rr_` ref and a `contentHash`, deduplicates unchanged items, and resolves refs through a `read_batch` ref lookup.
Item B stops discarding the structured `lookup.outcome` classification and the codegraph `producerState` index id that the producers already return.

### S9 work items

- [x] Capture `read_batch` evidence refs in `src/metrics.ts` execution metrics: minted vs unchanged reuse, ref-lookup confirmations, publication outcome, and producer flow provenance, capped per turn.
- [x] Record structured producer lookup outcomes (`success`, `not-found`, `unauthorized-flow`, `corrupt`) on validation refs and lookup failures, including the implicit `success` outcome of a verify ref-only call that reports reused evidence.
- [x] Capture codegraph `producerState` index ids from tool results as a bounded per-turn index-state record.
- [x] Project published `rr_` read refs into the flow's manifest `knownRefs` as `kind: "read"` hints next to the existing `vr_` verify refs, dropping unpublished or provenance-ambiguous read refs.
- [x] Make the manifest guidance kind-aware: verify refs resolve through a verify ref lookup, read refs through a `read_batch` ref lookup.
- [x] Aggregate the new signals in `analysis/measure.ts`: read refs minted, reused, and resolved by lookup, the lookup-outcome distribution, and codegraph index results and distinct index ids, rendered per role, flow, and overall.
- [x] Document the new telemetry fields, the manifest read-ref kind, and the read-batch publication surface in `analysis/TELEMETRY_SCHEMA.md`, `analysis/MEASUREMENT.md`, `docs/artifacts.md`, and `docs/evidence.md`.

### S9 boundaries

Unchanged from S8: refs stay opaque, this repository never enumerates producer stores, and a read ref is advertised only when its minting call published it to the flow because `read_batch` refs are session-scoped otherwise.
The analyzer reads the same telemetry plus the producer invocation stream, and the producer lookup-outcome field on stream records is classification only.
Codegraph index ids are observations of producer index state, not freshness verdicts; index identity alone does not validate evidence.

## S10: report blocked-subagent status through bash-tools ui prompts

Children blocked on a bash-tools approval dialog previously looked idle, so the parent never knew a dialog was open.
T-014 closes that gap with a child-side marker writer plus a parent-side tail detection, implemented by delegated workers directly in this repository; bash-tools needed no changes.

### T-014 work items

- [x] Child-side marker writer (`src/ui-prompt-marker.ts`) and herdr metadata reporter (`src/ui-prompt-report.ts`), registered for children only in `index.ts`, with marker format version 1 and bounded title/summary fields.
- [x] Parent-side detection in `src/poll.ts`: the session tail reader recognizes markers, the blocked machinery runs on daemon blocked state OR an open marker, a lost end marker is treated as lost after `uiPromptLostIdleMs` (new config key, default 30000), and settle is suppressed while a dialog is open.
- [x] Status surface: `statusTag` in `src/format.ts` shows the blocked state from block fields.
- [x] Tests for markers, reporting, poll detection, formatting, config, and registration.
- [x] Child-side `herdr:blocked` event emission (`{ active: true, label }` on prompt open, `{ active: false }` on close), mirroring arx's transport so the herdr daemon can flip the child tab to blocked in real time; the parent-side poll chain stays as the notification and telemetry path.

### T-014 next steps

- [x] Restrict subagent spawning to the main session's root folder: configure the `subagent` tool so delegations whose cwd resolves outside the root session directory tree are refused before any child is launched, and document the boundary.
Implemented: `src/spawn-boundary.ts` canonicalizes the root session cwd and every requested cwd (single, parallel, chain) through `realpath`, tolerating not-yet-existing targets, and `executeSubagent` refuses with a clear "Spawn boundary refusal" result (resolved path, root folder, no child launched) before composition evaluation. Subfolders inside the root are allowed; `reuse` keeps the existing tab cwd, and `ensurePaneExists` refuses to recreate a vanished pane whose registry entry records a cwd outside the root. Documented in README limitations, `docs/development.md`, and the tool schema cwd descriptions.
Review remediation (reviewer-47): added symlink-in-root and filesystem-root regression tests (`src/spawn-boundary.ts` now special-cases the `/` root), documented that relative cwd values resolve against the root session folder which the herdr CLI inherits, and closed the reuse pane-recreation bypass with a regression test in `run.test.ts`.

## S11: harden evidence reacquisition and Tier 2 finalization

The recent `indicatori` flow showed three distinct orchestration failures in `subagent-herdr`: planners spent their failure budget replaying unavailable `rr_...` refs, `worker-125` spent its repeated-read budget retrying the same seven paths after a tool-schema rejection, and `worker-126` exhausted its shared tool-call budget after the implementation but before final-state validation.

This workstream keeps producer ownership in `@ztc/bash-tools` and changes only the orchestration contract, child guidance, manifest projection, and role-budget behavior in this repository.
The current `src/manifest.ts` publication filter is an intended safety boundary and must not be weakened.
If a published ref is still unresolvable from a fresh child after these changes, record a separate producer-contract or integration defect rather than advertising the ref more broadly.

Current implementation status: the herdr-side focused and full package verification gates pass, including fresh-process manifest coverage. The current `@ztc/bash-tools` 1.1.7 source and tests confirm the minimal `{ ref }` lookup and flow publication contract; an independent fresh-process parent/child probe is still required before S11 can be marked complete.

### S11 acceptance criteria

- **S11-001:** A fresh child never receives an unpublished, process-scoped, provenance-ambiguous, or cross-flow `rr_...` ref as a reusable manifest hint.
- **S11-002:** The default child guidance uses the smallest canonical `read_batch` lookup request and does not require optional `flowId` or `covers` fields that may be absent from an older producer runtime.
- **S11-003:** A stale or rejected ref lookup leads to one bounded recovery path: mark the lookup `NOT_RUN`, reacquire the required repository files, and do not fan out repeated lookups for the same ref or path batch.
- **S11-004:** Tier 2 workers retain a protected finalization path for the final edit, affected-test query, final validation, and report, or are explicitly stopped before validation when a remediation requires a fresh attempt.
- **S11-005:** Planner report requirements fit the configured report-output budget, and report-budget breaches do not silently invalidate otherwise complete evidence.
- **S11-006:** Regression tests cover the manifest, guidance, retry, phase-budget, and report-budget behavior without reading producer flow stores from this repository.

### S11 scope and ownership

In scope:

- `src/manifest.ts` and `src/metrics.ts` for read-ref provenance and stale-ref projection.
- `src/templates.ts` and `src/orchestration-guide.md` for bounded ref recovery and minimal lookup guidance.
- `src/budget.ts`, `src/config.ts`, and `src/types.ts` for phase-aware worker budgets and report limits.
- `src/report.ts` if the report contract must be shortened or made budget-aware.
- Relevant tests under `test/`, plus `PLAN.md` and focused evidence documentation if the contract changes.

Out of scope:

- `@ztc/bash-tools` producer implementation, evidence stores, and tool schema implementation.
- Direct reads of producer flow directories or producer-owned caches.
- Changes to `indicatori` source code.
- Removing budget enforcement or treating failed lookups as valid evidence.
- Manually editing installed agent copies; change source templates and regenerate them through the normal setup path.

### S11 implementation sequence

1. Reproduce the observed boundary with current source and a fresh child process.
   Confirm whether the stale refs are being admitted by `knownRefsFor`, incorrectly marked `published` by producer metadata, or coming from a manifest generated by an older build.
2. Preserve and strengthen the manifest invariant.
   Keep the `publication === "published"`, flow-provenance, and ambiguity checks for read refs.
   Add an explicit test that a published-looking ref with no resolvable flow provenance is excluded.
   Do not add a fallback that enumerates or reads producer stores.
3. Change the child guidance to use a minimal lookup first.
   A read ref should be confirmed with `{ ref }` in the current effective flow.
   Optional `flowId` and `covers` fields may be used only when the runtime contract is known to support them.
   After one `not-found`, stale, unauthorized, or unsupported-field response, stop lookup fan-out and reacquire source evidence with a fresh `read_batch` path request.
4. Add a bounded stale-ref recovery marker to the role report and ledger contribution.
   Distinguish `NOT_RUN` caused by an unavailable ref from a source read that was never attempted.
   Preserve the existing rule that a failed lookup is not evidence.
5. Design and implement a worker budget phase model.
   Discovery and implementation must not consume the finalization reserve.
   Once a worker begins final validation, later implementation writes must either be refused or require a fresh remediation attempt with a new budget.
   The reserve must cover the final edit, `codegraph_affected`, affected tests, final lint/typecheck or project verification, and the report.
   Keep the current failed-call and repeated-read protections, but make their limits and the finalization reserve visible in the role guidance and report.
6. Reconcile planner report size with the budget.
   Prefer a compact mandatory report contract with bounded sections and machine-readable fields.
   If the required content cannot fit, raise the planner report-output allowance and add a regression test against the rendered contract rather than relying on approximate token estimates.
7. Add telemetry for phase transitions and budget causes.
   A report should state whether the stop was caused by discovery, repeated reads, failed calls, ordinary tool calls, report output, or finalization reserve.
   Record whether validation evidence applies to the final post-edit state.
8. Validate the implementation with focused tests, then run the repository verification suite.
   If the current producer still reports a published ref that a fresh child cannot resolve, stop the herdr workstream at the boundary and open a linked `bash-tools` integration issue.

### S11 test matrix

- `test/scope.test.ts`: exclude unpublished, cross-flow, ambiguous, and process-scoped read refs from `knownRefs`; retain only genuinely published flow refs.
- `test/metrics.test.ts`: preserve publication and flow-provenance distinctions for successful, failed, unauthorized, and missing read evidence.
- `test/templates.test.ts`: require minimal ref lookup guidance, one bounded recovery attempt, and no instruction to fan out stale-ref confirmations.
- `test/budget.test.ts`: cover repeated-read charging, multiple failed calls in one assistant turn, discovery-to-implementation gating, finalization reserve protection, post-validation write refusal or remediation reset, and explicit breach causes.
- Report/config tests: verify that the planner report contract fits its configured output allowance and that worker reports identify validation as final-state or pre-final-edit evidence.
- Fresh-process integration coverage: publish a read ref in one process, resolve it from a sibling child, and confirm that an unpublished process-local ref is omitted or treated as `NOT_RUN`.

### S11 completion gate

Do not mark this workstream complete until all of the following are true:

1. Current-build parent and child sessions expose the same `read_batch` contract, or the child guidance works with the minimal `{ ref }` lookup.
2. No fresh child spends its initial discovery budget on a batch of unavailable refs.
3. A worker that edits after an initial validation cannot claim the earlier validation as final-state evidence.
4. A Tier 2 worker has a deterministic path to final tests and reporting after implementation.
5. Focused tests and the full repository verification suite pass.
6. The final diff contains no changes to producer-owned stores, installed agent copies, or unrelated application repositories.

## Invariants

- Treat `@ztc/bash-tools` 1.1.7 and `@ztc/codegraph-runner` 2.0.4 as the producer contracts.
- Treat the installed agent files and `~/.pi/agent/agents/subagent_orchestration.md` as generated artifacts of `/setup-subagents`; change only `src/templates.ts` and `src/orchestration-guide.md`, then regenerate - never edit installed copies by hand.
- Keep producer ownership boundaries intact; this repository does not write the producer's policy or store files.
- Treat evidence references as the only cross-extension transport; this repository never enumerates or reads producer flow stores.
- Treat cross-process single-flight as unavailable unless a separate durable-lease design is approved.
- Keep all measurement artifacts generated by the analyzer.
- Do not manually edit `analysis/MEASUREMENT.md`.
- Keep the repository write lock while the S2 deletion gate is unmet.
- Do not run more cross-process F7 probes.

## Measurement procedure

1. Use ordinary `subagent` calls for default-policy evidence.
2. Omit `compositionPolicy` from ordinary calls.
3. Use fresh isolated telemetry and producer streams for any new decision window.
4. Preserve the cutoff, flow identity, policy, override status, rule, tier, outcome, and guardrail counts in the decision record.
5. Regenerate `analysis/MEASUREMENT.md` with `MEASURE_CUTOFF=<epoch-ms> npm run test:analyze`.
6. Run the independent review against the generated artifact and the decision record.
7. Run format, lint, typecheck, and tests after the final change.

The existing clean S4 window is evidence for default-policy provenance, not a reason to create another synthetic probe.
Prefer ordinary future usage for the quality-guardrail measurements.

## Completed and out of scope

The following work is complete and should not be reopened in this plan:

- Registry persistence reduction, compact registry encoding, poll-side registry caching, and persistence telemetry.
- Review-surface fingerprinting, refresh revisions, dirty-path propagation, and associated tests.
- S4 boundary checks, typed composition telemetry, structural override opt-in, shared guidance, and regression coverage.
- S5 lookup failure reporting, flow-scoped evidence, freshness and repository-state telemetry, producer joining, and analyzer reporting.
- Producer F1-F7 and F9 work in `@ztc/bash-tools` 1.0.2.
- The F8 digest-boundary investigation and its corrected documentation.
- The R2 overlap safety boundary and the process-local S5 single-flight evidence.

Detailed implementation rationale and historical review findings are preserved in Git history, `analysis/MEASUREMENT.md`.
