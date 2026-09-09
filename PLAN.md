# Bash Tools Plan

## Status

The current release scope is implemented and documented under [`docs/docs.md`](docs/docs.md).

The active plan now focuses on reducing token and tool-call waste identified in [`research/research-initial.md`](research/research-initial.md) and refined by the version-aware [`research/findings-0909.md`](research/findings-0909.md), with Bash Tools limited to its own execution, evidence, filesystem, Git, validation, and observability responsibilities.

Historical extension-version recovery is complete, but the latest observed `1.0.2` cohort is too small to serve as a stable current-version baseline.

Orchestration policy and Codegraph implementation remain owned by their respective extensions.

Cross-extension work will use compatible evidence contracts rather than direct implementation dependencies.

## Goals

- Establish which historical inefficiencies still exist in the current Bash Tools version.
- Reduce repeated delivery of read-only workspace evidence across root and child sessions.
- Make discovery evidence interoperable with Codegraph without making Bash Tools responsible for Codegraph storage or freshness.
- Reduce oversized read, search, Git, and semantic-discovery results.
- Improve deterministic edit and request failure diagnostics so unchanged retries are clearly invalid.
- Preserve authorization, cache isolation, bounded output, fail-closed behavior, and compatibility contracts.

## Scope boundaries

Bash Tools may produce, publish, compare, and resolve evidence for operations it owns.

Codegraph must remain the producer and resolver of its own semantic and graph evidence.

Evidence references must not grant permissions, bypass producer authorization, or expose content across unrelated roots or flows.

Bash Tools will not add arbitrary shell execution, orchestration roles, fan-out policy, provider retry policy, model fallback, or child-session lifecycle behavior.

## Active work

### P0: Build a current-version efficiency baseline

The 30-day report combines sessions from multiple stages of tooling evolution.

Implementation decisions must use measurements segmented by the active extension and schema versions rather than aggregate historical totals.

The raw Pi session scan recovered 782 `bash-tools.tool-inventory` entries across 649 sessions after confirming that the historical SQLite importer had discarded top-level custom entries.

A single extension version can now be assigned to 641 sessions and 26,998 calls, covering 55.55% of sessions and 45.60% of calls in the historical window.

The latest observed `1.0.2` cohort contains only 40 unambiguous sessions and 142 calls, so its 4.23% observed error rate is provisional rather than a stable production estimate.

- [x] Recover raw Bash Tools inventory entries and join their `sessionId` values to imported sessions.
- [x] Extract historical extension versions, active-tool snapshots, and tool schema hashes without consulting current source files.
- [x] Report the historical version distribution and identify the latest observed cohort within the fixed analysis window.
- [x] Exclude missing-version and multiple-version sessions from version cohorts instead of assigning them by proximity.
- [ ] Attribute inventory tools by their recorded source so Bash Tools-owned, intercepted native, Codegraph, and unrelated extension tools are not conflated.
- [ ] Recompute error rates, duplicate requests, result volume, latency, cache decisions, and evidence reuse for each sufficiently covered version cohort.
- [x] Implement state-aware duplicate classification and report unknown state instead of labeling unsupported duplicates as waste.
- [ ] Improve repository-state coverage beyond the 201 historically attributable calls.
- [x] Separate invalid requests, policy outcomes, policy subsystem failures, resolution failures, command failures, timeouts, cancellations, test failures, and successful evidence lookups where historical data supports the distinction.
- [ ] Report tool-result rates both including and excluding expected authorization and fail-closed outcomes.
- [ ] Measure repeated `project_command` execution separately from `verify` execution, lookup, reuse, publication, forced execution, and cache ineligibility for each sufficiently covered cohort.
- [x] Include `read_batch` in read-like artifact analysis.
- [ ] Record aggregate and per-item result size for `read_batch`.
- [ ] Measure Git summary reuse, patch follow-up frequency, truncation, and repeated state observations.
- [x] Produce a provisional latest-observed-version baseline with explicit sample coverage and uncertainty.
- [ ] Accumulate enough current-version telemetry to identify which findings in the two research reports remain active.

#### Policy and authorization outcome analysis

The revised exclusive historical classification contains 912 policy or authorization-related results, representing approximately 18.03% of all recorded tool-result errors.

It separates 625 sandbox or filesystem-containment results, 120 approval-interaction timeouts, 71 non-interactive fail-closed denials, 69 policy-subsystem failures, 17 expected explicit authorization decisions, and 10 evidence-flow or scope failures.

These results remain relevant to workflow efficiency but must not be treated uniformly as tool implementation failures.

