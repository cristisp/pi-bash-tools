# Bash Tools Plan

## Status

This plan is adapted from the 2026-10-12 handoff (`bash-tools-2026-10-12.md`), which was derived from transcript-based analysis in the subagent-herdr repository (`analysis/context.ts`) with a frozen baseline at `analysis/baselines/2026-10-12-pre-context-pack.md`.

The baseline window starts 2026-09-03, covers 736 child delegation turns, and was captured with `@ztc/bash-tools` 1.1.16 installed.

The previous plan's completed work items and their evidence live in the repository history.
Its still-open topics are carried over in compact form at the end of this document.

The cross-extension ordering precondition is satisfied: subagent-herdr has implemented its P1 (stop consuming `rr_` and `pc_` evidence) and it is live, so bash-tools can now retire the producer side.

## Why

Cross-session evidence transport was built to cut the cost of subagents rebuilding context.
The data shows it does not.

- `rr_` read evidence: 118 refs published to a flow, 0 lookups resolved by a sibling.
  A lookup re-reads and returns the same bytes, so even a successful lookup costs the same tokens as a fresh read.
- `pc_` command evidence: no role consumes it, and package-script results use `reusePolicy: "never"`.
- `vr_` verify evidence: lightly used, but it is the only mechanism that turns a model's "tests pass" into checkable evidence; it stays.

Subagent-herdr is replacing cross-session context transport with an explicit context pack that it renders into the child's first message.
That needs no producer support.

Every agent pays for the evidence fields in every tool listing (`ref`, `flowId`, `covers`, `publish`, and the split execution and lookup shapes on three tools), so removal also shrinks prompts.

## Order and compatibility

1. subagent-herdr stops consuming `rr_` and `pc_` (its P1). Done and live.
2. Then bash-tools removes the producer side (B1, B2).
3. B3 can land independently; subagent-herdr P2 removes its `publish` instructions after B3 ships.
4. B4 and B5 are independent of the orchestration work and also benefit sessions without subagents.

## Active work

### B1: Retire `rr_` flow publication and lookup on `read_batch` (done)

- [x] Remove `publish` and the lookup request shape (`ref`, lookup-only `flowId` and `covers`) from `read_batch`; retired fields are rejected with `invalid-request`.
- [x] Remove the published `rr_` flow store, its bounds, its lookup-outcome telemetry, and the read-batch `publication` invocation block; invocation record format bumped to 2.
- [x] Keep `contentHash` on every successful item, the process-local `unchanged: true` repeat response, and the read observation that powers `edit-stale-context`.
- [x] Per-item `rr_` reference retired: the `contentHash` identifies unchanged repeats, and nothing can resolve a `rr_` ref anymore.

Outcome: `read-evidence-store.ts`, `read-evidence-lookup.ts`, and `read-evidence-validation.ts` are deleted; the per-item cache now maps request keys straight to content hashes. The shared envelope still accepted the `read-batch` kind but no producer emitted it; the envelope shrank once B2 landed.

### B2: Retire `pc_` flow publication and lookup on `project_command` (done)

- [x] Remove `publish` and the lookup request shape from `project_command`; retired fields (`ref`, `flowId`, `covers`, `publish`) are rejected with `invalid-request`, including explicit `null` placeholders.
- [x] Remove `ref` and `publication` from model-facing content so models stop trying to resolve them; the deterministic `pc_` identifier stays in details, error messages for failing or cancelled executions, and invocation records for auditing.
- [x] Remove the flow-scoped project-command store and its lookup-outcome telemetry; `optionalNullable` moved to the verify schema, and the shared envelope shrank to the `verify` kind only.

### B3: Publish `vr_` automatically inside a flow (done)

- [x] When the orchestration environment resolves a valid flow with flow evidence scope, publish completed verify evidence to it without a `publish` parameter; outside a flow, behavior is unchanged.
- [x] Remove the `publish` parameter from `verify`; retired fields (`publish`, lookup-time `flowId`) are rejected with `invalid-request`, including explicit `null` placeholders.
- [x] Keep the `{ ref }` lookup and derive the lookup flow from the environment only; lookup-time `flowId` and `covers` are dropped.
- [x] Keep repository-state comparison (`repositoryStateStatus`) exactly as it is; consumers depend on it.

Outcome: publication is keyed on the same effective flow scope as every other flow-evidence behavior (`PI_ORCHESTRATION_FLOW` plus `PI_ORCHESTRATION_EVIDENCE_SCOPE=flow`). Auto-publish is best-effort: an unstable run records `publication` with `published: false` and a bounded error instead of throwing `publication-failure`, and re-publishing equivalent evidence to the same flow is an idempotent success that preserves the first published record. End-to-end worker/reviewer coverage lives in `test/verify/tool.test.ts` (auto-publish in a flow seat plus `{ ref }` lookup).

### B4: Dedupe repeated native `read` calls within a session (done)

Same-turn repeats of an unchanged, overlapping range cost about 2.2M estimated tokens in the baseline window: root sessions 1,148,135, reviewers 655,000, workers 363,985, planners 41,927.
These are reads of a range the same session had already read, with no edit, content-hash change, or compaction in between.

