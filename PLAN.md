# Bash Tools Plan

## Status

The current release scope is implemented and documented under [`docs/docs.md`](docs/docs.md).

This plan lists open topics only. Completed work items and their evidence live in the repository history.

The active plan focuses on reducing token and tool-call waste identified in [`research/research-initial.md`](research/research-initial.md) and refined by the version-aware [`research/findings-0909.md`](research/findings-0909.md), [`research/findings-1409.md`](research/findings-1409.md), and the token-tracker [`research/findings-1409-token-tracker.md`](research/findings-1409-token-tracker.md), with Bash Tools limited to its own execution, evidence, filesystem, Git, validation, and observability responsibilities.

The `1.0.3` cohort (103 unambiguous sessions, 4,963 calls, 4.84% error rate) is the stable pre-`1.1.0` baseline.
Version `1.1.2` is released and loaded from folder, so the next report can separate the released `1.0.3` baseline from current behavior for the first time.

The highest-priority work is the Pi SDK result-schema implementation below, followed by the deferred-exposure evaluation, the analyzer and importer handoff, and per-cohort comparison breakdowns from the first `1.1.2` cohort.

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

### P0: Evaluate selected Pi SDK integrations

Tool inventory format 2 now records bounded SDK exposure, namespace names, and allowlisted annotations, and static read-only/destructive hints are assigned to the relevant tools.
The remaining SDK evaluations are prioritized here before the existing efficiency-analysis work.

- [x] Evaluate `outputSchema` and `structuredContent` on a bounded result such as `git_status` or `git_log`. Confirm that structured results materially help codemode or other programmatic consumers, remain within output bounds, and do not expose data beyond current authorization or model-facing results. Decision (2026-09-17): adopt, with implementation prioritized in the section below. Runtime facts: `structuredContent` is never sent to the model; declaring `outputSchema` switches codemode nested-call resolution from text to `structuredContent` for that tool; the host performs no schema validation, so conformance is the producer's obligation and must be enforced by package tests.
- [ ] Evaluate deferred exposure for infrequently used tools such as `git_log` and `git_show`. Measure prompt-token savings against discovery success with `tool_search` enabled, and keep tools directly exposed unless the benefit and discoverability are demonstrated.

### P0: Add outputSchema and structuredContent to bounded tools

The evaluation above adopted the SDK result-schema contract for bounded read-shaped tools.
`structuredContent` reaches programmatic consumers only: codemode nested calls, `tool_result` hooks, and session records; the model-facing `content` of each tool is unchanged.
Because the host does not validate `structuredContent` against the declared schema, conformance on every result mode is the producer's obligation and is enforced by package tests, not by the runtime.

Staged by codemode value and payload stability:

- [x] Stage 1: `git_status`. The tool already serializes one bounded JSON object; declare its typebox schema and set `structuredContent` to that object, keeping the JSON text as `content`. Outcome: `git_status` declares `gitStatusOutputSchema` and returns `structuredContent` on both the changed and unchanged paths through `makeStructuredToolResult`; the shared `toJsonValue` boundary mirrors JSON.stringify semantics (drops undefined properties, maps undefined array elements to null, fails closed on non-JSON values); the model-facing text is unchanged, and conformance tests cover the changed, unchanged, and truncated result modes.
- [x] Stage 2: `git_log`, `git_show`, and `git_diff`, which already emit bounded JSON payloads per mode. Outcome: `git_log` declares `gitLogOutputSchema` and `git_show` declares `gitShowOutputSchema`; `git_diff` declares `gitDiffOutputSchema` as a typebox union of the summary, unchanged comparison, and patch modes (the status entry schema is shared with `git_status` via `gitStatusEntrySchema`). All three return `structuredContent` through `makeStructuredToolResult` on success and keep failures throwing; `makeToolResult` was folded into `makeStructuredToolResult` since no tool uses the text-only form anymore. Conformance tests with `Value.Check` cover the log, show, and diff (summary, patch, unchanged) payload shapes against `details`, and the model-facing `content` text is unchanged. Verified: focused tests `pc_0883fd0df628c7e5540a9cb7`, verify `vr_fa09382cdc0439f669bbff37`, fallow dupes 0 groups, fallow audit vs HEAD `a8f24fe` pass with 0 introduced.
- [x] Stage 3: `read_batch`, whose result envelope (items, aggregates, unchanged flags, repository state) is the highest-volume programmatic surface. Coordinate with the digest-on-repeat item in P1 so the schema covers the digest result mode from the start. Outcome: `read_batch` declares `readBatchDetailsSchema`, an `additionalProperties: false` envelope over per-path results (content, range, `rr_` ref, `contentHash`, unchanged flag, bounded per-path error), the aggregate-limit continuation, the publication block, and the full published-evidence lookup payload (entries with reauthorization status, workspace blocks, repository state status), so the P1 digest-on-repeat change can keep using the same unchanged/ref/contentHash item shape without a schema bump. The tool returns `structuredContent` through `toJsonValue` on every success path, including lookup results with empty `results`, and failures keep throwing; fresh items with `unchanged: false` forced the unchanged field to be a boolean rather than a literal. Conformance tests with `Value.Check` cover the execution, unchanged repeat, aggregate-limit continuation, publication, and lookup modes against `details`, and the model-facing `content` text is unchanged.
- [x] Evaluate afterwards: `project_command` and `verify` evidence envelopes (result categories, verdicts, lookup blocks), then `environment`, `move`, and `delete`, whose payloads are small and mostly fixed-shape. Outcome: all five are done. `environment` declares `environmentOutputSchema` (key to string-or-null record), and `move`/`delete` declare `filesystemMoveDetailsSchema` and `filesystemDeleteDetailsSchema`; all three return `structuredContent` on success and keep failures throwing, with `Value.Check` conformance tests and unchanged model-facing text. `project_command` declares `projectCommandModelContentSchema` and `verify` declares `verifyOutputSchema`; see the decision note below. Verified: focused tests `pc_6e897a044563624f42e1a299` (47 tests), verify `vr_32436c0f130a72b0c5992d5d`, fallow audit vs HEAD `53f1265` pass with 0 introduced (`pc_ad0e9107c11c670c4af99fa8`, 22 complexity findings inherited from the touched verify hotspots), fallow dupes 0 groups (`pc_fcf967cdd4b60dc9d6c80423`), fallow dead-code back to the single pre-existing finding (`pc_b9a09870de66a1b50ffaea1c`).
- [x] Decide how adoption is measured: an additive inventory field recording `outputSchema` presence would require an inventory format bump, so first determine whether session-entry payloads already make adoption countable. Outcome: they do - session entries already persist `structuredContent` (recorded in the section intro and confirmed at runtime), so adoption per tool is countable by tallying session-entry payloads that include `structuredContent` against total successful entries for that tool; no inventory format bump is needed for adoption counting. A static inventory snapshot of `outputSchema` declarations remains unnecessary unless a future analysis needs to distinguish "declared but unused" cohorts from absent-tool cohorts.

Decision (revisitable): `project_command` returns the compact `projectCommandModelContent` projection as `structuredContent`, not the full `ProjectCommandOutputDetails`.

This differs from every other tool, whose `structuredContent` is the full details mirror, because `project_command`'s model-facing text is already the compacted, sanitized projection: the full details carry up to 48 KB per stdout/stderr stream plus internal metadata (fingerprints, policy and reuse policy ids, invocation and tool-call ids, durations, relevant inputs, scope, repository state) that the plan forbids adding beyond the model-facing text.

Mirroring the projection keeps `structuredContent === JSON.parse(content)` uniform, keeps the payload bounded for the heaviest tools, and keeps internal metadata out of script-visible content.

`verify` needs no such split: its model-facing text is already the full `VerifyOutput`, so `verifyOutputSchema` mirrors `details` exactly.

Both schemas describe the success path only; failures keep throwing.

The trade-off to revisit if scripts need it: codemode consumers of `project_command` see compacted streams (1,200 chars per stream) instead of full raw output, and cannot see timing or fingerprint metadata through `structuredContent` (those stay in `details` and session records).