- [x] Verify that every result in the broad policy total is represented once and that exact-message classifications do not overlap normalized categories.
- [x] Separate explicit user or administrator denials from confirmation timeouts.
- [x] Separate expected fail-closed decisions from policy-load, policy-save, lock, unsafe-path, and other policy subsystem failures.
- [x] Classify missing authorized-flow references as evidence-routing outcomes rather than generic interactive policy denials.
- [ ] Distinguish wrong-flow, unpublished, missing, expired, unauthorized, and unreadable evidence where this can be done without leaking evidence existence.
- [ ] Preserve whether command execution was attempted for every authorization-related outcome.
- [ ] Segment policy outcomes by root or child session, interaction mode, tool, command ID, effective flow, and policy decision source.
- [ ] Measure whether an approval prompt, warning, or terminal notification was emitted and how long the request waited.
- [ ] Measure whether a timeout or denial was followed by an unchanged retry, later equivalent approval, alternate tool path, or abandoned workflow.
- [ ] Measure token cost, wall-clock delay, and downstream retries separately because approval waits may be latency-heavy without being token-heavy.
- [ ] Keep the remaining non-policy results divided into invalid requests, repository evidence failures, provider or execution failures, cancellations, implementation failures, and uncategorized outcomes rather than labeling them all as actual errors.

No measurement or implementation change may weaken explicit authorization, automatically approve a request, widen evidence scope, or change fail-closed behavior.

#### Discovery substitution analysis

Tool adoption alone is not a success metric.

The analysis must determine whether Codegraph replaces text-search and read work or merely precedes the same work.

The historical report now provides a bounded proximity baseline, but its 705 potential substitution signals cannot establish counterfactual replacement.

- [x] Establish historical Codegraph and text-evidence overlap, result-volume, and bounded proximity baselines.
- [ ] Compare discovery sequences that begin with Codegraph against sequences that begin with `grep`, `find`, or `read`.
- [ ] Measure calls, model-facing result bytes, estimated tokens, and elapsed time before the first relevant file and first mutation.
- [ ] Measure how often files or snippets returned by Codegraph are fetched again through `read`, `read_batch`, or `grep`.
- [ ] Measure unique files inspected before mutation and per accepted changed file.
- [ ] Measure repeated or overlapping graph context across children even when graph queries are not byte-identical.
- [ ] Measure whether `codegraph_affected` narrows validation scope and reduces validation execution.
- [ ] Track index freshness and workspace mutations when graph evidence is consumed.

#### Exit criteria

- Current-version metrics are available independently from historical aggregate metrics with enough coverage to support implementation decisions.
- Tool ownership is derived from recorded inventory source metadata rather than inferred from the custom-entry producer.
- Duplicate-work metrics include repository or artifact state at each invocation.
- Expected authorization decisions are reported separately from policy subsystem and tool execution failures.
- Policy wait time and repeated calls remain visible in efficiency metrics even when the fail-closed decision was correct.
- Codegraph value is expressed as downstream calls, bytes, latency, and successful-workflow outcomes avoided.
- Each implementation item below has measured current-version evidence or is explicitly classified as preventive correctness work.

### P0: Define a producer-neutral evidence contract

Bash Tools and Codegraph should expose compatible evidence metadata while retaining producer-owned storage and lookup.

- [ ] Define a minimal versioned evidence envelope shared by participating extensions.
- [ ] Include the evidence reference, producer, evidence kind, request hash, content hash, compact summary, bounded output metadata, and creation metadata.
- [ ] Include canonical repository identity, `HEAD`, dirty-state identity, and relevant artifact fingerprints where available.
- [ ] Allow producer-specific freshness fields, including the Codegraph index identity and indexed workspace state.
- [ ] Define root, process, and explicit flow scope without widening existing authorization.
- [ ] Require the producer to reauthorize every lookup.
- [ ] Define current, stale, mismatched, unreadable, and unavailable lookup outcomes.
- [ ] Preserve provenance, publication status, state drift, truncation, and cache decisions without including secrets or raw policy data.
- [ ] Keep references opaque and non-replayable.
- [ ] Specify bounded retention and content limits.
- [ ] Document compatibility and version-negotiation rules so extensions do not import each other's implementation modules.

#### Ownership

- Bash Tools continues to own `rr_`, `pc_`, and `vr_` evidence.
- Codegraph should own a separate `cg_` namespace and resolve its own references.
- The orchestration layer may transport references but must not reinterpret producer authorization or freshness.
- A shared implementation, if needed, must be a neutral protocol or utility package rather than Bash Tools becoming a generic artifact database.

#### Exit criteria

- A child contract can carry evidence from either extension without embedding the full result.
- Lookup authorization and stale-state behavior are unambiguous.
- Codegraph index freshness is distinct from Git workspace freshness.
- No extension must access another extension's private cache format.

### P1: Improve authorization outcome observability

