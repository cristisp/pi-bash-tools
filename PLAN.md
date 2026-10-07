# Plan: subagent-herdr

This file tracks only unfinished work and the decisions needed for future work.
Completed implementation history, review rounds, and superseded plans remain available in Git history and the analysis artifacts.

## S13: evaluate Pi 0.86.0-1.0.3 feature adoption

The installed Pi runtime is 1.0.3. The available changelog has releases 0.86.0, 0.86.1, 0.87.0, and 0.87.1, then resumes at 0.99.0; no 0.88-0.98 entries are present.
This is an adoption review, not a blanket migration: no general extension API break has been identified for the extension's current integration points.
The extension already uses UI-prompt events and per-tool `renderCall`/`renderResult`; do not duplicate them with newer renderer APIs.

### S13 candidate work items

- [x] **S13-001: Structured subagent results.** Evaluate `outputSchema` and `structuredContent` for the subagent tools so codemode and other programmatic callers can consume typed outcomes without parsing display text.
  Preserve the current model-facing text and avoid exposing private or unbounded result details.
  Implemented: `subagent` and `subagent_override` declare `outputSchema` and always attach a bounded `structuredContent` projection owned by `src/structured-result.ts` (mode, agent scope, and per-result label, outcome, status, stop reason, error, and usage; results capped with a `truncated` marker).
  Transcripts, stderr, read manifests, dirty paths, and internal metrics are excluded, the model-facing `content` is untouched, and tests validate the projection against the schema; the tools are registered directly because the installed pi 1.0.3 types include `outputSchema`, and the contract is documented in `docs/development.md`.
  Calls refused before any child runs are `isError: true` results whose model-facing text is unchanged and which carry a bounded `refusal` (kind plus capped message) in the projection, so programmatic callers cannot mistake a refusal for an empty success; informational responses such as agent and session listings stay normal results and stay text-only, reported as empty results in the projection instead of a new listing surface.
  `subagent_stats` and `subagent_close` stay text-only.
- [x] **S13-002: Tool exposure and permission metadata.** Evaluate `namespace`, `exposure`, and tool `annotations` for the subagent, override, stats, and close tools.
  Choose intentionally whether session-spawning tools are callable through `ctx.executeTool()` and whether permission extensions should treat them as destructive or read-only.
  These annotations are advisory and must not be treated as enforcement.
  Implemented as metadata only, with no runtime behavior change: all four tools declare `exposure: "direct"` explicitly, so they stay model-declared and callable through `ctx.executeTool()` and codemode scripts while they are active, and a session that excludes a tool through `--tools` or settings excludes it from programmatic callers too.
  `subagent` and `subagent_override` declare `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`; `subagent_stats` declares `readOnlyHint: true`, `idempotentHint: true`; `subagent_close` declares `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`; `openWorldHint` stays unset.
  No tool declares a `namespace` and `defaultActive` stays at its default, so the tools stay ungrouped and the model-facing toolset is unchanged; `test/tools.test.ts` pins the exposure, the annotations, the absence of a `defaultActive` override, and the absence of a namespace, and no code path reads annotations.
- [x] **S13-003: Nested tool-call accounting.** Pi 0.99 routes `ctx.executeTool()` calls through normal tool hooks and marks them with `parentToolCallId`, but does not add separate transcript entries for them.
  Decide whether nested calls should consume role budgets and how session statistics represent them, then test that the chosen policy neither double-counts nor bypasses enforcement.
  Implemented: nested calls consume the same per-role budgets.
  Pi 1.0.3 routes them through the same `tool_call`/`tool_result` hooks, so enforcement already applied to them and a codemode loop cannot bypass a budget; tests pin that a nested call over the limit is refused exactly like a model-issued call and that a nested failure is charged as a tool failure.
  `BudgetUsage.nestedToolCalls` records their share on the enforcement surface; transcript-derived metrics (`ExecutionMetrics.nestedToolCalls`, shown as `nested:N` in run summaries and `subagent_stats`) count each call exactly once from the bounded `nestedCalls` record the parent tool result carries, treating `complete: false` records as lower bounds.
  Double counting is structurally excluded: nested calls produce no transcript tool-call entries, and pi folds nested usage into the parent result message's `usage`, which the transcript accounting already reads.
  The added counter follows the same two-surface split as every other usage counter: the registry ledger counts hook-side calls per agent run and is never derived from transcript evidence, while `result.budget` is a report view rebuilt from transcript metrics and takes the count from the bounded `nestedCalls` records.
  For a single finished run the two agree (pinned by test); across several agent runs, or with enforcement inactive, they can differ, and the ledger remains the enforcement authority regardless of what the report view shows.
