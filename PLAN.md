# Bash Tools Plan

## Status

The current release scope is implemented and documented under [`docs/docs.md`](docs/docs.md).

The active plan now focuses on reducing token and tool-call waste identified in [`research/research-initial.md`](research/research-initial.md) and refined by the version-aware [`research/findings-0909.md`](research/findings-0909.md) and [`research/findings-1409.md`](research/findings-1409.md), with Bash Tools limited to its own execution, evidence, filesystem, Git, validation, and observability responsibilities.

Historical extension-version recovery is complete, and the `1.0.3` cohort reported by [`research/findings-1409.md`](research/findings-1409.md) (103 unambiguous sessions, 4,963 calls, 4.84% error rate) now serves as the stable current-version baseline.
Version `1.1.0` is released and loaded from folder, so new sessions report `1.1.0` and the next report can attribute post-`1.0.3` behavior.

Orchestration policy and Codegraph implementation remain owned by their respective extensions.

Codegraph Runner 2.0.2 now implements the counterpart that the producer-neutral evidence contract was waiting on: a producer-owned `cg_` artifact store with a versioned evidence envelope, repository and multi-dimensional index state, bounded retention, opaque non-replayable references, and lookup-time scope, workspace, and freshness reauthorization. Bash Tools now carries that envelope additively on `pc_`, `vr_`, and `rr_` records through a neutral shared envelope module, `rr_` records support opt-in flow publication with reauthorized, state-verified lookup, and the remaining shared-contract work is cross-producer lookup-outcome alignment.

The envelope-adoption slice is implemented, `1.1.0` adds opt-in `rr_` flow publication with reauthorized state-verified lookup, and `findings-1409` supplies the accumulated `1.0.3` telemetry; the remaining P0 work is the analyzer and importer handoff plus per-cohort comparison breakdowns from the first `1.1.0` cohort.

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

The 30-day report combines sessions from multiple stages of tooling evolution.

Implementation decisions must use measurements segmented by the active extension and schema versions rather than aggregate historical totals.

The raw Pi session scan recovered 782 `bash-tools.tool-inventory` entries across 649 sessions after confirming that the historical SQLite importer had discarded top-level custom entries.

A single extension version can now be assigned to 641 sessions and 26,998 calls, covering 55.55% of sessions and 45.60% of calls in the historical window.

The `findings-1409` rescan of the 30 days ending 2026-09-14 replaces the earlier baseline.
The latest observed `1.0.3` cohort contains 113 inventory entries across 103 unambiguous sessions and 4,963 calls with a 4.84% error rate, and 7-day version coverage rose to 310 of 321 sessions (96.57%) and 14,046 of 16,637 calls (84.43%).
The `1.0.3` cohort is now the largest recent cohort and the first one large enough to serve as a stable baseline.
Version attribution remains coarse for that window: because `EXTENSION_VERSION` is read from `package.json`, every commit after the `1.0.3` release also reported `1.0.3`, so the cohort mixes released `1.0.3` code with later work.
Version `1.1.0` is released and loaded from folder, so the next report can separate the released `1.0.3` baseline from current behavior for the first time.

