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
- The optional S9 consumption of `read_batch` evidence refs and structured producer lookup outcomes is implemented below and uncommitted on top of head `dec0dc08`.

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

### Remaining S4 work

- [ ] Measure unresolved or abandoned tasks in a representative default-policy window.
- [ ] Measure regressions discovered after a reviewer reports `PASS`.
- [ ] Measure escalation rate and direction by orchestration tier.
- [ ] Measure Tier 1 worker discovery failures when no scout is present.
- [ ] Record eligible-call denominators, compliant and violating paths, spawn outcomes, and completion outcomes for every decision-relevant rule.
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

## Invariants

- Treat `@ztc/bash-tools` 1.1.4 and `@ztc/codegraph-runner` 2.0.4 as the producer contracts.
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
