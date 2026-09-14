# Bash Tools Plan

## Status

The current release scope is implemented and documented under [`docs/docs.md`](docs/docs.md).

This plan lists open topics only. Completed work items and their evidence live in the repository history.

The active plan focuses on reducing token and tool-call waste identified in [`research/research-initial.md`](research/research-initial.md) and refined by the version-aware [`research/findings-0909.md`](research/findings-0909.md), [`research/findings-1409.md`](research/findings-1409.md), and the token-tracker [`research/findings-1409-token-tracker.md`](research/findings-1409-token-tracker.md), with Bash Tools limited to its own execution, evidence, filesystem, Git, validation, and observability responsibilities.

The `1.0.3` cohort (103 unambiguous sessions, 4,963 calls, 4.84% error rate) is the stable pre-`1.1.0` baseline.
Version `1.1.2` is released and loaded from folder, so the next report can separate the released `1.0.3` baseline from current behavior for the first time.

The remaining P0 work is the analyzer and importer handoff plus per-cohort comparison breakdowns from the first `1.1.2` cohort.

Orchestration policy and Codegraph implementation remain owned by their respective extensions.
Codegraph Runner 2.0.2 implements the producer-side evidence contract for `cg_` artifacts; Bash Tools carries the shared envelope additively on `pc_`, `vr_`, and `rr_` records, and the remaining shared-contract work is cross-producer lookup-outcome alignment.
Cross-extension work will use compatible evidence contracts rather than direct implementation dependencies.

## Goals

- Establish which historical inefficiencies still exist in the current Bash Tools version.
- Reduce repeated delivery of read-only workspace evidence across root and child sessions.
- Make discovery evidence interoperable with Codegraph without making Bash Tools responsible for Codegraph storage or freshness.
- Reduce oversized read, search, Git, and semantic-discovery results.
- Improve deterministic edit and request failure diagnostics so unchanged retries are clearly invalid.
- Reduce deterministic request churn and repeated identical execution against unchanged state.
- Preserve authorization, cache isolation, bounded output, fail-closed behavior, and compatibility contracts.

## Scope boundaries

Bash Tools may produce, publish, compare, and resolve evidence for operations it owns.

Codegraph must remain the producer and resolver of its own semantic and graph evidence.

Evidence references must not grant permissions, bypass producer authorization, or expose content across unrelated roots or flows.

Bash Tools will not add arbitrary shell execution, orchestration roles, fan-out policy, provider retry policy, model fallback, or child-session lifecycle behavior.

## Active work

### P0: Build a current-version efficiency baseline

Implementation decisions must use measurements segmented by the active extension and schema versions rather than aggregate historical totals.
The `1.0.3` cohort is the pre-`1.1.0` comparison baseline; version attribution within a released version remains coarse because `EXTENSION_VERSION` is read from `package.json`, so every commit after a release reports that version.

- [ ] Recompute error rates, duplicate requests, result volume, latency, cache decisions, and evidence reuse for each sufficiently covered version cohort. (Error rate and estimated result tokens are reported per cohort, while duplicate, latency, cache-decision, and evidence-reuse metrics remain window-level only.)
- [ ] Measure repeated `project_command` execution separately from `verify` execution, lookup, reuse, publication, forced execution, and cache ineligibility for each sufficiently covered cohort. (Execution reasons and the aggregate publication, lookup, verdict, ref, coercion, and forced-bypass segmentation are reported; the per-version-cohort breakdown and the `verify`-versus-`project_command` separation remain open.)
- [ ] Measure Git summary reuse, patch follow-up frequency, truncation, and repeated state observations. (The invocation records carry `unchanged`, the effective `mode`, `maxBytes`, and `truncated`, and repository-state coverage is in place; patch-after-summary sequences and the never-exercised reuse branch remain uncomputed.)
- [ ] Keep the `1.0.3` cohort as the pre-`1.1.0` comparison baseline.

#### Policy and authorization outcome analysis