Documented in `docs/project-command.md` ("Structured content contract") and `docs/verify.md`.

#### Constraints

- `structuredContent` never adds data beyond what the model-facing text already exposes; bounds, redaction, and authorization shape are identical on both paths.
- A tool that declares `outputSchema` always sets `structuredContent` on its success path; failures that carry no structured data keep throwing so scripts receive the error text.
- Adoption is per tool, not global: declaring the schema switches that tool's nested-call resolution from text to structured values.
- Token-tracker comparisons must show no model-facing regression in result shape or size.

#### Exit criteria

- Implemented tools resolve to typed values in codemode scripts, verified by an integration test per tool.
- Schema-conformance tests cover every result mode (success, truncation, unchanged, per-item errors) since no host-side enforcement exists.
- Model-facing text results stay unchanged for the same inputs.
- No new data crosses an authorized boundary through the structured path.

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
- [x] Decide whether the two workspace-block shapes should be unified, because `git-invocation` and `read-batch-invocation` use the shared envelope's `repositoryId`/`dirtyDigest` while `project-command-invocation` uses `repositoryIdentity`/`dirtyFilesDigest`. Decision: the producer shapes stay unchanged and the consumer closes the gap with a tolerant read; `subagent-herdr` `analysis/measure.ts` now extracts both `dirtyFilesDigest` and the envelope `dirtyDigest`, which the analyzer previously could not see.
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

### P1: Make the producer-consumer contract executable

The contract between artifact producers (Bash Tools, Codegraph Runner) and the orchestration consumer (`subagent-herdr`) is prose in `docs/artifacts.md` plus hand-written tolerant readers, and it leaks by construction.
A routine cross-repo audit found five vocabulary or shape mismatches, one silent extraction gap, and one field that no consumer read (`measurements`, since deleted in the Simplify evidence infrastructure Batch 4).
The mismatches are two workspace-block shapes (`repositoryIdentity`/`dirtyFilesDigest` versus envelope `repositoryId`/`dirtyDigest`), two publication vocabularies (`{ published, error }` versus `{ state, reason }`), two lookup-status spellings (`not-found` in records versus `NOT_FOUND` in the Codegraph Runner outcome mapping), and the analyzer field-name expectations tracked under Analyzer and importer handoff (`policySource` versus `decisionSource`, `repositoryStateStatus` versus `repositoryState.stateMatchesCurrent`).
The silent gap is `invocationStateDigest` in `subagent-herdr`, which could not see the envelope `dirtyDigest` and returned nothing instead of failing.
The lookup-outcome enum alone is defined in both extensions and twice inside `subagent-herdr`.
TypeScript types never cross a repository boundary, and consumer fallback chains absorb drift by returning `undefined` without failing anything, so the program below makes the contract executable: one machine-readable source of truth, tested from both sides, with counted runtime drift signals.

#### Stage 1: shared golden fixtures and bidirectional conformance tests

- [ ] Author a neutral fixture set of canonical JSON records: one record per type per format version (`project-command-invocation`, `git-invocation`, `read-batch-invocation`, `authorization-outcome`, `tool-inventory`), the tool-result `details` envelopes the consumer reads (including `resultCategory` and `executed`, which `subagent-herdr` `budget.ts` depends on and which carry no runtime schema today), and the `pc_`/`vr_`/`rr_` evidence envelopes.
- [ ] Decide where the fixture set is hosted before the shared package repository exists; an acceptable interim is a pinned copy in each repository with a cross-repo sync check, and the target is that fixtures ship inside the shared package.
- [ ] Add producer-side conformance tests asserting that every emitted record validates against and structurally matches its fixture, extending the `Value.Check` pattern already used for `structuredContent` to telemetry records and `tool_result.details`.
- [ ] Add consumer-side extraction tests with an explicit expected-extraction map per fixture, so a renamed or dropped field fails a test on one side instead of silently vanishing; the deleted `dirtyDigest` gap must be exactly the kind of failure these tests catch.
- [ ] Pin the consumer's accepted input variants (`payload` wrappers, snake_case keys, `tool` versus `toolName`, `repositoryState` versus `repository_state`) as tested shapes rather than accidental ones.
- [ ] Run the consumer conformance suite against producer fixtures on every change in either repository.