- [x] **S13-004: Agent finalization boundaries.** Evaluate whether `agent_before_settle` or actionable `turn_end` can improve budget or review finalization compared with the current abort/steer path.
  Adopt these boundaries only if they provide a bounded, loop-safe behavior with clearer validation evidence.
  Adopted one `turn_end`-derived boundary: once a run's report turn ends (no tool calls), later wall-time breaches are recorded for telemetry but no longer steer or abort.
  Previously such a breach queued a steer that bought a second, shorter report or relaunched a settled session; the gate is a per-run flag reset in `before_agent_start`, so it is bounded and cannot loop, and a test pins that the breach is kept while the session is neither steered nor aborted.
  `agent_before_settle` is deferred with runtime-verified rationale: it never fires after an abort, so it cannot improve the abort path; completed runs always end on the report turn, so there is nothing to salvage; and error outcomes are already bounded by pi's auto-retry, so continuing there would mostly buy a duplicate failure while delaying settlement.
- [x] **S13-005: Built-in tool and provider compatibility.** Audit whether Windows `powershell` calls receive the same budget and write-guard treatment as other implementation tools.
  Check configuration and preset guidance for Pi 1.0.3's `azure-openai-responses` to `azure` provider rename without adding an Azure-specific dependency to the extension.
  Audit result: no code change needed.
  `powershell` already receives exactly the same budget and write-guard treatment as `bash` (an ordinary tool call that is never discovery, implementation, or validation; neither shell takes the repository write guard), and regression tests pin that parity.
  The provider rename does not affect this extension: model presets store opaque `provider/model[:level]` specs and never interpret provider names; a regression test pins the renamed token as a valid spec.

### S13 scope and acceptance

In scope: `src/tools.ts`, `src/budget.ts`, `src/session-stats.ts`, `src/config.ts`, related tool rendering and documentation, and focused tests.
Out of scope: replacing separate child Pi sessions with `ctx.executeTool()`, adding custom providers or MCP servers, blanket migration to `registerToolRenderer()`, and pinning peer dependencies as part of this feature review.
Complete this workstream only after each candidate is either implemented with focused regression tests or explicitly deferred with its rationale.

Implementation status: S13-001 through S13-005 are implemented with focused regression tests.
A follow-up adoption decision landed after the review: the worker template now names pi's `codemode` built-in extension (the read-only roles do not, and `tool_search` is excluded from every role) because S13-003's shared-hook accounting removed the observability objection; the policy is documented in `docs/development.md` and pinned by template tests.

## S14: review-surface delta evidence

A reviewer must be able to compare rounds per file instead of re-deriving what changed.
The review surface was keyed by `git status` plus `git diff --stat` plus the head revision, so an edit that kept the same line counts and the same file set served a stale snapshot, and no earlier revision survived for a delta comparison.