The `findings-1409` exclusive raw classification contains 935 policy or authorization-related results, or 19.24% of the 4,859 recorded tool-result errors.
The grouped outcomes are 578 sandbox or filesystem-containment results, 151 approval-interaction timeouts, 93 policy-subsystem failures, 87 non-interactive fail-closed denials, 16 expected explicit authorization decisions, and 10 evidence-flow or scope failures.
Structured authorization telemetry recorded 788 decisions across 25 sessions, of which 786 were automatic, exactly 1 emitted a prompt, and 1 was an unchanged retry after a denial.
These results remain relevant to workflow efficiency but must not be treated uniformly as tool implementation failures.

The observed authorization save failures and timeouts were classified from exact session-log data: timeouts are expected interaction outcomes, policy-store contention was ruled out by a concurrent-wave test, and the confirmed persist-conflict blind spot (a failed persist that hid a concurrently persisted allow) was fixed in 1.1.1 with `policy-save-failure` telemetry making any recurrence countable.
The remaining save-failure causes are genuine filesystem conditions and deliberate stale-lock no-takeover behavior.

- [ ] Distinguish wrong-flow, unpublished, missing, expired, unauthorized, and unreadable evidence where this can be done without leaking evidence existence. (Recording side is implemented and in-window: clamped `lookup.outcome` telemetry on `pc_`/`vr_` lookups; the analyzer does not yet break the 13 recorded lookup failures down by outcome, so this stays open until the analyzer consumes `lookup.outcome`.)
- [ ] Segment policy outcomes by root or child session, interaction mode, tool, command ID, effective flow, and policy decision source. (Surface, command, `mode`, `flowId`, and `decisionSource` recording is implemented; root-versus-child session recording plus per-cohort reporting of those dimensions remain open.)
- [ ] Measure whether a timeout or denial was followed by an unchanged retry, later equivalent approval, alternate tool path, or abandoned workflow. (Unchanged retries are measurable; later equivalent approval, alternate tool path, and abandoned-workflow classification remain open.)
- [ ] Measure token cost, wall-clock delay, and downstream retries separately because approval waits may be latency-heavy without being token-heavy. (The components exist separately and the project-command record splits preparation, authorization, and queue time; the components are not yet joined per approval event across surfaces.)

No measurement or implementation change may weaken explicit authorization, automatically approve a request, widen evidence scope, or change fail-closed behavior.

#### Discovery substitution analysis

Tool adoption alone is not a success metric.
The analysis must determine whether Codegraph replaces text-search and read work or merely precedes the same work.
The historical report provides a bounded proximity baseline, but its 705 potential substitution signals cannot establish counterfactual replacement.

- [ ] Compare discovery sequences that begin with Codegraph against sequences that begin with `grep`, `find`, or `read`.
- [ ] Measure calls, model-facing result bytes, estimated tokens, and elapsed time before the first relevant file and first mutation.
- [ ] Measure how often files or snippets returned by Codegraph are fetched again through `read`, `read_batch`, or `grep`.
- [ ] Measure unique files inspected before mutation and per accepted changed file.
- [ ] Measure repeated or overlapping graph context across children even when graph queries are not byte-identical.
- [ ] Measure whether `codegraph_affected` narrows validation scope and reduces validation execution.
- [ ] Track index freshness and workspace mutations when graph evidence is consumed.

#### Analyzer and importer handoff

These measurements are owned by the session analyzer and importer rather than by Bash Tools, and the extension already records their inputs.