#### Stage 2: neutral protocol package in its own repository

- [ ] The shared package sits in a separate git repository that is not Bash Tools, not `subagent-herdr`, and not Codegraph Runner, so no producer depends on the consumer and every extension keeps its independence rules.
- [ ] At a future time, generate the instructions for its creation: a bootstrap specification covering repository layout, package manifest, typebox schemas per record type and format version, the shared enum constants (lookup outcomes, publication states, cache decisions, record format versions), the workspace-block schema with its nullable fields, the publication vocabulary, and the semver compatibility policy (additive field = minor, shape change = major). Generating those instructions is a later task; this plan item reserves it and nothing is implemented yet.
- [ ] Fold the duplicated vocabularies onto the single source: one lookup-outcome enum, one publication vocabulary, and one workspace-block shape whose legacy aliases are declared and tested instead of implicit.
- [ ] Converge publication on the `{ state, reason }` form that `subagent-herdr` already normalizes to, retaining the current Bash Tools `published`/`error` fields as a deprecated additive alias for a bounded window.
- [ ] Move the compatibility rule from `research/findings-1409-token-tracker.md` into the machine-checkable contract: additive and optional under a version, version bump only on shape change, enforced by schema diff.
- [ ] Keep tolerant reads of stored records a requirement: `pc_` version 1 normalization and `vr_` version 2 alias wrappers stay, and schemas govern emission and cross-repo exchange rather than historical storage.

#### Stage 3: runtime drift telemetry

- [ ] Count extraction misses in the consumer: a record that carries a `repositoryState` block from which no digest extracts, or an unknown `lookup.outcome` or publication value, emits a bounded `producerShapeMismatch` marker instead of silently returning `undefined`.
- [ ] Report mismatch counts in the next analyzer pass so contract drift appears in measurements instead of audits.

#### Ownership

- Bash Tools owns its producer records and the `rr_`/`pc_`/`vr_` evidence it mints.
- Codegraph Runner owns `cg_` artifacts and its own producer records.
- `subagent-herdr` owns its telemetry schema and its extraction layer; the contract boundary is producer records plus tool-result `details`, never the consumer's own telemetry format.
- The shared package is a neutral protocol dependency owned outside all three extensions, matching the evidence-contract ownership rule above.

#### Constraints

- Tolerant reads stay; the program adds fixtures, tests, and counters around them and never tightens reads of stored records.
- No extension imports another extension's modules; the shared package is protocol-level, not an implementation dependency.
- Producers never gain orchestration semantics, and Bash Tools does not become a generic artifact database.
- Fixture, schema, and telemetry work must not change any tool result, error wording, or authorization decision.
- Cross-repo consumer-side changes land through `subagent-herdr`'s own review, and producer-side changes through each producer's.

#### Exit criteria

- A field rename, removal, or vocabulary change on either side fails a test in every repository that consumes it.
- One machine-readable definition exists per record shape, enum, and vocabulary, and the schema diff makes the version-bump rule checkable.
- Drift that survives a release is visible as a counted signal in analyzer output.
- The shared package repository is created from generated instructions rather than by copying implementation code out of any extension.

### P1: Improve authorization outcome observability

Policy behavior remains fail-closed while providing structured evidence to distinguish correct blocking from subsystem failures and workflow churn.
Authorization outcomes are recorded as bounded `bash-tools.authorization-outcome` entries for every surface, and unchanged retries after persistent denials or confirmation timeouts are rejected as a distinct `unchanged-retry` failure without re-prompting or writing any policy decision.

- [ ] Evaluate child-session approval visibility only after measuring prompt and notification outcomes. (Gate satisfied: 786 of 788 decisions were automatic, exactly 1 prompt was emitted, and it timed out after 120,012 ms, so the evaluation is unblocked and nothing in the data suggests a prompt-visibility problem that warrants code changes.)
- [ ] Do not add automatic approval, implicit permission inheritance, or authorization bypasses to reduce failure counts.