Policy behavior must remain fail-closed while providing enough structured evidence to distinguish correct blocking from subsystem failures and workflow churn.

- [ ] Give explicit denial, confirmation timeout, non-interactive denial, policy-load failure, policy-save failure, lock failure, and authorization cancellation distinct structured reasons where compatibility permits.
- [ ] Record whether execution was attempted and whether a persistent policy decision was written.
- [ ] Keep prompt and notification telemetry bounded and free of environment values, raw policy contents, and sensitive paths.
- [ ] Make unchanged retries after persistent denials or timeouts clearly invalid without automatically changing the recorded policy decision.
- [ ] Preserve separate evidence lookup outcomes for authorization failure, scope mismatch, missing record, expiry, corruption, and state incompatibility where disclosure is safe.
- [ ] Evaluate child-session approval visibility only after measuring prompt and notification outcomes.
- [ ] Do not add automatic approval, implicit permission inheritance, or authorization bypasses to reduce failure counts.

#### Exit criteria

- Expected authorization decisions no longer inflate the implementation defect rate.
- Policy subsystem failures remain independently actionable.
- Workflow analysis can attribute latency and retries to approval interaction without exposing authorization data.
- Evidence lookup diagnostics remain fail-closed and do not reveal records across unauthorized scopes.

### P1: Complete compact read and Git evidence

The current tools already provide bounded reads, summary-first diffs, process-local reuse, and flow-scoped command evidence.

This work should close remaining cross-child and aggregate-payload gaps rather than replace existing behavior.

#### `read_batch`

- [ ] Add or confirm an aggregate model-facing byte limit across all requested files.
- [ ] Prevent overlapping or duplicate ranges from returning duplicate content in one request.
- [ ] Add continuation support when an aggregate result is truncated.
- [ ] Return stable content hashes and relevant file metadata with each successful observation.
- [ ] Determine whether `rr_` evidence can be safely published to an authorized flow for cross-process consumers.
- [ ] Reauthorize published read evidence at lookup and compare current artifact state before returning reusable content.
- [ ] Keep speculative broad batch reads more expensive or more explicit than narrow planned ranges.

#### Git state and diff evidence

- [ ] Determine whether compact `git_status` and `git_diff` summaries need stable evidence references across child processes.
- [ ] Prefer enriching existing Git results with repository-state identity over adding an overlapping public workspace-state tool.
- [ ] Preserve summary-first behavior and require explicit path-bounded requests for full patches.
- [ ] Return compact current-state comparison when prior Git evidence is referenced.
- [ ] Preserve process-local single-flight behavior for concurrent identical discovery work.

#### Exit criteria

- One request cannot inject an unbounded aggregate batch result into model context.
- Reusable read and Git evidence remains flow-scoped, state-aware, and producer-authorized.
- Cross-child reuse can return a compact unchanged or lookup result instead of repeating full content.

### P1: Align with compact Codegraph evidence

This repository will implement only the Bash Tools side of the interoperability contract.

The corresponding Codegraph work belongs in the Codegraph extension.

- [ ] Ensure the common evidence envelope can represent semantic exploration, symbol context, callers, callees, impact, and affected-test results.
- [ ] Support compact summaries and opaque `cg_` references without requiring Bash Tools to resolve them.
- [ ] Require Codegraph evidence to identify both the graph index state and workspace state.
- [ ] Ensure workspace mutations can make graph evidence visibly stale without deleting historical provenance.
- [ ] Coordinate bounded source snippets, precise file ranges, signatures, and relevance summaries as the default semantic result.
- [ ] Avoid embedding full source bodies when a bounded reference and exact range are sufficient.
- [ ] Define how Bash Tools repository-state metadata can be compared with producer-supplied Codegraph state without sharing private cache records.

The Codegraph extension should separately make `codegraph_sync` idempotent and return an unchanged result when the index already represents the relevant workspace state.

#### Exit criteria

- A worker can pass compact Codegraph evidence to another child through an opaque reference.
- Bash Tools remains independent from Codegraph implementation and storage.
- Consumers can determine whether graph evidence predates relevant workspace changes.

### P1: Evaluate compact search evidence

A second unconstrained search engine is not planned.

Any new Bash Tools search surface must provide materially smaller and more reusable results than native `grep`.

- [ ] Use the discovery substitution analysis to identify search result patterns that create avoidable context.
- [ ] Evaluate filename, count, match-summary, exact-match, context, and symbol-oriented result modes.
- [ ] Default to filenames and match counts when exact matching lines are not yet needed.
- [ ] Require bounded matches, bytes, context lines, and continuation.
- [ ] Evaluate flow-scoped search evidence using the producer-neutral contract.
- [ ] Preserve native `grep` for exact errors, literals, configuration, documentation, and graph-invisible dynamic behavior.
- [ ] Do not add an `rg` alias or arbitrary search command surface.