- `read_batch` already answers such repeats with `unchanged: true`; native `read` does not.
- [x] Confirm the API: a `tool_result` handler can replace a native `read` result (the `tool_call` interceptor can only block), so the replacement path is implemented and no telemetry-only fallback is needed.
- [x] Answer an exact repeat (same session, same path, same `offset`/`limit`, identical returned content hash) with a short unchanged notice naming the earlier read; the observation is keyed by session id so concurrent sessions never share it.
- [x] Reset the observation on session start, switch, fork, and shutdown, and after every completed compaction; write/edit/move/delete safety needs no invalidation hooks because any content change makes the next read hash differ, so a stale dedupe cannot fire.
- [x] Bounded and fail-closed: 8 sessions, 256 entries per session; nested calls, error results, image results, and results without a session id are never replaced; every internal failure passes the original result through.
- Measure with this repository's analyzer: the `repeat` column of the file re-read table per reader; replaced repeats are visible in transcripts under the stable notice prefix `Unchanged repeat:`.

### B5: Make range reads the easy path for weaker models

Whole-file read share by role and model in the baseline (share of read tokens from requests without a line range):

| role     | gpt-5.6-luna | glm-5.3-flash | deepseek-v4.1-flash | deepseek-flash | qwen3.8-flash-next |
| -------- | -----------: | ------------: | ------------------: | -------------: | -----------------: |
| worker   |           0% |           64% |                 72% |            59% |                65% |
| reviewer |           0% |           69% |                 46% |            59% |                44% |

Flash-model workers also make 36-46 model calls per turn against 21 for `gpt-5.6-luna`.

Suggested experiments, measured before committing to any of them:

- [x] Tool-description guidance on `read_batch` that names the pattern "fetch known files once, with ranges": the B1 description rewording already carries it, and this pass sharpened it to "Fetch known files once, and use bounded ranges for large files instead of repeated whole-file reads."
- [x] An informational suffix on a whole-file native `read` of a large file pointing to ranged `read_batch`, without blocking the read: whole-file reads returning at least 32,768 bytes of text, and whole-file reads the native tool truncated, get an appended one-line hint. `structuredContent` is preserved so programmatic callers are unaffected, ranged/error/image/nested results never receive the suffix, and the B4 repeat dedupe observes the pre-suffix content, so the hint never breaks repeat detection.
- Measure with this repository's analyzer: whole-file read share per role and model after a window with both experiments live, plus the suffix appearance rate; money per turn at equal outcomes decides whether the suffix and the description wording stay, change, or go.

Do not block whole-file reads: many are legitimate, and the analyzer cannot yet separate those from waste.

## Out of scope

- Policy, authorization, and filesystem rules are unchanged.
- The Git tools' local identity fields (`head`, `dirtyFilesDigest`) stay; no cross-process Git references are needed.
- The shared evidence envelope can shrink to what `vr_` still needs once B1 and B2 land; that cleanup is bash-tools' call.
- Standing package rules from `AGENTS.md` continue to apply: no new command surface, no dependence on `subagent-herdr`, bounded and fail-closed behavior preserved.

## Verification

- Repository gates: format, lint, tests (typecheck is included in `lint` via the Oxlint TypeScript plugin, so the `verify` typecheck phase is omitted).
- End to end: a subagent-herdr flow where a worker runs `verify` without `publish` and a reviewer resolves the ref with `{ ref }`.
- Measurement: subagent-herdr's `npm run test:analyze` after its version stamp (its PLAN P0) ships, compared per role, provider, and model against the frozen baseline; money per turn at equal outcomes is the deciding metric.

## Carried-over topics from the previous plan

Open topics from the previous active plan, retained as context for later passes.
Details, decisions, and evidence for completed items are in the repository history.

- Deferred tool exposure evaluation for `git_log` and `git_show` against `tool_search` discovery.
- Per-cohort recomputation of error rates, duplicates, result volume, latency, cache decisions, and evidence reuse, including the `verify`-versus-`project_command` execution separation and Git patch-after-summary sequences.
- Analyzer consumption of newly recorded fields (`decisionSource`, repository-state naming, read-batch consumer attribution, project-command phase split) and the `edit-stale-context` hit rate.
- Discovery substitution analysis for Codegraph versus text-search and read workflows.
- Producer-neutral evidence contract: cross-producer lookup-outcome harmonization with Codegraph, and the shared golden fixtures plus consumer-side conformance program from the executable-contract work.
- `read_batch` per-item error results that name the failing requested path instead of a marker.
- `read_batch` digest-on-repeat (compact digest line instead of full content on hash-matching repeats), which overlaps B4 and should be sequenced with it.
- Structured result code for `project_command` confirmation timeouts.
- Authorization observability: child-session approval visibility, approval notification contract with subagent-herdr, and a read-only permission overview surface.
- Deterministic edit diagnostics: decide whether evidence-backed staleness detection should be reachable in practice given the dormant observation path.
- Verify evidence correctness and adoption: identity inputs, mutating-variant drift comparison, timeout guard relationships, and distinct counting of incomplete, stale, and lookup-only outcomes.
- P2 shadow-mode reuse evaluation, including the explicit decision on whether any deterministic command class may become reusable, and the advisory duplicate-execution marker that was deferred into it.
- Filesystem path-resolution failure reason breakdown per cohort.
- Deferred work items (read-only probe surface, TOON-style serialization, no-environment fallback confirmation, helper test depth, Linux policy tests, value-validation fan-in) remain deferred.