#### Approval interaction and permission visibility (exploratory, no design yet)

Tracked direction, not committed work: approval notification handling and a permission overview surface.

- [ ] Improve approval notification handling by hooking into `subagent-herdr` events so approval requests and outcomes surface correctly across root and child sessions. Cross-extension: Bash Tools must not import from or depend on `subagent-herdr`, so this is a compatible event or notification contract between extensions, with Bash Tools owning only its own approval-authorization side and never adding automatic approval or bypasses.
- [ ] Evaluate a visual display of active permissions, globally and for the active workspace, so amendments to policy decisions can be made quickly. Shape is undecided; any write path must go through the existing policy store (lock, validation, fail-closed, same precedence), display must stay read-only until a designed amendment flow exists, and policy content must never leak into logs or telemetry.

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
- [x] Decide whether intercepted native `grep` defaults should change: `context >= 2` carries 14.7 MB of the 16.79 MB grep result total while `context: 0` has a median result of 627 B, so defaulting context to 0 and tightening the limit saves roughly 10 MB per week. This is a native-tool behavior change (interceptors can mutate `event.input`), so it needs an explicit task-success trade-off decision and should not ship silently. A global 8 KB result cap on native results remains closed by the interception determination; caps on Bash Tools-owned results already exist, and `project_command` measured fine at 2.50 MB total with a 2.2 KB p95. Decision (2026-09-15): bash-tools takes no action. Overriding native `grep` defaults from this package is rejected (the package must not add or shadow tool surfaces, and mutating native inputs for default injection would couple bash-tools to native tool schemas); if the roughly 10 MB per week saving justifies the task-success trade-off, ship it host-side in pi where the default belongs. Item closed for bash-tools scope.

### P1: Simplify evidence infrastructure

A fallow and source-level analysis found the disk-cache engine and canonical-JSON hashing well centralized, but the same wrappers and validators re-implemented per evidence family with drifting bounds, plus dead weight. The work is batched by risk: Batch 1 is zero-risk deletion, Batch 2 is contained refactoring, Batch 3 touches on-disk or analyzer-visible shapes and needs versioned format decisions. A single cross-family store abstraction is deliberately not planned: per-family fail-closed publish gating is the package's core safety surface.

#### Batch 1: zero-risk deletions and mechanical unification

- [x] Delete `compareWorkspaceBlocksCrossProducer` and its types from `src/evidence/repository-state-comparison.ts` with its tests, and trim the corresponding `docs/artifacts.md` section. `WorkspaceBlockStateStatus` and `compareWorkspaceBlocks` stay (live production importers); coverage was added for the surviving `compareWorkspaceBlocks`.
- [x] Delete the dead root-map branch in `ReadEvidenceStore`: the `root` map is never written, so the `flowId === undefined` paths in `getByRef` and `lookupOutcome` always return `undefined`/`missing`. The pc store's `root` map is real (runner lookups without flowId) and stays.
- [x] Reconcile the fallow dead-code list to 0 issues. Outcome: the four fallow-flagged symbols `isNullableBoundedInteger`, `isValidPublishValue`, `truncateRenderText`, `sharedEvidenceContentHash` turned out to have live production callers and stay; the actual dead set was un-exported (`TimedPromptResult`, the `ReadBatchInvocationLookupOutcome` type, read-evidence store/validation constants and types, `READ_EVIDENCE_REF_PREFIX` and its re-export) and two fully dead types were deleted (`GitInvocationSessionContext`, `ObservedContentStore`).
- [x] Collapse `SharedEvidenceOutputStream` into `SharedEvidenceOutputBlock`; `SharedEvidenceEnvelopeFields` was un-exported in the same pass.
- [x] Centralize the flow-id pattern (`^[A-Za-z0-9_-]{1,64}$`, 8 call sites) in `value-validation.ts` as `FLOW_ID_PATTERN` and `SHA256_PATTERN` in `envelope.ts`; JSON-schema `pattern:` string literals intentionally unchanged.
- Disposition on `lookupOutcome` `corrupt`: kept as-is and documented as in-memory-only via the store comment (the disk layer drops corrupt reads before classification, so the branch fires only on in-memory mutation); no taxonomy change.