#### Exit criteria

- A new search surface is added only if current-version telemetry demonstrates lower total discovery context than native `grep` workflows.
- Search evidence is bounded, state-aware, and authorized consistently with filesystem reads.

### P1: Improve deterministic edit diagnostics

The existing edit interceptor already detects empty, missing, ambiguous, and overlapping replacements.

The remaining work is to make repairability and retry behavior explicit without weakening native edit semantics.

- [ ] Classify a missing previously observed replacement as `stale_context` where the available evidence supports that conclusion.
- [ ] Detect identical or no-op replacements during preflight where possible.
- [ ] Return a current file fingerprint and bounded repair context without returning unnecessary file content.
- [ ] Mark unchanged retries after empty, ambiguous, overlapping, or no-op requests as invalid.
- [ ] Preserve at most one caller-controlled reread-and-rebase recovery rather than implementing automatic mutation retries in the tool.
- [ ] Retain compatible public error wording where required while adding structured diagnostics.

#### Exit criteria

- Deterministic edit failures are distinguishable from transient execution failures.
- The next valid action is evident without requiring a broad reread.
- The extension never retries or rebases a mutation automatically.

### P1: Verify validation evidence correctness and adoption

The current `verify` and `project_command` evidence model already addresses much of the repeated-validation recommendation.

The next work should validate its identity, freshness, and practical use before expanding caching.

- [ ] Confirm which request, script, executable, environment, repository, manifest, and lockfile identities participate in verification evidence.
- [ ] Confirm how mutating format and lint variants affect evidence reuse and state drift.
- [ ] Confirm the relationship between the project-command process timeout and verify per-step and aggregate guards.
- [ ] Measure how often callers execute validation when compatible `vr_` evidence already exists.
- [ ] Measure publication and lookup failures separately from cache misses.
- [ ] Ensure successful, failed, incomplete, stale, forced, and lookup-only outcomes remain distinguishable.
- [ ] Keep package-script and Fallow execution non-reusable through `project_command` unless a future deterministic command class is proven safe.
- [ ] Prefer one complete verification artifact over repeated independent phase execution when repository state and requested scope are compatible.

#### Exit criteria

- Verification evidence identity is sufficient to prevent unsafe reuse.
- Repeated validation against unchanged compatible state is measurable.
- Any cache expansion is preceded by shadow comparison against fresh execution.

### P2: Evaluate changes in shadow mode

Shared evidence can save context while introducing stale-result and authorization risks.

- [ ] Detect candidate evidence reuse without changing the returned result.
- [ ] Compare candidates with fresh producer results.
- [ ] Measure safe matches, stale candidates, authorization denials, false matches, bytes avoided, and latency avoided.
- [ ] Enable automatic compact reuse only for evidence classes with demonstrated correctness.
- [ ] Retain an explicit fresh or refresh operation where the existing public contract provides one.
- [ ] Roll back reuse for any evidence class that cannot maintain fail-closed behavior.

## Success metrics

- Tool-result bytes and estimated tokens per successful workflow decrease for current-version sessions.
- Discovery calls and elapsed time before the first relevant file decrease without reducing task success.
- Codegraph-first workflows replace enough `grep`, `find`, and `read` work to offset their larger average result size.
- Repeated read, Git, and validation evidence against unchanged state decreases across children.
- Deterministic invalid requests and persistent authorization denials are not repeated unchanged.
- Expected policy decisions are excluded from implementation defect rates but included in workflow latency and retry analysis.
- Evidence lookups do not cross unauthorized root or flow boundaries.
- Stale workspace or index evidence is detected before reuse.
- Full output remains available only through bounded, authorized producer lookups.

## Deferred work

The following work is not part of the active efficiency and evidence program.

- [ ] Reconsider a curated read-only probe surface only if current-version telemetry shows persistent hallucinated shell-style probes that existing tools and Codegraph cannot address.
- [ ] Confirm no-environment fallback behavior in a separate integration environment when the host can provide that condition.
- [ ] Add direct tests for low-complexity rendering helpers only if their coverage findings remain materially useful.
- [ ] Add platform-specific Linux policy tests when a Linux CI environment is available.
- [ ] Revisit shared value-validation internals only if measured fan-in becomes a maintenance problem.

## Explicitly deferred to other extensions

- Orchestration fan-out limits and workflow budgets.
- Planner, worker, reviewer, and validator composition policy.
- Child-session reuse and lifecycle policy.
- Provider and model retry or fallback behavior.
- Flow-ledger summaries and incremental ledger reads.
- Compact child-response contracts and evidence-routing policy.
- Codegraph query implementation, index synchronization, and `cg_` artifact storage.