- [x] **S14-001: Content-derived snapshot fingerprint.** Keep the status codes, the diff stat, and the git head, and add a bounded per-file SHA-256 for the first `MAX_DIRTY_PATHS` dirty paths, so a same-size, same-stat edit refreshes the revision; the diff stat stays in the fingerprint as the aggregate backstop for line-count changes, a capped binary delta of the worktree against the head makes the coverage complete for tracked content and permission changes, a digest of the hunk-header read joins the fingerprint like every other evidence read, and a hashing window that leaves a dirty path out is never reused.
  Untracked files are listed individually (`status --short -z --no-renames --untracked-files=all`) so a collapsed untracked directory cannot hide a change, and the NUL-separated read keeps paths verbatim, so a name git would C-quote in line mode (non-ASCII, quotes, backslashes) still hashes instead of degrading to an unreadable literal.
  Disabling rename detection keeps every status entry to one path: a rename is a delete plus an add and both sides stay hashable.
  A dirty symlink is hashed by its target string, so repointing it refreshes the revision even when the target bytes are unchanged.
  Files above `MAX_HASH_BYTES` are hashed as their first bytes plus a bounded tail window and their size and marked `(partial)`, and unreadable paths are marked `(unavailable)`, so the snapshot degrades instead of failing.
  Implemented in `src/scope.ts`; the snapshot lists the hashes in a `## File hashes` section and returns the fingerprint to the caller.
  Every git read runs from the repository root (`git rev-parse --show-toplevel`) because machine-readable status paths are root-relative, so a delegation rooted in a subdirectory still hashes the right files; the header records repository facts only, because the snapshot belongs to the flow rather than to one delegation.
  A failed git read of any kind, or an existing path that cannot be read, taints the fingerprint, and a tainted fingerprint is never reused, so a repeated failure cannot serve a stale surface as unchanged; a deleted path stays taint-free and does not churn revisions.
  The hunk-header read compares against the head like the stat and delta reads, so a staged change reaches that section, and a read that fails renders `(unavailable)` instead of looking like a tree without hunks; its digest is exposed in the header next to the worktree delta.
  Fail closed by outcome rather than by cause: any hash that stays `(unavailable)` for a path whose status code is not a deletion taints the fingerprint, so a path the snapshot cannot address (for example bytes that do not round-trip through the status read on filesystems that allow them) forces a refresh instead of being served as unchanged; such a path is refused rather than hashed, because its decoded name could address a different file.
  A hashing window that leaves a dirty path out - more than `MAX_DIRTY_PATHS` dirty paths, or a path beyond `MAX_DIRTY_PATH_LENGTH` - also taints, so a same-size edit past the cap can never keep the previous revision.
  The worktree delta is read as `git -c core.fileMode=true diff HEAD --binary --no-color` and the hunk headers as `git diff HEAD --no-color --unified=0`, and a read that fails or exceeds the read bound taints instead of silently hiding the change, which also keeps the revision fresh for a permission change on a file that is already dirty.
  A dirty path that is not a regular file - a submodule checkout's directory, or a tracked file replaced by a FIFO - has no readable content, so it counts as unreadable and refreshes on every delegation rather than opening something a FIFO would leave blocking; git neither lists nor tracks other non-regular files, so an untracked FIFO cannot reach the hash in the first place. That churn is the accepted fail-closed cost.
  The per-file hashes and diff stat are emitted before the status text, so the artifact size cap spends itself on the status text and hunk tail rather than the delta evidence.
  Residual bounds: an equal-size edit strictly between the head and tail windows of an untracked `(partial)` path is not covered by its hash, git-ignored paths are outside the snapshot by design, and so are changes git itself does not model - the permission bits of a clean tracked file, ownership, extended attributes, or an empty directory - because the snapshot describes what git reports for the worktree plus the bytes and permission bits of every dirty path.
- [x] **S14-004: Snapshot status mid-read race (accepted residual risk).** The clean-area-vs-hash consistency check resolves by re-reading the dirty status after the hash reads, so a change landing between the status read and the hash window is usually detected by the status re-check and taints the fingerprint.
  An equal-size edit strictly between those two reads can still hide: the hash covers only the bytes it saw, the status shows the file dirty either way for an already-dirty path, and no fault injection can deterministically reproduce the window.
  Accepted from the reviewer-68 review: the cost is an at-most-one-delegation-stale surface for an edit inside that window, and any later delegation re-reads status and refreshes the revision regardless.
- [x] **S14-002: Retained earlier revisions.** Before overwriting, copy the outgoing snapshot to `predigest/surfaces/review-surface-r<N>.md` and keep the newest `MAX_SNAPSHOT_HISTORY` (10) revisions.
  Retention is best-effort: an unusable history directory leaves the refreshed snapshot in place, and the read-only reuse path writes no snapshot revision (only the flow lock file is created and removed around the call).
  Accepted low-severity note from review: that lock is the flow's shared dispatch lock, so even a pure reuse serializes against other flow operations for the duration of the git reads; computing the fingerprint outside the lock is a possible future refactor, and no artifact byte, revision, or manifest output differs between the two paths.
  Implemented in `src/scope.ts`; `buildReadManifest` compares against `reviewSurfacePath()` instead of a literal path, cites the history directory with its retained count only when `retainedReviewSurfaceRevisions()` finds one, and states it as established evidence.