#### Batch 2: contained deduplication, shapes unchanged

- [x] Shared `observability/bounded.ts` replaces the helper copies across `git-invocation`, `read-batch-invocation`, `project-command-invocation`, and `authorization-outcome`. Genuinely divergent variants stay local in `project-command-invocation` (empty-string `boundedOptionalIdentifier`, typed-input `boundedLookup`/`boundedPublication`, 16-item `boundedCoercions`, 12-reason `validReason`), and the field-by-field `boundedRecord` fallback stays explicit because the fallback deliberately omits `commandId`/`parameters`/`producerScope`; a JSON round-trip would widen the oversized-record persisted shape.
- [x] Generic flow-scoped two-tier evidence store factory at `src/evidence/flow-store.ts` replaces the duplicated wiring in `project-command/evidence/store.ts` and `filesystem/read-evidence-store.ts`; the pc store enables the real root tier (runner lookups without flowId), read-evidence keeps root-scope lookups constant `undefined`/`missing`; per-family fail-closed publish gating and disk interaction order are unchanged; the fallow clone family `dup:7c838253` is gone (dupes 0 clone groups).
- [x] `ProjectCommandOutputDetailsValidationProfile` unified at `src/tools/project-command/output-details-profiles.ts` with explicit per-profile deltas. Evidence-backed unifications: commandId 256 both (legacy variant strings up to 140 chars were being rejected on read), exit `null | 0..255` with nonempty signal (<=128) both, text 50KiB both, parameters <=128 keys / <=1MiB JSON both, diagnostic 50KiB both, suggestedAction 1024 both, resolvedCommand display cap both. Kept divergent on purpose: projectPathMaxLength 4096 vs 8192 (pinned test), `isRelevantInputs` shapes, nodeVersionMaxLength 128 vs 256, arrayMaxItems 256 vs 4096.
- [x] `project-command-invocation.ts` split into a facade plus `types`, `bound`, `build`, `summarize`, and `recorder` modules; verbatim moves with one shared-helper delegation, no circular imports, fallow dead-code 0.
- [x] Flow-scope gating consolidated onto `effectiveOrchestrationFlowId` at 8 sites (`runner.ts`, `read-batch-tool.ts`, `git/diff/cache.ts`, `evidence/store.ts`, `verify/cache.ts`, `verify/tool.ts`); requested-flow comparisons, producerScope assignments, and boolean-form gating remain divergent by design.
- Accepted type-surface narrowings (zero importers, compile-proven): the invocation facade no longer re-exports 7 type-only names, and the read-evidence store keeps `READ_EVIDENCE_FORMAT_VERSION`, `MAX_PUBLISHED_READ_EVIDENCE_ENTRIES`, `ReadEvidenceProvenance`, and `ReadEvidenceStoreOptions` module-private.

#### Batch 3: versioned shape changes (needs format decisions and analyzer coordination)

- [x] Verify disk records are now keyed by ref with a single write per record (disk format version 2 to 3): `set`/`publish` write the bare record once at the `ref:` location, request lookup derives the ref from the key's 24-hex prefix and requires a current-version record whose key matches (fail-closed on prefix collisions), and `getByRef` tolerantly reads both bare v3 records and legacy v2-era `ref:` alias wrappers, so existing `vr_` analyzer references keep resolving; v1 records miss. The `vr_` ref format, publish gating, and public error wording are unchanged. Known limitation: `writeRecord` has no write-time version validation, so publishing a legacy v2 source record (unreachable via the tool path) would persist an unreadable record - candidate follow-up.
- [x] Strip duplicated provenance and repository-state encodings from the `pc_` evidence record (`evidenceFormatVersion` 1 to 2): the pc record now carries `provenance` as the single producer identity, raw `repositoryState`, and envelope identity fields only; top-level `producerScope`/`flowId`/`producerRole`/`producerDelegationId`, the envelope `workspace` block, and envelope `scope` are gone. Strict v2 validation requires a valid `provenance`; `getByRef` tolerantly normalizes v1 records in memory (never persisted, fail-closed when unnormalizable); publish of a legacy source normalizes and writes strict v2. `mapEvidenceScope` was removed as dead, and the format constant collapsed to a single source in `record-validation.ts`. Model-facing details, session-entry payloads, ref/key derivations, and disk keys are unchanged. Accepted deviation: v2 reads bounds-check known envelope fields when present and ignore leftover dropped identity keys (mirroring the `vr_` v3 philosophy, marginally weaker there); design at `research/pc-evidence-dedup-design.md`.