- [x] Recover raw Bash Tools inventory entries and join their `sessionId` values to imported sessions.
- [x] Extract historical extension versions, active-tool snapshots, and tool schema hashes without consulting current source files.
- [x] Report the historical version distribution and identify the latest observed cohort within the fixed analysis window.
- [x] Exclude missing-version and multiple-version sessions from version cohorts instead of assigning them by proximity.
- [x] Attribute inventory tools by their recorded source so Bash Tools-owned, intercepted native, Codegraph, and unrelated extension tools are not conflated. (`findings-1409` now emits `sourceAttribution` from `tools[].sourceInfo`: 28,844 builtin calls at a 5.0% error rate, 8,030 `npm:@ztc/bash-tools` calls at 24.2%, 1,531 folder-loaded Bash Tools calls at 22.1%, 1,549 `codegraph-runner` calls at 0.3%, plus smaller CLI and package cohorts, with 41,347 of 55,599 calls attributed and malformed tool names isolated separately.)
- [ ] Recompute error rates, duplicate requests, result volume, latency, cache decisions, and evidence reuse for each sufficiently covered version cohort. (Error rate and estimated result tokens are now reported per cohort — `1.0.3` 4.84% over 4,963 calls, `1.0.2` 9.22% over 3,297, and six older cohorts — while duplicate, latency, cache-decision, and evidence-reuse metrics remain window-level only.)
- [x] Implement state-aware duplicate classification and report unknown state instead of labeling unsupported duplicates as waste.
- [x] Improve repository-state coverage beyond the 201 historically attributable calls with `read_batch` observations.
- [x] Observe repository state on the Git read tools so state coverage is not limited to `read_batch` and command execution.
- [x] Separate invalid requests, policy outcomes, policy subsystem failures, resolution failures, command failures, timeouts, cancellations, test failures, and successful evidence lookups where historical data supports the distinction.
- [x] Report tool-result rates both including and excluding expected authorization and fail-closed outcomes. (`findings-1409` now publishes both rates: 8.74% inclusive versus 7.05% excluding 942 expected results over 30 days (policy 626, orchestration budget 302, confirmation timeout 14), and 7.86% versus 5.92% over the latest 7 days. The exclusion matters for our own surface: most of the 1,940 errors attributed to `npm:@ztc/bash-tools` are expected policy and fail-closed outcomes, not defects.)
- [ ] Measure repeated `project_command` execution separately from `verify` execution, lookup, reuse, publication, forced execution, and cache ineligibility for each sufficiently covered cohort. (Execution reasons are now separated — 2,596 `executed-cache-ineligible`, 1,991 `executed-forced-cache-bypass`, 145 `policy-failure`, 78 `executed-after-cache-miss`, 71 `resolution-failure`, 48 `reused-cache-hit`, 35 `preparation-failure`, 13 `lookup-failure`, and 2 `invalid-request`. `findings-1409` now adds the aggregate publication, lookup, verdict, ref, coercion, and forced-bypass segmentation — 55 published refs with zero publication failures, 55 lookups with 42 successes and 13 failures, 115 `incomplete` versus 62 `passed` and 33 `failed` verdicts, 289 aggregate runs, 38 coercions, and 2,064 forced bypasses attributed by role and command — which covers most of this item in aggregate, while the per-version-cohort breakdown and `verify`-versus-`project_command` separation remain open.)
- [x] Include `read_batch` in read-like artifact analysis.
- [x] Record aggregate and per-item result size for `read_batch`.
- [ ] Measure Git summary reuse, patch follow-up frequency, truncation, and repeated state observations. (The git invocation recorder now emits these records (51 in the 30-day window), repository-state coverage rose from 318 to 1,404 calls, and each record now carries `unchanged`, the effective `git_diff` `mode`, the requested `maxBytes`, and `truncated`. `findings-1409` now reports Git result modes, truncation, byte volume, and reuse: 2,908 result payloads, 38.26 million bytes, 116 truncated results, 1,083 `patch` versus 283 `summary` responses, and `unchanged` false on all 51 invocation records, so summary reuse is not exercised yet. Patch-after-summary sequences remain uncomputed.)
- [x] Produce a provisional latest-observed-version baseline with explicit sample coverage and uncertainty.
- [x] Accumulate enough current-version telemetry to identify which findings in the two research reports remain active. (`findings-1409` supplies a 103-session/4,963-call `1.0.3` cohort at 96.57% 7-day session coverage and identifies the active findings — `project_command` volume, error rate, and duplicate excess; cross-child duplication; typed validation preflight; edit reliability; and near-absent cache reuse — against the previous report's rates.)

#### Policy and authorization outcome analysis

The `findings-1409` exclusive raw classification contains 935 policy or authorization-related results, or 19.24% of the 4,859 recorded tool-result errors.
The normalized classifier reported 626 `policy_denied` results, and the older five-way `failureTotals.policy` value was 385; those three totals are intentionally separate measurements and must not be interchanged.
The grouped outcomes are 578 sandbox or filesystem-containment results, 151 approval-interaction timeouts, 93 policy-subsystem failures, 87 non-interactive fail-closed denials, 16 expected explicit authorization decisions, and 10 evidence-flow or scope failures.
Structured authorization telemetry recorded 788 decisions across 25 sessions, of which 786 were automatic, exactly 1 emitted a prompt, and 1 was an unchanged retry after a denial.

These results remain relevant to workflow efficiency but must not be treated uniformly as tool implementation failures.

- [x] Verify that every result in the broad policy total is represented once and that exact-message classifications do not overlap normalized categories.
- [x] Separate explicit user or administrator denials from confirmation timeouts.
- [x] Separate expected fail-closed decisions from policy-load, policy-save, lock, unsafe-path, and other policy subsystem failures.
- [x] Classify missing authorized-flow references as evidence-routing outcomes rather than generic interactive policy denials.
- [ ] Distinguish wrong-flow, unpublished, missing, expired, unauthorized, and unreadable evidence where this can be done without leaking evidence existence. (Recording side implemented and now in-window: clamped `lookup.outcome` telemetry on `pc_`/`vr_` lookups distinguishes `unauthorized-flow`, `not-found`, and `corrupt`; see the checked item under authorization outcome observability. `findings-1409` reports 55 lookup attempts with 42 successes and 13 failures alongside the older taxonomy (10 evidence-flow or scope failures), but it does not yet break the 13 failures down by outcome, so this item stays open until the analyzer consumes `lookup.outcome`.)
- [x] Preserve whether command execution was attempted for every authorization-related outcome.
- [ ] Segment policy outcomes by root or child session, interaction mode, tool, command ID, effective flow, and policy decision source. (Authorization records now segment by surface and command — 698 `filesystem`, 82 `project-command`, 8 `verify`, with per-command outcomes such as 296 authorized `read`, 216 authorized `edit`, 172 authorized `grep`, and 33 authorized `node_test` — while recording of interaction mode, effective flow, and policy decision source is implemented on authorization records (see the checked item under authorization outcome observability), and root-versus-child session recording plus per-cohort reporting of those dimensions remain open.)
- [x] Measure whether an approval prompt, warning, or terminal notification was emitted and how long the request waited. (`findings-1409` reports 788 authorization records of which exactly 1 emitted a prompt, with the bounded `promptWaitMs` summing to 120,012 ms from that single timed-out prompt; warning and terminal-notification emission are not separately flagged because they accompany the prompt, and the near-zero prompt rate means the 120-second `confirmationTimeoutMs` default is a policy choice to review rather than a measured blocker.)
- [ ] Measure whether a timeout or denial was followed by an unchanged retry, later equivalent approval, alternate tool path, or abandoned workflow. (Unchanged retries are now measurable: of 854 failures with an exact retry within five calls, 580 repeated the identical request with no intervening change and 7 followed an explicitly non-retryable error, with 561 carrying unknown retryability; later equivalent approval, alternate tool path, and abandoned-workflow classification remain open, and the single `unchanged-retry-after-denial` record shows the new invalidation path in use.)
- [ ] Measure token cost, wall-clock delay, and downstream retries separately because approval waits may be latency-heavy without being token-heavy. (The components now exist separately — bounded prompt wait (120,012 ms total), latency percentiles (34 ms median, 5,941 ms p95, 120,129 ms p99), downstream retry counts, and computed-versus-reported cost with a 1.34% 30-day delta — and the project-command record now splits preparation, authorization, and queue time, so approval latency is attributable per invocation; the components are not yet joined per approval event across surfaces.)
- [x] Keep the remaining non-policy results divided into invalid requests, repository evidence failures, provider or execution failures, cancellations, implementation failures, and uncategorized outcomes rather than labeling them all as actual errors. (`findings-1409` reports the split directly: 977 `schema_validation` invalid requests, 1,136 `command_execution`, 207 `provider_timeout_or_unavailable`, 14 `cancelled_or_terminated`, 12 `no_op_edit`, a first-class `orchestration_budget` category of 302 policy-driven stops, and 1,131 explicitly uncategorized results.)

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

#### Analyzer and importer handoff

These measurements are owned by the session analyzer and importer rather than by Bash Tools, and the extension already records their inputs.

- [ ] Persist the provider tool-call id on tool-call messages so custom-entry records join their tool calls exactly instead of by session and command.
- [x] Attribute inventory tools by `tools[].sourceInfo` so owned, intercepted native, Codegraph, and unrelated tools are counted separately. (`findings-1409` emits `sourceAttribution`; see the checked P0 item for the cohort split.)
- [x] Count edit preflight failures by structured diagnostic code (`edit-no-match`, `edit-stale-context`, `edit-ambiguous`, `edit-overlap`, `edit-no-op`, `edit-unchanged-retry`) instead of normalized message text, so the evidence-backed path is distinguishable from plain no-match. (`findings-1409` now counts structured codes and finds 747 edit codes against 434 normalized results — 507 `edit-no-match`, 222 `edit-ambiguous`, 15 `edit-overlap`, and 3 `edit-no-op`. It also confirms that no `edit-stale-context` or `edit-unchanged-retry` code appears, so the evidence-backed separation is still not observable; the hit-rate item below stays open for that reason.)
- [x] Present the `publication`, `lookup`, `forced`, `reused`, `verdict`, and `stateDrift` segmentation that invocation records already carry. (`findings-1409` now reports 55 published flow refs with zero publication failures, 55 lookup attempts with 42 successes and 13 failures, 115 `incomplete` versus 62 `passed` and 33 `failed` verdicts, 289 aggregate runs, 375 records carrying a `ref`, 38 `paths:string-json-array` coercions, and a forced-bypass breakdown by role and command; `stateDrift` was recorded on 144 invocations and no invocation recorded shared execution above zero.)
- [ ] Report the new attribution fields per cohort: the project-command phase split (`preparationDurationMs`, `authorizationDurationMs`, `queueDurationMs`), the authorization `mode`/`flowId`/`decisionSource` segmentation, the Git `mode`/`maxBytes`/`truncated` distribution, and the read-batch `role`/`delegationId`/`publication` attribution.
- [ ] Report the `edit-stale-context` hit rate from the recorded `evidenceBacked` flag, separating evidence-backed stale classifications from plain no-match failures.
- [ ] Consume the newly recorded fields: authorization `mode`, `flowId`, and `decisionSource`; read-batch `role`, `delegationId`, and `publication`; Git `mode`, `maxBytes`, and `truncated`; and the project-command `preparationDurationMs`, `authorizationDurationMs`, and `queueDurationMs` phase split. (Consuming the read-batch consumer fields is also what closes the `artifact_consumer_tracking` availability gap that `findings-1409` still reports as unavailable.)
- [ ] Reconcile telemetry field names before consuming them: the analyzer's data map expects `policySource` while the record emits `decisionSource`, and expects `repositoryStateStatus` while the record emits `repositoryState.stateMatchesCurrent` and `stateDrift`.
- [ ] Decide whether the two workspace-block shapes should be unified, because `git-invocation` and `read-batch-invocation` use the shared envelope's `repositoryId`/`dirtyDigest` while `project-command-invocation` uses `repositoryIdentity`/`dirtyFilesDigest`.
- [x] Recompute duplicate, latency, cache-decision, and evidence-reuse metrics per version cohort, not only per window. (`findings-1409` now reports error rate, duplicate excess, latency p50/p95, cache hits, and reused calls per cohort: `1.0.3` is the cleanest recent release at a 4.8% error rate and 6.7% duplicate excess with 33 reused calls, while cache hits are zero in every cohort, which confirms the reuse problem is not release-specific.)
- [ ] Confirm that `codegraph_sync` excess calls do not represent repeated work before treating them as waste, because an idempotent unchanged result still counts as an excess call. (`findings-1409` reports 101 recorded checks with 41 executions and zero failures, so most checks do not execute work, but the 362 excess calls are a request-repetition count and not a measure of wasted sync work; the redundancy claim is therefore still unresolved and the metric should be paired with execution counts.)
- [ ] Keep the `1.0.3` cohort as the pre-`1.1.0` comparison baseline.

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

Codegraph Runner 2.0.2 satisfies the producer-side requirements for its `cg_` evidence: a versioned envelope carrying `ref`, `producer`, `kind`, `scope`, `requestHash`, `contentHash`, a `workspace` block with `repositoryId`, `head`, `dirtyDigest`, and `status`, a nested `producerState` with the Codegraph index identity and workspace freshness, an `output` block with truncation and byte totals, and `provenance` creation metadata. References are opaque and non-replayable, retention and content limits are bounded, every lookup is reauthorized against the effective scope, workspace, and index freshness, and lookup outcomes distinguish current, stale, mismatched, missing, expired, corrupt, unauthorized, and unreadable records.

Bash Tools now carries the same envelope additively on `rr_`, `pc_`, and `vr_` records, and `rr_` records support opt-in flow publication with reauthorized, state-verified lookup, so the remaining shared-contract work is cross-producer lookup-outcome alignment.

Satisfied by the Codegraph producer:

- [x] Include the evidence reference, producer, evidence kind, request hash, content hash, compact summary, bounded output metadata, and creation metadata.
- [x] Include canonical repository identity, `HEAD`, dirty-state identity, and relevant artifact fingerprints where available.
- [x] Allow producer-specific freshness fields, including the Codegraph index identity and indexed workspace state.
- [x] Require the producer to reauthorize every lookup.
- [x] Keep references opaque and non-replayable.
- [x] Specify bounded retention and content limits.

Remaining shared-contract and Bash Tools work:

- [x] Define a minimal versioned evidence envelope shared by participating extensions.
- [x] Define root, process, and explicit flow scope without widening existing authorization, including the `root` to `session` naming mapping.
- [ ] Define current, stale, mismatched, unreadable, and unavailable lookup outcomes consistently across producers. (Bash Tools defines its side: clamped `lookup.outcome` on `pc_`/`vr_` lookups, `repositoryStateStatus`, and `stateDrift`; cross-producer harmonization with Codegraph's freshness states remains open.)
- [x] Preserve provenance, publication status, state drift, truncation, and cache decisions without including secrets or raw policy data. (Envelope records carry `producer`, `kind`, request and content hashes, `output` truncation blocks, `workspace` state, and `publication`; invocation records carry `publication`, `stateDrift`, and cache decisions, all bounded and privacy-preserving, per docs/artifacts.md.)
- [x] Document compatibility and version-negotiation rules so extensions do not import each other's implementation modules. (docs/artifacts.md "Compatibility and version negotiation" plus the "Semantic result defaults" independence statement.)

#### Envelope adoption slice

This slice is preventive correctness work: it changes evidence metadata shape only and does not weaken authorization, widen evidence scope, or change stored payloads.

- [x] Add a neutral shared envelope module holding the versioned format constant, the scope mapping, and bounded validators.
- [x] Add `producer`, `kind`, `requestHash`, `contentHash`, `output`, and `workspace` fields to `pc_` records additively, keeping existing fields and `producerScope` values unchanged.
- [x] Add the same envelope fields to `vr_` records without changing the `cacheFormatVersion: 2` on-disk validation contract.
- [x] Bring `rr_` records into the same envelope. (Initially in-memory; flow publication followed in the read-batch publication slice.)
- [x] Document the shared envelope, the `root` to `session` scope mapping, compatibility and version-negotiation rules, and the `workspace` digest comparison rule in [`docs/artifacts.md`](docs/artifacts.md).

#### Model-facing reference visibility slice

`project_command` minted `pc_` references into result details but never projected them into model-facing content, so a caller could not cite or look up evidence for its own command, even though `verify` returned `vr_` references and `read_batch` publication returned an `rr_` reference.

- [x] Project the bounded `ref` and the realized `publication` outcome into `project_command` model-facing content, copying both values unchanged and omitting each key when it is undefined. (`covers`, provenance, repository state, fingerprints, policy identifiers, timing, and output metadata stay details-only.)
- [x] Carry the stored reference on failing and cancelled executions. The failure message gains a bounded `ref: <pc_...>` segment directly after `reason:`, before the truncation tail, and the cancellation message appends `; ref: <pc_...>`; an execution with no stored evidence keeps both messages byte-identical. Only the reference enters the message: the realized publication outcome stays in error details and invocation records, where looking up the reference returns it. (`publication`, `covers`, and every other failure detail field keep their existing shape, and the message stays inside its existing 2,000-character bound.)
- [x] Name the check that drops real evidence records in the test harness. (The check is the `project_command` evidence profile's integer-duration requirement: the writer emits fractional measured durations, so the store's `set()` rejected every real timed record and stored nothing; the profile now accepts the writer's fractional durations and the real durable store is covered directly by a real-shape store test.)

#### Evidence writer-contract sweep

Extending the record-bound sweep to all three families (`pc_`, `vr_`, `rr_`) found one production-confirmed `pc_` instance of the same mismatch class: the evidence profile required integer durations while the writer emits fractional measured durations, so the store rejected every real timed record and silently dropped the evidence. A scan of 1,249 on-disk files (562 verify aliases, 562 verify records, 8 `pc_` evidence records of which 7 were rejected solely on fractional durations, 0 `rr_` records, plus external Codegraph cache records sharing the directory) confirmed the verify family clean after the read-path fix and found no `rr_` instance.

- [x] Accept the writer's real shapes in the `pc_` evidence profile: fractional measured durations (finite, same 24h max, matching the cache-layer profile), uncapped safe-integer output totals, and the shared display-command bound.
- [x] Unify the display-command bound in one shared constant in the `project-command` limits module, used by the `pc_` evidence profile and both verify bounds, so no family is tighter than the joined display command a real run can emit.
- [x] Guarantee ESC-free verify failure tails at the writer: the tail sanitizer now strips every complete CSI sequence (any final byte, including colon-parameter SGR), OSC sequences (BEL or ST terminated, with an unterminated OSC consumed up to the next escape start, matching terminal behavior), and any lone ESC byte; the validator stays fail-closed and still rejects any ESC byte, and the display path reuses the same sanitizer.
- [x] Align the `pc_` cache-layer totals bounds with uncapped real totals while keeping the 2 MiB serialized record cap as the storage backstop.
- [x] Confirm the `rr_` family already mirrors its writer caps exactly (32 entries, 64 KiB content, 256 KiB aggregate, 384 KiB record, 4,096 paths), so no change was needed there.

#### Verify flow evidence read-path slice

Flow seats could write verify evidence to disk but could never read it back, so flow-scoped publication and reference resolution always failed even though the files were present and sized on disk.

Root sessions never hit the validator because their records live in memory, so the mismatch was invisible until a real flow-scoped record was probed.

- [x] Make the durable verify read validator accept the record shape the writer produces. The stored-text cap (50 KiB bytes, guaranteed by the execution capture layer) is correct, but the validator also capped the reported `totalBytes`/`totalLines` at that stored-text cap while the writer intentionally stores the executor's real totals; any phase whose output exceeded 50 KiB produced a record that failed its own disk-read validation. (`totalBytes`/`totalLines` are now bounded integers up to `Number.MAX_SAFE_INTEGER`, matching the record's own shared output block; `text` keeps its 50 KiB cap.)
- [x] Close the same mismatch for command identity strings. `command`, `resolvedCommand`, and record-level `resolvedCommands` carry the joined display command, which a real verify run can emit at about 279K chars (absolute executable plus up to 64 test paths at 4,096 chars each plus the package-manager wrapper), while the validator capped them at 4,096. (All three now share one exported 300 KiB command bound; `executable` and per-item `args` keep their 4,096 path bounds.)
- [x] Prove the flow disk read path end to end. (Same-instance set/get/getByRef round trip under flow scope, two-instance cross-read over one temp root with no shared maps, root-published reference readable by a flow seat and refused for a different flow without a store probe, flow-seat publish success after the fix, and the unchanged fail-closed guards: missing ref, oversized 2 MiB file, stale mtime, and wrong-flow refusal classified from the caller's own context before any store query.)
- [x] Sweep the remaining verify record bounds against the writer's contract so no other validator bound is tighter than what real executions emit; both fixed bounds were found by validating a real on-disk record, and a systematic pass would close the class instead of individual instances. (Extended to all three families in the evidence writer-contract sweep above; the verify family had no remaining instance.)

#### Ownership

- Bash Tools continues to own `rr_`, `pc_`, and `vr_` evidence.
- Codegraph owns a separate `cg_` namespace and resolves its own references; Codegraph Runner 2.0.2 implements this.
- The orchestration layer may transport references but must not reinterpret producer authorization or freshness.
- A shared implementation, if needed, must be a neutral protocol or utility package rather than Bash Tools becoming a generic artifact database.

#### Exit criteria

- A child contract can carry evidence from either extension without embedding the full result.
- Lookup authorization and stale-state behavior are unambiguous.
- Codegraph index freshness is distinct from Git workspace freshness.
- No extension must access another extension's private cache format.

### P1: Improve authorization outcome observability

Policy behavior must remain fail-closed while providing enough structured evidence to distinguish correct blocking from subsystem failures and workflow churn.

Authorization outcomes are now recorded as bounded `bash-tools.authorization-outcome` entries for every surface without changing any decision, error, or fail-closed behavior.

Unchanged retries after persistent denials or confirmation timeouts are now rejected as a distinct `unchanged-retry` authorization failure within the same session, tracked by a bounded in-memory per-session fingerprint map, without re-prompting or writing any policy decision.

- [x] Give explicit denial, confirmation timeout, non-interactive denial, policy-load failure, policy-save failure, and authorization cancellation distinct structured reasons where compatibility permits; lock-level failures still surface as save failures pending policy-store-level distinction.
- [x] Record whether execution was attempted and whether a persistent policy decision was written.
- [x] Keep prompt and notification telemetry bounded and free of environment values, raw policy contents, and sensitive paths.
- [x] Make unchanged retries after persistent denials or timeouts clearly invalid without automatically changing the recorded policy decision.
- [x] Preserve separate evidence lookup outcomes for authorization failure, scope mismatch, missing record, expiry, corruption, and state incompatibility where disclosure is safe. Implemented as a bounded telemetry-only `lookup.outcome` (`success`, `not-found`, `unauthorized-flow`, `corrupt`) on `pc_` and `vr_` lookup invocations; expiry is N/A because records have no TTL and capacity-trimmed entries are indistinguishable from missing, corruption is distinguishable only in-process (`project_command` root and flow maps) with `verify` clamping to `not-found`, state incompatibility was already carried by the repository-state block, and `rr_` lookups stay deferred with flow publication.
- [ ] Classify the observed authorization save failures and timeouts as policy-store contention, filesystem conditions, or an implementation defect, and fix a confirmed defect cause. `findings-1409` recorded 34 `authorization_save_failure` and 20 `authorization_timeout` results over 30 days, including 34 `verify authorization failed: save` and 20 `verify authorization failed: timeout` messages, so policy intent was not persisted in those cases.
- [ ] Evaluate child-session approval visibility only after measuring prompt and notification outcomes. (Gate satisfied: `findings-1409` measured the outcomes — 786 of 788 decisions were automatic, exactly 1 prompt was emitted, and it timed out after 120,012 ms — so the evaluation is now unblocked, and nothing in the data suggests a prompt-visibility problem that warrants code changes.)
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

- [x] Add or confirm an aggregate model-facing byte limit across all requested files. (256 KiB aggregate returned-content cap, 4× the 64 KiB per-file cap.)
- [x] Prevent overlapping or duplicate ranges from returning duplicate content in one request. (Rejected up front as `invalid-request`; raw-path comparison, so canonical-alias duplicates are not detected — bounded anyway by the per-file and aggregate caps.)
- [x] Add continuation support when an aggregate result is truncated. (`results.continuation` with `nextIndex`/`totalPaths`; the caller re-issues the remaining bounded path list.)
- [x] Return stable content hashes and relevant file metadata with each successful observation. (`contentHash` sha256 of file bytes on fresh and unchanged results; size/line metadata already in `output.totalBytes`/`totalLines`.)
- [x] Determine whether `rr_` evidence can be safely published to an authorized flow for cross-process consumers. (Yes, opt-in and flow-scoped only: `publish: { flowId }` must equal the caller's effective orchestration flow, publication fails closed, records are stored per flow with 32-entry/256 KiB-content/384 KiB-record caps, at most 128 records retained in memory per flow, and durable records bounded by the shared disk cache (2 MiB per record, seven days, 50 MiB per directory), and no session-scope or cross-flow widening is possible.)
- [x] Reauthorize published read evidence at lookup and compare current artifact state before returning reusable content. (`read_batch { ref }` reauthorizes every recorded path for the current process, re-reads current bytes, compares the exact byte sha256, and returns stored content only for `unchanged` paths; `changed`, `unreadable`, and `unauthorized` paths return no content, and workspace state is compared through `compareWorkspaceBlocks`.)
- [x] Keep speculative broad batch reads more expensive or more explicit than narrow planned ranges. (No additional penalty was added; broad reads stay explicit and bounded by the 32-path cap, 64 KiB per file, 256 KiB aggregate returned content with per-path `aggregate-limit` errors, and `results.continuation`.)

#### Git state and diff evidence

- [x] Determine whether compact `git_status` and `git_diff` summaries need stable evidence references across child processes. (Determined not yet — deferred pending the flow evidence-referencing decision; decision, rationale, and revisit trigger documented in docs/git.md.)
- [x] Prefer enriching existing Git results with repository-state identity over adding an overlapping public workspace-state tool. (`head` and `dirtyFilesDigest` added to `git_status` and `git_diff` summary results; no workspace-state tool.)
- [x] Keep repository-state identity defined for worktrees with tracked deletions. `contentDigest` treated any dirty path without an inode as an unreadable state, so a single ` D` entry made `dirtyFilesDigest` undefined, which silently dropped `head` and `dirtyFilesDigest` from `git_status` and made `verify` refuse publication with `repository state is unreadable or changed during execution`; reproduced end to end on the installed build and at the reader level before the fix. (`contentDigest` now classifies a status as an absent deletion when it contains `D` and not `U`, so ` D`, `D `, `MD`, `AD`, `DD`, and `RD` contribute their status, path, and original path with fixed placeholder values `mode "0"`, `size "0"`, `hash "deleted"` instead of file content, never reach `hash-object`, and cannot undefine the digest, while unmerged `UD`/`DU` entries keep their present worktree file hashed so conflicted content stays content-sensitive; every cap, the hash count and format checks, the stat-stability check, rename pairing, and every fail-closed `undefined` result are unchanged.)
- [x] Prove the modification/deletion conflict path against a real merge conflict. (A real modify/delete merge conflict in an integration repository emits exactly the two unmerged records real git produces (README.md as `DU`, "space name.txt" as `UD`), the reader returns a defined 40-hex head and 64-hex digest over it, appending conflict-marker text to the surviving file changes the digest and restoring the bytes restores the exact digest, and resolving both paths clears every unmerged record while keeping the digest defined; join with the existing scripted-GitExec reader-contract coverage.)
- [x] Preserve summary-first behavior and require explicit path-bounded requests for full patches. (Whole-repo patches stay byte-bounded with INCOMPLETE guidance naming explicit `paths`; confirmed by integration test. Superseded by the patch-scope decision below: whole-repository patches are now rejected.)
- [x] Return compact current-state comparison when prior Git evidence is referenced. (Process-local unchanged comparison for repeated identical `git_diff` summary requests, mirroring `git_status`; cross-process references remain deferred.)
- [x] Preserve process-local single-flight behavior for concurrent identical discovery work. (Existing claim/wait tests cover concurrent deduplication and aborted-waiter isolation. `findings-1409` recorded no concurrent execution above 1 and no shared run in the window, so the path is implemented and tested but rarely exercised in practice.)
- [x] Rebalance patch versus summary usage. `findings-1409` recorded 1,083 `patch` responses against 283 `summary` responses, with 116 truncated results, which is the opposite of the summary-first design and makes `git_diff` the second-largest result-token source at about 8.24 million tokens. Revisit the tool description and guidance, and decide whether whole-repository patches should require explicit paths, without removing legitimate bounded patch requests. (Decided: patch mode requires an explicit `path` or `paths`; an unscoped patch request is rejected as a deterministic invalid request before any Git diff process runs, and whole-repository diff reads are summary-only. Scoped patches keep their exact behavior and their bounded INCOMPLETE truncation guidance. The earlier byte-bounded whole-repository patch returned a byte prefix that could cut a file mid-hunk and was re-requested scoped anyway, so the trade-off is one summary call before a scoped patch for unscoped intent. Decision, rationale, and revisit trigger are recorded in docs/git.md.)

#### Exit criteria

- One request cannot inject an unbounded aggregate batch result into model context.
- Reusable read and Git evidence remains flow-scoped, state-aware, and producer-authorized.
- Cross-child reuse can return a compact unchanged or lookup result instead of repeating full content.

### P1: Align with compact Codegraph evidence

This repository will implement only the Bash Tools side of the interoperability contract.

The corresponding Codegraph work belongs in the Codegraph extension and is implemented in Codegraph Runner 2.0.2 for the items marked below.

- [x] Ensure the common evidence envelope can represent semantic exploration, symbol context, callers, callees, impact, and affected-test results.
- [x] Support compact summaries and opaque `cg_` references without requiring Bash Tools to resolve them.
- [x] Require Codegraph evidence to identify both the graph index state and workspace state.
- [x] Ensure workspace mutations can make graph evidence visibly stale without deleting historical provenance.
- [x] Avoid embedding full source bodies when a bounded reference and exact range are sufficient.
- [x] Coordinate bounded source snippets, precise file ranges, signatures, and relevance summaries as the default semantic result. (Documented in docs/artifacts.md under "Semantic result defaults"; docs-only — code side already satisfied: Bash Tools read tools are the only full-body path and `cg_` refs stay opaque.)
- [x] Define how Bash Tools repository-state metadata can be compared with producer-supplied Codegraph state without sharing private cache records. (`compareWorkspaceBlocksCrossProducer` in `src/evidence/repository-state-comparison.ts`; head-only authoritative comparison, documented in docs/artifacts.md under "Cross-producer repository-state comparison".)

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

The existing edit interceptor already detects empty, missing, ambiguous, and overlapping replacements.

The remaining work is to make repairability and retry behavior explicit without weakening native edit semantics.

- [x] Classify a missing previously observed replacement as `stale_context` where the available evidence supports that conclusion. (`edit-stale-context` when a prior `read_batch` observation hash differs from the current content; plain `edit-no-match` without evidence.)
- [x] Detect identical or no-op replacements during preflight where possible. (`edit-no-op` when `oldText` equals `newText` after host normalization.)
- [x] Return a current file fingerprint and bounded repair context without returning unnecessary file content. (`fileFingerprint` sha256 of the preflight-read content, `contentLength`, `lineCount`, nearest candidate lines; hash-only.)
- [x] Mark unchanged retries after empty, ambiguous, overlapping, or no-op requests as invalid. (`edit-unchanged-retry`, session-scoped, bounded FIFO tracker keyed by path and edits hash.)
- [x] Preserve at most one caller-controlled reread-and-rebase recovery rather than implementing automatic mutation retries in the tool. (Hints and docs only; a rebased edit that now matches passes preflight.)
- [x] Retain compatible public error wording where required while adding structured diagnostics. (Existing four hint strings byte-identical; new codes share the same contract shape.)
- [ ] Decide whether evidence-backed staleness detection should be reachable in practice. `findings-1409` recorded no `edit-stale-context` and no `edit-unchanged-retry` outcome at all, because observations are written only by `read_batch` full-file reads (347 calls in the window) while the real edit failures are 507 `edit-no-match` and 222 `edit-ambiguous` results. Either extend observed-content recording to intercepted native reads with its bounded read cost, or record the determination that the stale path stays dormant and rely on the no-match and ambiguity diagnostics that do fire.

#### Exit criteria

- Deterministic edit failures are distinguishable from transient execution failures.
- The next valid action is evident without requiring a broad reread.
- The extension never retries or rebases a mutation automatically.

### P1: Instrument remaining cost and attribution gaps

`findings-1409` names measurements that cannot be taken from existing records; each needs a bounded additive field rather than a new tool.

- [x] Record preparation, authorization, and queue time separately on `project-command` invocation records. The existing `durationMs` minus `executionDurationMs` already shows 4.17 hours of 7.25 hours unexplained, but not which component dominates.
      Additive optional `preparationDurationMs`, `authorizationDurationMs`, and `queueDurationMs` are clamped and omitted when not measured.
      Preparation spans tool entry to the authorization mark, or to invocation end when preparation failed; authorization spans the authorization call including any confirmation prompt wait; queue spans only a single-flight follower's wait.
      Evidence-`ref` lookups omit all three, and the disjoint-interval invariant is documented in `docs/artifacts.md`.
- [x] Record `mode`, `maxBytes`, and `truncated` on Git invocation records so summary reuse, patch follow-up, and Git truncation are measurable without parsing result payloads or call arguments. (Additive optional fields; `mode` is the effective `git_diff` mode, `maxBytes` is recorded only when the request supplied one, `truncated` comes from the result truncation block on completed invocations, and each field is omitted when not applicable.)
- [x] Record `role`, `delegationId`, and an explicit `publication` block on read-batch invocation records so `rr_` consumers are attributable the way `pc_` consumers already are. (Additive bounded fields recorded only when the orchestration context provides them and when the request asked to publish; the `publication` block mirrors the project-command shape, and a publish-requested call that fails before result details exist records no `publication` block because no result payload exists to describe.)
- [x] Record interaction mode, effective flow, and policy decision source on authorization outcome records so policy outcomes can be segmented beyond surface and command ID.
      Additive optional `mode`, `flowId`, and `decisionSource` fields are emitted where a bounded value exists and omitted otherwise.
      `flowId` comes only from the caller's own orchestration context when the effective scope is flow, and `decisionSource` is the configured authorization value or `prompt` for prompt-derived outcomes.
      Determination: an implicit in-project filesystem access is recorded as `allow-project` because the decision functions flatten it to the same value as a configured project allow and distinguishing them would require changing decision logic.
- [x] Record whether an edit diagnostic was evidence-backed, so the hit rate of `edit-stale-context` is measurable instead of inferred. (Additive `evidenceBacked: true` on stale-context and equal-hash no-match diagnostics; omitted when no observation exists, and diagnostic codes, hints, and wording are unchanged.)

#### Exit criteria

- Every metric that `findings-1409` marks unmeasurable has a bounded field or an explicit decision not to record it.
- New fields remain additive, bounded, privacy-preserving, and observational, and none changes a result, error, or authorization decision.

### P1: Reduce deterministic request churn

`findings-1409` attributes 487 errors to deterministically invalid Git requests and 6,242 excess calls to repeated identical work, and it shows that advisory text alone does not stop the loop.

- [x] Coerce or reject empty and conflicting Git request fields without a repeated identical attempt: 333 `git_status` empty `path`, 85 `git_log` empty `revision`, and 69 `git_diff` path-and-`paths` conflicts. (An empty optional `path` or `revision` is treated as absent and named in the bound `coercions` record field; `paths` entries are never dropped; a non-empty `path`-and-`paths` conflict keeps its rejection and wording.)
- [x] Extend unchanged-retry invalidation beyond authorization denials to deterministic validation failures for `git_status`, `git_log`, and `git_diff`. (Request-shape failures are tracked per session, tool, and effective request hash; a repeat is rejected as `unchanged-invalid-request` without execution, while unsafe paths, cancellation, transient failures, and sessions without identity are never tracked.)
- [ ] Report an advisory duplicate-execution marker when the same `project_command` request already executed for the same repository state in the same session scope, without changing `reusePolicy`, returning stored results, or weakening the non-reusable rule. (Deferred to the P2 shadow-mode reuse evaluation: an executed-request marker needs a session-scoped fingerprint over request and repository state, which is the reuse-shaped store P2 already owns, and it is never admissible on the current non-reusable path.)
- [ ] Provide an unchanged or hashed path for repeated identical reads, through the intercepted native `read` or through documented `read_batch` adoption, so an unchanged repeat returns compact metadata instead of full content. (Determination: no interception mechanism exists that can return compact metadata, because `ToolCallEventResult` can only block or mutate `event.input` and cannot rewrite results, so the native-`read` option is closed without changing native read semantics; guidance steering repeated and multi-file reads to `read_batch` was added to `docs/tools.md` and `README.md`, and no unsupported opt-in was built.)
- [ ] Measure the `read_batch` share of read-like calls plus `rr_` publication and lookup counts, so adoption of the compact read path is visible. (Determination: partially measurable from existing records. The read-batch record carries per-item and aggregate sizes, `unchanged`, `scope`/`flowId`, `repositoryState`, and the `lookup` block, so reuse and lookup counts are derivable, and consumer-role attribution and publication success are now recorded through the `role`, `delegationId`, and `publication` fields added by the instrumentation section; the measurement itself belongs to the next analysis pass.)

Real evidence reuse remains out of scope here: package-script and Fallow execution stay non-reusable until a deterministic command class is proven safe, and the shadow-mode reuse evaluation stays in P2.

#### Exit criteria

- A deterministically invalid request is not repeated unchanged without an explicit corrective change.
- Repeated identical reads or executions against unchanged state return compact or advisory results instead of full work.
- No fail-closed behavior, authorization decision, or existing public error wording changes beyond additions.

### P1: Diagnose filesystem path-resolution failures

`findings-1409` counts 277 `policy-path-resolution-failure` results across `read`, `grep`, `ls`, and `edit`, making it the second-largest structured failure code, and every one of them currently collapses into the same opaque message.

This is the same shape as the Git request preflight and edit diagnostics already shipped: a deterministic failure that the caller could correct if it were told which condition failed.

- [x] Classify the resolution failure into bounded structured reasons, such as outside the workspace, missing target, symlink escape, traversal form, or control character, without changing the existing message, the block decision, or fail-closed behavior. (Implemented as a seven-value reason union on additive `details.resolutionFailure.reason`: `missing-target`, `unreadable`, `symlink`, `control-character`, `wildcard-path`, `invalid-path-form`, and `unknown`. The reason comes from the failing resolution step, `policy-path-resolution-failure` is unchanged as the contract code, and the exact block message, the block decision, and fail-closed behavior are byte-preserved. Outside-workspace and traversal-form are not reasons: `requestPath` normalizes traversal before resolution and containment remains a later policy decision reported as `policy-denied`, so those reasons would be unreachable.)
- [x] Return the nearest safe action for each reason, following the additive diagnostic pattern already used for edit preflight and Git request validation. (Each reason maps to one fixed `details.resolutionFailure.action` string; no path, policy, or environment content enters it, and the existing contract `suggestedAction` stays unchanged.)
- [ ] Measure the structured reasons per cohort so the change is visible in the next report. (Recording side implemented: the block reason payload now carries `details.resolutionFailure.reason`, so the analyzer can count reasons from result payloads in the same way it counts structured codes, without a new record type or an observability change. The per-cohort breakdown itself belongs to the next analysis pass.)

#### Exit criteria

- A path-resolution failure names a reason the caller can act on instead of repeating the same request unchanged.
- No resolution reason weakens containment, deny precedence, or fail-closed behavior.
- Existing public wording and contracts gain only additive fields.

### P1: Verify validation evidence correctness and adoption

The current `verify` and `project_command` evidence model already addresses much of the repeated-validation recommendation.

The next work should validate its identity, freshness, and practical use before expanding caching.

- [ ] Confirm which request, script, executable, environment, repository, manifest, and lockfile identities participate in verification evidence.
- [ ] Confirm how mutating format and lint variants affect evidence reuse and state drift. (State drift is now recorded on 144 invocations and mutating variants are classified, but the report does not yet compare drift or reuse between mutating and non-mutating variants.)
- [ ] Confirm the relationship between the project-command process timeout and verify per-step and aggregate guards.
- [ ] Measure how often callers execute validation when compatible `vr_` evidence already exists.
- [ ] Measure publication and lookup failures separately from cache misses. (Lookup failures are a distinct execution reason (13 in the window, alongside 71 `resolution-failure`), and publication outcomes are now recorded with `published` and a bounded `error` in the project-command and read-batch `publication` blocks, so publication failures are distinguishable from cache misses in the records; the per-cohort reporting remains with the analyzer.)
- [ ] Ensure successful, failed, incomplete, stale, forced, and lookup-only outcomes remain distinguishable. (Forced execution (2,064 records), cache decisions, result categories, and state drift are distinguishable in `findings-1409`, and the `verdict`, `stateDrift`, and `lookup` fields are now recorded on the invocation records; incomplete verify verdicts, stale evidence, and lookup-only outcomes are not yet counted separately in the report.)
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
- Flow-ledger summaries and incremental ledger reads. (`1.1.0` supplies the transport through `rr_` publication and reauthorized lookup; the ledger shape, summaries, and cursors remain with the orchestration layer.)
- Compact child-response contracts and evidence-routing policy.
- Codegraph query implementation, index synchronization, and `cg_` artifact storage (implemented in Codegraph Runner 2.0.2).
- Malformed tool names such as `ls ...</arg_value>`: the raw Pi log already contains the corrupted `toolCall` name and this repository has no `arg_value` parsing, so the upstream tool-call assembly layer owns the fix.