- [x] **S14-003: Digest linkage and path integrity.** The extension cannot observe the harness `dirtyFilesDigest`, so handoffs cite the gate digest from the validation evidence alongside the snapshot path, revision, and head; the fingerprint and the worktree delta and hunk digests live in the snapshot header, the hash list stays inside the snapshot artifact, and the delegation envelope and telemetry keep carrying only the surface path, revision, and head.
  Propagating the fingerprint itself into the envelope, report, and telemetry is deliberately deferred: those records already carry the surface path, revision, and head, the fingerprint stays in the snapshot header, and a new field would cross the report, telemetry, registry, and template contracts for little audit value.
  The same work fixed a pre-existing defect where dirty paths were parsed from a trimmed status line, corrupting a leading-space status code such as ` D path`; the displayed status now also keeps that leading space.
  Implemented and documented in `README.md` and `docs/artifacts.md`; `test/scope.test.ts` covers same-shape refresh, per-file hash stability, `(unavailable)` and `(partial)` paths, untracked directory listing, the truncated-window non-reuse rule, tainted-git-input refresh, a hunk-header read failure, an over-bound worktree delta, an isolated head-only change, unreadable-path refresh, over-long-path taint, a mode-only change to an already dirty path, an untracked file's mode, a dirty path that is not a regular file, a name that cannot round-trip, delta-evidence ordering, C-quoted-path hashing, symlink repointing, rename splitting, staged changes reaching the hunk section, root-relative subdirectory reading across delegation directories, forced-color parsing, bounded retention, retention failure, and manifest exposure.
  The scope tests also neutralize the developer's global git config and bound every git call: a global `commit.gpgsign` can block on a locked signing agent, which left the test repositories without the commit under test and hung the suite instead of failing it.

Implementation status: S14 is implemented with focused regression tests; primary review and five remediation rounds of review findings are addressed, and an independent validation pass plus a fresh from-scratch primary review approved it.

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
- All completed workfiles are committed: T-014, the S10 spawn boundary, S11, S12, S13-001/002/003/004/005 with the codemode/tool_search toolset policy, and S14 are committed and released (latest: `c91bcd4c`, 1.11.2).
- The S10 spawn-boundary item is implemented and review-clean (reviewer-47 remediation pass): subagent spawns whose cwd resolves outside the root session folder are refused before launch, including the reuse pane-recreation path.
- S11 evidence-reacquisition and Tier 2 finalization hardening is complete.
  The current `@ztc/bash-tools` 1.1.7 source confirms the `{ ref }` lookup contract and flow publication schema, and the fresh-process parent/child probe required by the completion gate was executed, so the gate is satisfied.
- S12 compact child-context handoffs are implemented and review-clean. They reduce unnecessary historical ledger and manifest discovery without changing role budgets, scope enforcement, or producer ownership. The final repository verification passed after the last remediation.
- S13-001 structured subagent results, the S13-002 tool metadata decisions, S13-003 nested tool-call accounting, S13-004 report-turn finalization, and the S13-005 audit are implemented on top of head `75dc5085`; the codemode/tool_search toolset policy landed as an S13-003 follow-up; all committed and released as `c91bcd4c` (1.11.2) after a clean primary review (reviewer-70) and a passing smoke test on the released extension.
- S14 review-surface delta evidence is implemented, passed primary review (reviewer-63) with its F-001 to F-006 findings remediated, and an independent from-scratch primary review (reviewer-68) returned PASS with no blocking findings; committed and released.

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

Current implementation status: the herdr-side focused and full package verification gates pass, including fresh-process manifest coverage. The current `@ztc/bash-tools` 1.1.7 source and tests confirm the minimal `{ ref }` lookup and flow publication contract.
The completion gate is satisfied: the required fresh-process parent/child probe was executed (a worker published a read ref into the flow and a sibling resolved it), and the probe artifacts under `test/tmp-*.test.ts` are pinned as regression coverage, so S11 is complete.

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

## S12: bound initial child context and use compact handoffs

The recent preload investigation found that fresh workers, planners, reviewers, and validators commonly began by reading the full append-only orchestration ledger or its manifest guidance before reading task-specific source.
The opening task prompts were narrow, but the first repository actions were often broad historical reads.
The ledger and manifest provide valuable provenance and scope safety, so this workstream must reduce unnecessary preload rather than remove those artifacts.
This workstream belongs in `subagent-herdr`; it does not require changes to `@ztc/bash-tools`.

### S12 acceptance criteria

- **S12-001:** Normal worker, planner, reviewer, validator, and scout handoffs provide a compact current context and do not instruct the child to read the full historical ledger before task-specific discovery.
- **S12-002:** The append-only ledger, read manifest, allowed-path boundary, report paths, known evidence refs, and workflow mode remain available for audit or bounded recovery.
- **S12-003:** Validator and remediation guidance permits bounded ledger or manifest reacquisition only when evidence is stale, rejected, ambiguous, or otherwise required by the task.
- **S12-004:** Fresh and reused sessions receive the same context policy, without inheriting stale prompt instructions from an earlier task.
- **S12-005:** Compact handoffs preserve the current task, acceptance criteria, finding IDs, scope, out-of-scope paths, evidence state, and final-state validation requirements.
- **S12-006:** Tests verify the prompt policy and preserve scope, manifest, ledger, evidence, and finalization behavior.
- **S12-007:** Telemetry or reports identify whether a delegation used compact, bounded-recovery, or full-context guidance, without changing call or validation budgets.