#### Batch 4: cross-repo-verified dead weight

- [x] Delete the invocation `measurements` subsystem (`MeasurementPair`, `measurementPair`, `createProjectCommandInvocationMeasurements`, `boundedMeasurements`, the summary `measurementsBefore`/`measurementsAfter` aggregation, and the `measurements` record and summary fields). The per-record `before` half was structurally always zero and every `after` value duplicated `reused`, `cacheDecisions.invalidated`, `truncationCounts`, or `repeatedUnchangedRequests`. A cross-repo consumption check confirmed no reader in `subagent-herdr` (tool-result details in `src/metrics.ts`/`src/budget.ts` and the producer invocation stream in `analysis/measure.ts`), in the research reports, or on the analyzer consume list, so `invocationFormatVersion` and `summaryFormatVersion` bump 1 to 2 as shape changes with no coordinated importer update.
- [x] Un-export `projectCommandSchemaRejectionDetails`, which is module-internal only, closing the remaining fallow dead-code finding.
- [x] Single-source `CACHE_ENTRY_FORMAT_VERSION` in `cache/record-validation.ts` and `MAX_REPOSITORY_STATE_BYTES` in `repository-state/dirty-files.ts`, which were each defined twice with identical values.

#### Cache maintenance sweeps

- [x] Prune expired and over-capacity records across every flow directory both on session start and through a user-invocable command. Outcome: `pruneEvidenceCaches` in `src/evidence/cache-maintenance.ts` reuses `evictDirectory` (same seven-day age and 50 MiB per-directory caps) over every `flows/<flow-id>/<family>` directory under one global cache lock acquisition, deleting only `.json` records and leaving lock, claim, token, and other files untouched; session start runs one failure-soft pass with a 500 ms wall-clock budget, `/bash-tools-prune` runs the same pass with a 10 s budget and reports removed files and bytes, scanned directory count, reclaimed orphan temp files, time-budget truncation, and lock-busy skips. Because `writeRecord` creates and renames temp files only while holding the shared cache lock, any `<hash>.json.<pid>.<hex>.tmp` file observed by a locked prune pass is provably orphaned; the pass reclaims such files only when they are older than 60 s (defense in depth) and leaves everything else untouched. A `BASH_TOOLS_CACHE_ROOT` override (absolute paths only) relocates the cache root coherently for every durable cache surface and the maintenance passes. Verification: format plus lint plus full tests, `vr_93e9961c963b3526a07a9687`; Fallow audit vs base `d4204432`, `pc_6117a3351e7dfef4404a2bea` (0 dead-code introduced, 0 duplication added, only inherited complexity hotspots); dead-code `pc_b0beafebc549e6142aa47c6c` and duplication `pc_bcfdcb065ba5e823098b1585` with only the pre-existing `projectCommandSchemaRejectionDetails` finding; focused tests `pc_fc452f664a683442d022f998` (9 cache-maintenance cases plus 16 existing eviction tests plus the extension-factory command registration test).

#### Exit criteria

- No fallow dead-code findings, no fallow duplication introduced, and all gates stay green after each batch.
- On-disk evidence formats change only with explicit version bumps, and persisted analyzer-facing fields are never dropped without coordination.
- Fail-closed publish gating, per-family authorization semantics, and public error wording are unchanged.

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