- [ ] Persist the provider tool-call id on tool-call messages so custom-entry records join their tool calls exactly instead of by session and command.
- [ ] Report the new attribution fields per cohort: the project-command phase split (`preparationDurationMs`, `authorizationDurationMs`, `queueDurationMs`), the authorization `mode`/`flowId`/`decisionSource` segmentation, the Git `mode`/`maxBytes`/`truncated` distribution, and the read-batch `role`/`delegationId`/`publication` attribution.
- [ ] Report the `edit-stale-context` hit rate from the recorded `evidenceBacked` flag, separating evidence-backed stale classifications from plain no-match failures.
- [ ] Consume the newly recorded fields: authorization `mode`, `flowId`, and `decisionSource`; read-batch `role`, `delegationId`, and `publication`; Git `mode`, `maxBytes`, and `truncated`; and the project-command `preparationDurationMs`, `authorizationDurationMs`, and `queueDurationMs` phase split. (Consuming the read-batch consumer fields also closes the `artifact_consumer_tracking` availability gap.)
- [ ] Reconcile telemetry field names before consuming them: the analyzer's data map expects `policySource` while the record emits `decisionSource`, and expects `repositoryStateStatus` while the record emits `repositoryState.stateMatchesCurrent` and `stateDrift`.
- [ ] Decide whether the two workspace-block shapes should be unified, because `git-invocation` and `read-batch-invocation` use the shared envelope's `repositoryId`/`dirtyDigest` while `project-command-invocation` uses `repositoryIdentity`/`dirtyFilesDigest`.
- [ ] Confirm that `codegraph_sync` excess calls do not represent repeated work before treating them as waste, because an idempotent unchanged result still counts as an excess call. (101 recorded checks with 41 executions and zero failures, so most checks do not execute work; the 362 excess calls are a request-repetition count, and the redundancy claim stays unresolved.)

#### Exit criteria

- Current-version metrics are available independently from historical aggregate metrics with enough coverage to support implementation decisions.
- Tool ownership is derived from recorded inventory source metadata rather than inferred from the custom-entry producer.
- Duplicate-work metrics include repository or artifact state at each invocation.
- Expected authorization decisions are reported separately from policy subsystem and tool execution failures.
- Policy wait time and repeated calls remain visible in efficiency metrics even when the fail-closed decision was correct.
- Codegraph value is expressed as downstream calls, bytes, latency, and successful-workflow outcomes avoided.
- Each implementation item below has measured current-version evidence or is explicitly classified as preventive correctness work.

### P0: Define a producer-neutral evidence contract

Bash Tools and Codegraph expose compatible evidence metadata while retaining producer-owned storage and lookup.
Codegraph Runner 2.0.2 satisfies the producer-side requirements for its `cg_` evidence, and Bash Tools carries the same envelope additively on `rr_`, `pc_`, and `vr_` records with opt-in `rr_` flow publication, so the remaining shared-contract work is cross-producer lookup-outcome alignment.