### S12 scope and ownership

In scope:

- `src/run.ts` for fresh and reused child prompt assembly and launch handoffs.
- `src/ledger.ts` for bounded ledger guidance and current-revision handoff data.
- `src/manifest.ts` for compact manifest summaries and recovery-only manifest guidance.
- `src/templates.ts` and `src/orchestration-guide.md` for role-specific context policy and generated child instructions.
- `src/types.ts` or related internal types if the context policy needs an explicit typed representation.
- Relevant tests under `test/`, plus focused documentation describing the handoff policy.

Out of scope:

- `@ztc/bash-tools` producer behavior, schemas, evidence stores, and lookup contracts.
- Removing the append-only ledger or the read manifest.
- Weakening filesystem policy, scope enforcement, manifest publication safety, or finalization protection.
- Increasing worker, planner, reviewer, scout, or validator budgets.
- Changes to `indicatori` or any other application repository.
- Manual edits to installed agent copies or generated files under `~/.pi/agent/agents/`.

### S12 implementation sequence

1. Record the current prompt assembly for fresh and reused sessions.
   Identify which role and workflow fields are already present in the compact task handoff and which are supplied only through ledger or manifest guidance.
2. Define an internal context policy with at least `compact`, `bounded-recovery`, and `full` modes.
   Use `compact` for ordinary role dispatch, `bounded-recovery` for stale or ambiguous evidence recovery, and `full` only for an explicitly justified audit or integration task.
3. Update `writeAgentTempFiles`, `ledgerPrefixBlock`, `manifestGuidance`, and the related prompt assembly so ordinary children receive current dispatch data without a full-ledger preload instruction.
   Keep report paths, known refs, scope paths, out-of-scope paths, workflow mode, and finalization requirements explicit.
4. Update `src/orchestration-guide.md` and the source templates so the generic guidance agrees with the context policy.
   State that a failed evidence lookup is `NOT_RUN` and that source reacquisition is bounded, without requiring a historical ledger reread first.
5. Apply the same policy to `launchFreshAgent`, `runReusedAgent`, and any pane-recreation or remediation handoff path.
   A reused session must receive a fresh task handoff and must not rely on instructions from its previous task.
6. Add bounded current-revision or current-tail recovery guidance for validators and remediation workers.
   Do not expose a producer-store fallback or require children to enumerate flow directories.
7. Add compact context telemetry to the delegation record or report.
   Record the selected context mode and, where the existing session tail supports it, whether the first discovery action was in scope.
8. Run focused prompt, ledger, manifest, scope, and launch-path tests, then run the repository verification suite.
   Compare post-change useful-work telemetry before considering any future budget adjustment.

### S12 test matrix

- `test/templates.test.ts`: ordinary roles receive compact handoff guidance, stale evidence gets one bounded recovery path, and no normal role is told to read the full historical ledger first.
- `test/ledger.test.ts`: current-revision and bounded-tail guidance preserves ledger provenance and does not alter append-only serialization.
- Manifest and scope tests: compact summaries retain allowed paths, out-of-scope paths, known refs, publication provenance, and ambiguity checks.
- Launch and reuse tests: fresh, reused, remediation, validator, and pane-recreation paths select the intended context mode and refresh the task handoff.
- Report or telemetry tests: context mode and any available first-discovery classification are bounded, stable, and separate from tool-call and validation budgets.
- Regression coverage: failed, stale, unauthorized, and cross-flow evidence lookups remain `NOT_RUN`, and final-state validation requirements remain unchanged.

### S12 completion gate

Do not mark this workstream complete until all of the following are true:

1. Ordinary child handoffs no longer require a full historical ledger read before task-specific discovery.
2. Scope, manifest, report, evidence, and finalization safety boundaries remain intact.
3. Fresh and reused sessions use the same compact-context policy and do not inherit stale instructions.
4. Bounded recovery remains available for stale, rejected, ambiguous, or cross-flow evidence.
5. Focused tests and the full repository verification suite pass.
6. Post-change telemetry shows the context policy without justifying a budget increase from this sample alone.

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
