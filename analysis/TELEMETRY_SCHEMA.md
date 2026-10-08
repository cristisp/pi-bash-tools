# Subagent Herdr telemetry schema

Telemetry is written as one JSON object per boundary or delegation event.

Ordinary child turns produce one completed delegation record.
Composition boundary records are emitted at the boundary before child execution or refusal completes.
Ordinary child records may carry an additive `compositionObservations` summary counting which composition rules had eligible candidates and how many of those held.

The top-level `v` field is `1`.

`flowId` identifies the orchestration flow when flow persistence is enabled.

`delegationId` identifies one logical delegation and remains stable across reuse turns.

`taskId`, `tier`, `workflowMode`, and `reviewMode` preserve the orchestration identity supplied by the parent.

`workspace`, `label`, `agent`, and `role` identify the child execution.

`parentSession` is the immediate parent session when known.

`rootSession` is the explicit root Pi session attribution and is preferred for root-level aggregation.

`parentPaneId` is the pane that directly launched the child.

`reused` and `reuseCount` describe whether this turn reused an existing child session.

`outcome` is `settled`, `failed`, or `aborted`.

`usage` contains provider-reported input, output, cache, cost, context, and turn totals.

`metrics` contains extension-measured duration, tool calls, failed tool calls, repeated reads, manifest-protected rereads, discovery calls, validation passes, output tokens, message counts, and interaction wait time.

`metrics.validationRefs` records successful validation evidence references in call order.
Each ref records whether it was a lookup or a minted/reused result, repository state, `repositoryStateStatus`, omitted phases, and producer execution fields such as `stateDrift`, `concurrentExecutions`, `mutating`, and `forced` when returned.
When the producer returned a structured lookup classification it is recorded as `lookupOutcome` (`success`, `not-found`, `unauthorized-flow`, or `corrupt`); a ref-only verify call that reports reused evidence is recorded with the implicit outcome `success`.

`metrics.lookupFailures` records failed `verify` and `read_batch` ref lookups separately from successful zero-reuse flows.
Each entry carries the attempted ref when available, an error class of `denied`, `timeout`, `not-found`, or `unknown`, and `lookupOutcome` when the producer supplied the structured classification.

`metrics.readRefs` records `read_batch` evidence references minted or confirmed in the turn.
Each entry carries the `rr_` ref, whether the entry reused unchanged evidence (`reused`), whether it came from a ref lookup (`lookup`), the minting publication outcome (`publication` of `published`, `unpublished`, or `failed`, with `publicationReason`), and the producer flow id when provenance is unambiguous.
Read refs are session-scoped unless the minting call published them to the flow, so only `publication: "published"` refs are advertised to siblings in `knownRefs`.

`metrics.codegraphIndex` records codegraph producer index states observed in the turn: the number of results that carried a `producerState` block and the distinct `indexId` values, capped at 24 results and 8 ids.

`metrics.validationExecutions` records execution-level producer fields even when an execution did not return a reusable ref.

`budget` contains the role limits, observed usage, breach records, enforcement outcome, whether automatic steering entered report-only mode, and `registryPersists`, the number of registry writes made for this delegation turn. `repositoryWriteLockRefusals` counts tool calls refused because a sibling held the repository write lock.

`report` contains full-report token size, delivered digest token size, truncation status, ledger parsing status, the persisted report path, and reviewer inspection metadata.
`filesReviewedPresent` and `filesReviewed` expose the mandatory reviewer `## Files Reviewed` section; `contractIssues` exposes missing report requirements.

`ledgerRevision` and `ledgerInjection` identify the flow-ledger revision and the route used to provide its pointer to the child.

`scope` records the assigned paths, hunks, and explicit out-of-scope areas.

`reviewSurfacePath` identifies the one flow-level status, diff-stat, and hunk-header snapshot shared by fan-out children.

`reviewSurfaceRevision` is the monotonically increasing snapshot revision, and `reviewSurfaceRefreshed` says whether this launch rewrote it.

`dirtyPaths` is the bounded path list captured from the snapshot's working-tree status and passed to the child through its prompt and read manifest.

`readManifest` records the child-visible artifact paths, allowed paths, prior reports, established evidence, do-not-reread paths, and its persisted flow artifact reference.

Composition boundary events use `event: "composition"` and carry exactly one `compositionVerdict` object with the rule, action (`warn` or `refuse`), effective policy, mode, role/agent, tier, scope, reason, and compliant alternative. `compositionBoundaryStatus` repeats the action as `warning` or `refusal` for consumers that do not inspect the verdict; these are boundary statuses, not child outcomes. `compositionPolicyOverride` is present when a per-call override selected the effective policy, and `compositionBoundaryId` groups multiple rule events from one subagent boundary. These records have zero execution metrics and are excluded from ordinary delegation, validation, child-count, and spend aggregates by `analysis/measure.ts`; use the analyzer's `composition` result for event counts by rule, policy, and override.

## Composition observation summary

Every ordinary delegation record in an evaluated composition boundary may carry `compositionObservations`, a per-rule summary over the rules that had real eligible candidates.
Each rule entry records `eligible`, `compliant`, and `noncompliant` counts; the eligibility violation rate is `noncompliant / eligible` and the compliance rate is `compliant / eligible`.
R2 is eligible only for a real parallel fan-out with more than one reviewer; synthetic overlapping-scope probes do not count as R2 evidence.
Rules without a real eligible candidate are omitted from the summary, so rule presence means the rule was eligible at this boundary.

Analyzer guidance:

- Group by `rootSession` for root-owned activity.
- Group by `flowId` for one orchestration flow.
- Group by `delegationId` before comparing fresh and reused turns.
- Use `metrics` for extension-measured behavior and `usage` for provider-reported token accounting.
- Treat missing optional attribution as unknown rather than assigning a root from the child session file.
- Treat `budget.breaches` as evidence of enforcement, not as a replacement for `outcome`.
- Compare `reviewSurfacePath` within a `flowId` to verify that siblings share one review acquisition.
- Use `readManifest.persistedPath` to inspect the manifest after temporary prompt files have been removed.
- Treat `metrics.manifestRereads` as a warning signal for subsequent reads of manifest-protected paths and inspect the corresponding evidence gap before reusing the session.
- Read `metrics.validationRefs` for the tool-issued validation refs a child minted or resolved. `lookup: true` means the child resolved existing evidence instead of running the gate, and a ref only resolves inside the flow that minted it. `head`, `stateDigest`, and `repositoryStateStatus` record the repository state the evidence was minted against and the producer's freshness comparison; refs inside one flow that carry different digests are evidence that crossed a repository state, and `verify:N ran:M unresolved:K` in the spend line counts attempts, executions, and unresolved lookups.
- Read `metrics.lookupFailures` separately from `validationRefs`: a failed lookup is not a zero-reuse flow and never supplies a passing verdict.
- Read `metrics.readRefs` and `metrics.codegraphIndex` for the `read_batch` and codegraph evidence a child touched. `readRefs` covers minted, reused, and lookup-confirmed `rr_` refs with their publication outcome; `codegraphIndex` reports how many results carried a producer index-state block and how many distinct indexes served them.
- Use the analyzer's producer invocation stream when available to join one aggregate record per `verify` call with extension telemetry; do not infer producer invocations from extension records when the stream is absent.