- [ ] Define current, stale, mismatched, unreadable, and unavailable lookup outcomes consistently across producers. (Bash Tools defines its side: clamped `lookup.outcome` on `pc_`/`vr_` lookups, `repositoryStateStatus`, and `stateDrift`; cross-producer harmonization with Codegraph's freshness states remains open.)

#### Ownership

- Bash Tools continues to own `rr_`, `pc_`, and `vr_` evidence.
- Codegraph owns a separate `cg_` namespace and resolves its own references.
- The orchestration layer may transport references but must not reinterpret producer authorization or freshness.
- A shared implementation, if needed, must be a neutral protocol or utility package rather than Bash Tools becoming a generic artifact database.

#### Exit criteria

- A child contract can carry evidence from either extension without embedding the full result.
- Lookup authorization and stale-state behavior are unambiguous.
- Codegraph index freshness is distinct from Git workspace freshness.
- No extension must access another extension's private cache format.

### P1: Improve authorization outcome observability

Policy behavior remains fail-closed while providing structured evidence to distinguish correct blocking from subsystem failures and workflow churn.
Authorization outcomes are recorded as bounded `bash-tools.authorization-outcome` entries for every surface, and unchanged retries after persistent denials or confirmation timeouts are rejected as a distinct `unchanged-retry` failure without re-prompting or writing any policy decision.

- [ ] Evaluate child-session approval visibility only after measuring prompt and notification outcomes. (Gate satisfied: 786 of 788 decisions were automatic, exactly 1 prompt was emitted, and it timed out after 120,012 ms, so the evaluation is unblocked and nothing in the data suggests a prompt-visibility problem that warrants code changes.)
- [ ] Do not add automatic approval, implicit permission inheritance, or authorization bypasses to reduce failure counts.

#### Exit criteria

- Expected authorization decisions no longer inflate the implementation defect rate.
- Policy subsystem failures remain independently actionable.
- Workflow analysis can attribute latency and retries to approval interaction without exposing authorization data.
- Evidence lookup diagnostics remain fail-closed and do not reveal records across unauthorized scopes.

### P1: Complete compact read and Git evidence

The current tools provide bounded reads, summary-first diffs, process-local reuse, and flow-scoped command evidence.
This work closes remaining cross-child and aggregate-payload gaps rather than replacing existing behavior.

#### Read adoption and repeat-read cost (token-tracker context pack, data through 2026-09-14)

The token-tracker pack measured a 09-10 adoption collapse of `read_batch` (9 percent of read calls to under 2 percent), zero availability in child sessions, and a nearly idle `unchanged` mechanism (6 of 508 repeat items).
Availability was restored by fixing the subagent extension's active agent set in the same `1.1.2` window, so the next report measures restored adoption.
The invocation record's `availability` field was determined to be N/A by design (an invocation record can only exist when the tool ran; `tool-inventory` snapshots distinguish absent from unused), the 7-of-314 emission gap was explained by the recorder shipping on 09-11 while 298 of 314 calls predate it, intra-call duplicates were determined to be overlapping (already rejected), alias (collapsed to `unchanged`), or legitimate disjoint windowed reads, and the outside-repository per-item error was confirmed present since the tool shipped.

- [ ] Name the failing requested path in per-item `read_batch` error results. Error items currently report the marker `<outside-repository>` or `<invalid-path>` as `path`, so the model cannot tell which requested path failed and cannot correct the request. Echo the caller-supplied path string (bounded by the existing path-length cap) in error items while keeping the resolved marker in telemetry.
- [ ] Add digest-on-repeat to `read_batch`: the current `unchanged` path returns only the flag, `ref`, and `contentHash` with no content, and its cache key is path plus exact range, so windowed repeats and cross-range re-reads re-ship identical content (53 of 508 repeat items re-shipped 0.20 MB byte-identical; zero false-unchanged flags). Keep a session-scoped per-path map of the latest full-file content hash and `ref` fed by every successful batch item regardless of range; when a repeat re-read matches that hash, return a compact bounded digest line plus the existing `ref` instead of full content, and record a `digestOnRepeat` marker on the invocation record so adoption is measurable. Native `read` cannot be digested because interceptors cannot rewrite results, so the `read_batch`-owned result channel is the implementable surface.
- [ ] Emit a structured code for `project_command` confirmation timeouts (and a bounded forced-bypass marker) on result details so the analyzer stops classifying `Project command confirmation timed out` results from message text. Additive, optional, bounded; the `authorization-outcome` records already carry the structured outcome for the surfaces that record them.
- [ ] Decide whether intercepted native `grep` defaults should change: `context >= 2` carries 14.7 MB of the 16.79 MB grep result total while `context: 0` has a median result of 627 B, so defaulting context to 0 and tightening the limit saves roughly 10 MB per week. This is a native-tool behavior change (interceptors can mutate `event.input`), so it needs an explicit task-success trade-off decision and should not ship silently. A global 8 KB result cap on native results remains closed by the interception determination; caps on Bash Tools-owned results already exist, and `project_command` measured fine at 2.50 MB total with a 2.2 KB p95.

### P1: Align with compact Codegraph evidence

This repository implements only the Bash Tools side of the interoperability contract.
The corresponding Codegraph work belongs in the Codegraph extension and is implemented in Codegraph Runner 2.0.2.

The Codegraph extension makes `codegraph_sync` idempotent and returns an unchanged result when the index already represents the relevant workspace state.

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

The existing edit interceptor already detects empty, missing, ambiguous, and overlapping replacements, classifies no-op and unchanged-retry requests, and returns bounded repair context.
The remaining work makes repairability and retry behavior explicit without weakening native edit semantics.

- [ ] Decide whether evidence-backed staleness detection should be reachable in practice. No `edit-stale-context` and no `edit-unchanged-retry` outcome has been observed, because observations are written only by `read_batch` full-file reads while the real edit failures are 507 `edit-no-match` and 222 `edit-ambiguous` results. Either extend observed-content recording to intercepted native reads with its bounded read cost, or record the determination that the stale path stays dormant and rely on the no-match and ambiguity diagnostics that do fire.

#### Exit criteria

- Deterministic edit failures are distinguishable from transient execution failures.
- The next valid action is evident without requiring a broad reread.
- The extension never retries or rebases a mutation automatically.

### P1: Instrument remaining cost and attribution gaps

Each `findings-1409` measurement that cannot be taken from existing records needs a bounded additive field rather than a new tool.

#### Exit criteria

- Every metric that `findings-1409` marks unmeasurable has a bounded field or an explicit decision not to record it.
- New fields remain additive, bounded, privacy-preserving, and observational, and none changes a result, error, or authorization decision.

### P1: Reduce deterministic request churn

`findings-1409` attributes 487 errors to deterministically invalid Git requests and 6,242 excess calls to repeated identical work, and it shows that advisory text alone does not stop the loop.
Deterministic request-shape failures are already coerced or rejected with per-session unchanged-retry tracking for `git_status`, `git_log`, and `git_diff`.

- [ ] Report an advisory duplicate-execution marker when the same `project_command` request already executed for the same repository state in the same session scope, without changing `reusePolicy`, returning stored results, or weakening the non-reusable rule. (Deferred to the P2 shadow-mode reuse evaluation: an executed-request marker needs a session-scoped fingerprint over request and repository state, which is the reuse-shaped store P2 already owns, and it is never admissible on the current non-reusable path.)
- [ ] Provide an unchanged or hashed path for repeated identical reads, through the intercepted native `read` or through documented `read_batch` adoption, so an unchanged repeat returns compact metadata instead of full content. (Determination: no interception mechanism exists that can return compact metadata for native reads, so the native-`read` option is closed without changing native read semantics; guidance steering repeated and multi-file reads to `read_batch` is in place, and the implementable surface is the `read_batch` digest-on-repeat item above.)
- [ ] Measure the `read_batch` share of read-like calls plus `rr_` publication and lookup counts, so adoption of the compact read path is visible. (Partially measurable from existing records: the read-batch record carries per-item and aggregate sizes, `unchanged`, `scope`/`flowId`, `repositoryState`, and the `lookup` block, plus consumer-role attribution and publication success; the measurement belongs to the next analysis pass.)

Real evidence reuse remains out of scope here: package-script and Fallow execution stay non-reusable until a deterministic command class is proven safe, and the shadow-mode reuse evaluation stays in P2.

#### Exit criteria

- A deterministically invalid request is not repeated unchanged without an explicit corrective change.
- Repeated identical reads or executions against unchanged state return compact or advisory results instead of full work.
- No fail-closed behavior, authorization decision, or existing public error wording changes beyond additions.

### P1: Diagnose filesystem path-resolution failures

`findings-1409` counts 277 `policy-path-resolution-failure` results across `read`, `grep`, `ls`, and `edit`, and every one of them previously collapsed into the same opaque message.
Structured reasons and per-reason fixed actions are now recorded; the remaining work is measurement.

- [ ] Measure the structured reasons per cohort so the change is visible in the next report. (The block reason payload carries `details.resolutionFailure.reason`, so the analyzer can count reasons from result payloads; the per-cohort breakdown belongs to the next analysis pass.)

#### Exit criteria

- A path-resolution failure names a reason the caller can act on instead of repeating the same request unchanged.
- No resolution reason weakens containment, deny precedence, or fail-closed behavior.
- Existing public wording and contracts gain only additive fields.

### P1: Verify validation evidence correctness and adoption

The `verify` and `project_command` evidence model addresses much of the repeated-validation recommendation.
The next work validates its identity, freshness, and practical use before expanding caching.

- [ ] Confirm which request, script, executable, environment, repository, manifest, and lockfile identities participate in verification evidence.
- [ ] Confirm how mutating format and lint variants affect evidence reuse and state drift. (State drift is recorded and mutating variants are classified, but the report does not yet compare drift or reuse between mutating and non-mutating variants.)
- [ ] Confirm the relationship between the project-command process timeout and verify per-step and aggregate guards.
- [ ] Measure how often callers execute validation when compatible `vr_` evidence already exists.
- [ ] Measure publication and lookup failures separately from cache misses. (Lookup failures are a distinct execution reason and publication outcomes are recorded in the `publication` blocks; the per-cohort reporting remains with the analyzer.)
- [ ] Ensure successful, failed, incomplete, stale, forced, and lookup-only outcomes remain distinguishable. (Forced execution, cache decisions, result categories, state drift, `verdict`, and `lookup` are recorded; incomplete verify verdicts, stale evidence, and lookup-only outcomes are not yet counted separately in the report.)
- [ ] Keep package-script and Fallow execution non-reusable through `project_command` unless a future deterministic command class is proven safe.
- [ ] Prefer one complete verification artifact over repeated independent phase execution when repository state and requested scope are compatible.

#### Exit criteria

- Verification evidence identity is sufficient to prevent unsafe reuse.
- Repeated validation against unchanged compatible state is measurable.
- Any cache expansion is preceded by shadow comparison against fresh execution.

### P2: Evaluate changes in shadow mode

Shared evidence can save context while introducing stale-result and authorization risks.
`findings-1409` measured 0.96% project-command cache reuse against 2,064 forced bypasses, so the first decision here is whether any deterministic command class may become reusable at all; package-script and Fallow execution stay non-reusable until that is proven.

- [ ] Decide explicitly whether any deterministic command class may become reusable, or keep execution non-reusable and reduce churn through advisory markers instead. (Evidence for the decision: 2,064 forced bypasses across 137 sessions, of which 1,564 are `node_test`, `node_lint`, and `node_format`, and most carry no orchestration role, so the bypass is caller-driven rather than role-driven.)
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
- Deterministically invalid requests are coerced or rejected without a repeated identical attempt.
- Repeated identical reads and executions against unchanged state return compact or advisory results.
- Every published or looked-up evidence record is attributable to the session and role that consumed it.
- Expected policy decisions are excluded from implementation defect rates but included in workflow latency and retry analysis.
- Evidence lookups do not cross unauthorized root or flow boundaries.
- Stale workspace or index evidence is detected before reuse.
- Full output remains available only through bounded, authorized producer lookups.

## Deferred work

The following work is not part of the active efficiency and evidence program.

- [ ] Reconsider a curated read-only probe surface only if current-version telemetry shows persistent hallucinated shell-style probes that existing tools and Codegraph cannot address.
- [ ] Evaluate a token-oriented serialization format (for example TOON) only for model-facing projections of uniform tabular arrays, and only if current-version telemetry shows that such summaries dominate context; stored evidence records and the producer-neutral cross-extension contract remain JSON.
- [ ] Confirm no-environment fallback behavior in a separate integration environment when the host can provide that condition.
- [ ] Add direct tests for low-complexity rendering helpers only if their coverage findings remain materially useful.
- [ ] Add platform-specific Linux policy tests when a Linux CI environment is available.
- [ ] Revisit shared value-validation internals only if measured fan-in becomes a maintenance problem.

## Explicitly deferred to other extensions

- Orchestration fan-out limits and workflow budgets.
- Planner, worker, reviewer, and validator composition policy.
- Child-session reuse and lifecycle policy.
- Provider and model retry or fallback behavior.
- Flow-ledger summaries and incremental ledger reads. (`rr_` publication and reauthorized lookup supply the transport; the ledger shape, summaries, and cursors remain with the orchestration layer.)
- Compact child-response contracts and evidence-routing policy.
- Codegraph query implementation, index synchronization, and `cg_` artifact storage (implemented in Codegraph Runner 2.0.2).
- Malformed tool names: the raw Pi log already contains the corrupted `toolCall` name and this repository has no `arg_value` parsing, so the upstream tool-call assembly layer owns the fix.
