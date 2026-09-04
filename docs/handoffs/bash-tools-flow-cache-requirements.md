# Flow-scoped evidence sharing: requirements for `bash-tools`

Handoff from the `subagent-herdr` workspace. Written to be self-contained: it assumes no knowledge of the conversation that produced it.

Status: proposal, no code changed on either side.
Owner of this document: `subagent-herdr`. Owner of implementation: `bash-tools`.

## 1. Why this exists

A measurement window over 334 pi sessions (2026-08-26 to 2026-09-02, 38 root sessions, 296 child subagent sessions, 10,064 model steps, 14,139 tool calls) found that orchestration cost is dominated by context re-feeding rather than by the number of agents.

Two of the largest signals are `bash-tools` signals.

| Signal                  | Measured                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git_diff` output       | 4,279,168 result tokens from 547 calls, avg 7,823 tokens, p95 49,847, max 99,330; 22.6% of all tool-result text from 3.9% of all tool calls                                                                              |
| Duplicate diff pulls    | One root session fanned out ~20 children; each pulled the same working-tree diff at 51,773 to 99,330 tokens, including byte-identical repeats; ~1.42M tokens total, 20 of the 22 largest diff calls in the window        |
| `project_command` churn | 2,163 calls with 1,075 exact-duplicate excess calls, 49.7% of all calls to the tool and 69.1% of all duplicate calls in the window; one session issued 34 identical `node_lint` calls and 25 identical `node_test` calls |
| Cache defeat            | Repeated calls used `force: true` deliberately (20 `{"commandId":"node_lint","force":true}` and 19 with `force` as the string `"true"`), meaning agents worked around the result cache instead of trusting it            |
| Schema tax              | 130 validation errors and 24 resolution errors on `project_command`, plus 80 validation errors on `git_diff`                                                                                                             |
| Mechanical dead ends    | ~898 of 1,393 tool errors (6.4% of all calls) were tool-interface friction rather than real failures, each costing a wasted step plus a retry                                                                            |

Every model step in that window re-read about 68,134 cache-read tokens, so an avoidable duplicate call costs far more than its own output.

The root cause for the two big signals is structural. The result cache in `bash-tools/src/tools/project-command/cache.ts` is documented in its own source as "a deliberately process-local, session-scoped result cache. It has no restore or persistence path." Fan-out children are separate pi processes with separate caches, so N reviewers over one change pull and diff the same tree N times, and N validators mint N private fingerprints for the same repository state.

## 2. Contract that `subagent-herdr` will provide

We commit to this interface so you can implement against something fixed. It is additive and optional.

We will export orchestration identity into the environment of each subagent pi process we launch, and only into those processes:

| Variable                          | Value                                  | Stability                                                                                                              |
| --------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `PI_ORCHESTRATION_FLOW`           | Opaque flow id                         | Shared by every child of one root session, including later remediation attempts; the scope key for cross-child sharing |
| `PI_DELEGATION_ID`                | UUID v4                                | One per delegation, carried across reuse turns of the same subagent session                                            |
| `PI_ORCHESTRATION_ROLE`           | Agent name, e.g. `worker`, `validator` | Attribution only                                                                                                       |
| `PI_ORCHESTRATION_TIER`           | `0`..`4`                               | Informational                                                                                                          |
| `PI_ORCHESTRATION_MODE`           | `initial` or `remediation`             | Informational                                                                                                          |
| `PI_ORCHESTRATION_EVIDENCE_SCOPE` | `session` or `flow`                    | The widest evidence scope this child may use. Derived from role and tier; see R1a                                      |

Guarantees we give you:

- These variables are never set in a main interactive session, so absence is the normal case and must be the zero-change path for you.
- Values are opaque identifiers matching `^[A-Za-z0-9_-]{1,64}$`, safe to use as path segments after your own validation, except `PI_ORCHESTRATION_EVIDENCE_SCOPE` which is one of the two literal values above.
- Two decisions are already made and are not up for renegotiation in implementation: you own your store root (see R1), and evidence scope comes from the spawner environment with a narrowing-only parameter (see R1a).
- A flow id is never reused across root sessions, repositories, or workspaces.
- We never write into a `bash-tools` namespace, and we will document the store root we create.

What we ask you not to rely on: role semantics. `PI_ORCHESTRATION_ROLE` is for telemetry. Do not encode policy such as "validators may not lint" in `bash-tools`; role tool allowlists are enforced at spawn time by us via `--tools`.

## 3. Constraints to preserve

1. No dependency on `subagent-herdr`. Import nothing from it, and do not require it to be loaded. Consume the env contract and nothing else about us.
2. Keep the in-process cache as the default and as the fallback when no flow identity is present. Nothing may regress outside herdr or outside an orchestrated session.
3. Keep invalidation semantics producer-owned. Today `runner.ts` snapshots relevant inputs before and after execution and deletes the entry when the snapshots differ (`invalidateStaleEntry`, `snapshotAfterExecution`). Cross-process sharing must not weaken this.
4. Scope comes from the spawner, and a call parameter may only narrow it. We set `PI_ORCHESTRATION_EVIDENCE_SCOPE` to `session` or `flow` per child, derived from role and tier. The orchestration protocol requires that a validator can be prevented from inheriting a worker's cached result, and that a matching fingerprint is evidence reuse rather approval. If flow-scope reads become implicit or model-chosen, the validator silently stops being independent.
5. Preserve the decision vocabulary `miss | hit | forced | ineligible | invalidated`, and keep `force` working as a per-call escape hatch.
6. Cached command output is untrusted text that a different agent will read later. Entries need provenance, and a reader must never be able to hit an entry produced in another flow, repository, or working directory.
7. Keep canonical-JSON hashing and deterministic fingerprints; entries must be content-addressed so a stale key cannot match a changed tree.

## 4. Requirements

Priority is order of work, not importance. P0 items pay for themselves independently of anything we ship.

### R1 (P0) Flow-scoped result cache backend

Problem: the cache interface is `get(sessionId, logicalRequestKey)`, `set`, `delete`, `clear`, and the default is process-local. The parameter is named `sessionId`, but the value only needs to be a scope key.

Ask:

- [ ] Add a disk-backed implementation of the existing `ProjectCommandResultCache` interface, injected through the existing seam (`createProjectCommandExecute(..., cache = createProjectCommandResultCache())`, currently defaulted at `runner.ts:1143`).
- [ ] Scope the key prefix by flow when `PI_ORCHESTRATION_FLOW` is present, otherwise by session exactly as today. Mechanically this is choosing the namespace argument, not changing keys.
- [ ] Store the entry payload you already have (`logicalRequestKey`, `resultFingerprint`, `details`, `snapshot`, `producerInvocationId`) plus provenance: producing session id, producing role, flow id, repository identity, absolute working directory, HEAD, snapshot digest, and write timestamp.
- [ ] Persist under a root you own, for example `~/.pi/agent/bash-tools/flows/<flowId>/project-command/`, with your own config knob for the location. Do not write into a `subagent-herdr` directory; we keep orchestration artifacts only. Use `PI_ORCHESTRATION_FLOW` as a scope key, nothing more.
- [ ] Evict by age and size on your own schedule. `flows/<flowId>/flow.json` in our directory is an optional liveness hint you may consult, and must never be a required input or a reason to fail.
- [ ] Read across flows only through the scope rules in R1a, and never across repositories: a hit requires matching repository identity and absolute working directory.
- [ ] Use atomic replace plus an exclusive lock with stale-lock stealing, and tolerate a corrupt or unreadable entry as a miss rather than an error. Concurrent writers are the normal case: up to 8 subagents start at once.
- [ ] Add `producerScope: "session" | "flow"` to the output details and the invocation record, so a cross-process hit is distinguishable from a same-process hit.

Acceptance:

- Two separate pi processes in the same flow, same repository state, same `commandId` and parameters: the second returns `hit` with `producerScope: "flow"` and does not execute.
- A file change in one child causes a miss in the other, verified through the before and after snapshot comparison.
- No env: behavior, timings and output are byte-identical to today.
- Killing one process mid-write leaves the other processes working and degrades to a miss, never to a corrupt result.

### R1a (P0) Spawner-set evidence scope, narrowing only

Problem: if the model chooses whether to reuse another agent's cached evidence on each call, the guarantee is prose again, and prose measured 10x to 20x over documented budgets in the same window.

Ask:

- [ ] Read `PI_ORCHESTRATION_EVIDENCE_SCOPE` (`session` | `flow`) and treat it as the widest scope this process may use. Unset means `session`, which is today's behavior.
- [ ] If you expose a scope parameter at all, validate it as a narrowing operation: a request asking for `flow` when env says `session` is rejected or silently downscoped, and the decision is recorded.
- [ ] Record the effective scope on every invocation record, alongside the R7 join keys.
- [ ] Keep `force` working independently of scope, as a per-call fresh-run escape hatch.

Acceptance:

- A child launched with `PI_ORCHESTRATION_EVIDENCE_SCOPE=session` cannot receive a flow-scoped hit by any parameter combination.
- A child launched with `flow` can receive one, and the response says so via `producerScope`.

### R2 (P0) Bounded diff by default, stat-first, per-file hunk fetch, one snapshot per flow

Problem: `git_diff` requires `maxBytes` with `minimum: 1` and `maximum: MAX_CONTENT_BYTES` (`src/tools/git/diff/tool.ts`, cap `1024 * 1024` from `src/tools/git/output.ts`). There is no default and no summary mode, so the schema itself teaches agents that a large number is the safe choice: every one of the 547 calls in the window passed 200,000 to 1,000,000 bytes, and all 25 largest tool results in the window were diffs.

Ask:

- [ ] Make `maxBytes` optional with a default in the 8 to 16 KiB range.
- [ ] Add a summary-first mode returning `git status --porcelain` plus `git diff --stat` plus hunk headers (`@@` lines with function context), with no hunk bodies.
- [ ] Support fetching hunks for an explicit path list, so a caller gets full content only for files it actually reviews.
- [ ] When output is truncated by the default cap, return the stat plus per-file sizes and require a scoped retry, instead of returning a byte-sliced patch. `truncateUtf8` already reports `{ truncated, totalBytes, totalLines }`; surface it in the model-facing text, not only in structured details.
- [ ] Cache the working-tree diff summary by repository identity, HEAD, dirty-file digest, and staged flag, so N siblings in one flow share one snapshot through R1.
- [ ] Keep an escape hatch for the full patch, but make it explicit (for example `full: true` or an explicit large `maxBytes`) rather than the default.

Acceptance:

- The p95 `git_diff` result size drops by an order of countable margin, with no change to the reviewer instructions.
- A truncated response cannot be mistaken for a complete one: the model-visible text states the truncation, the total size, and the scoped follow-up to run.
- In a two-process fan-out, the diff summary executes once per distinct repository state.

Note: this requirement pays for itself with or without the orchestration work. It is the single largest token item available anywhere in the analysis.

### R3 (P0) `verify` composite with its own budget

Problem: the orchestration protocol requires validation evidence keyed to command, working directory, covered acceptance criteria, and a repository-state reference, and requires that evidence be reused only when those inputs are unchanged. No tool exposes a shared validation record, so each agent re-executes a full suite to mint a private proof. That is the mechanism behind the 1,075 duplicate calls and the `force: true` abuse.

Ask:

- [ ] Add a `verify` command that runs a composite in a fixed order, format check, lint, typecheck, then tests, with optional path scoping, and stops on the first failure by default with a `continueOnFailure` option.
- [ ] Cache the composite result on repository identity, HEAD, dirty-file digest, working directory, and the ordered list of resolved commands, reusing the R1 store.
- [ ] On a repeat call against unchanged state, return a compact result instead of a log: `{ status: "unchanged", ref, verdict, perStep: [{ command, verdict, exitCode }], failureTail }`, where `failureTail` is the bounded last lines of the failing step only.
- [ ] Never return full logs from the cached path. Cap the model-facing payload well under today's limit and keep the full output retrievable by ref.
- [ ] Give `verify` its own time budget. The current process defaults are `PROJECT_COMMAND_PROCESS_TIMEOUT_MS = 30_000` and `PROJECT_COMMAND_OUTPUT_LIMIT_BYTES = 50 * 1024` (`definitions.ts:10-11`), which cannot hold a format-plus-lint-plus-typecheck-plus-tests run. It needs a separate, configurable, longer budget with a per-step timeout, and the policy gate for it must be a single authorization rather than four.

Acceptance:

- A second `verify` with unchanged state executes nothing and returns `status: "unchanged"` with a ref.
- A single touched file invalidates the cache for the affected steps only if you can attribute steps to inputs; otherwise document full-composite invalidation and implement that.
- No `force` flag is needed to get a fresh run after a real change, so `force` stops being part of normal validation flow.

### R4 (P1) Tool-issued validation refs instead of agent-authored fingerprints

Problem: `V-###` references are currently free text authored by each agent, with no shared store, so they cannot be looked up and are re-minted per session.

Ask:

- [ ] Return a stable, short, opaque validation ref from every `project_command` execution that is cache-eligible, and from `verify`.
- [ ] Make the ref resolvable by a lookup mode (new command id, or a `ref` parameter) that returns the stored evidence without re-executing.
- [ ] Include in the resolvable payload: exact resolved command, working directory, HEAD, the repository-state digest you already compute via `projectCommandStateSnapshotDigest` (`state-snapshot.ts:195`), covered ids passed through opaquely, result, exit code, and timestamps.
- [ ] Accept an opaque `covers` parameter (for example `["AC-001","F-003"]`) stored verbatim with the record and returned verbatim, so `bash-tools` never has to interpret orchestration ids.
- [ ] Mark records non-reusable when no reliable state digest exists, matching the protocol rule that an unverifiable fingerprint must not be reused.

Acceptance:

- A worker can hand a ref to a validator, and the validator can resolve what ran, against what state, and what it covered, without re-running anything.
- No agent can forge a ref or make a record claim coverage it was not given.

### R5 (P0) Remove the schema tax

Problem: 130 validation errors and 24 resolution errors on `project_command`, 80 on `git_diff`, a 48.4% error rate on `git_log` (64 calls, 31 errors) and 19.2% on `git_status` (676 calls, 130 errors). Each is a wasted step plus a retry, and `edit` and `git_*` failures cost roughly three steps each to recover.

Ask:

- [ ] Coerce the literal strings `"true"` and `"false"` to booleans for boolean parameters, at least for `force`. 19 calls in the window failed on `force: "true"`.
- [ ] On a schema or resolution error, return the valid `commandId` list and the nearest match. `{"commandId":"node_format_check"}` appeared 12 times before the model self-corrected; a nearest-match hint makes that one call instead of two steps.
- [ ] Add regression tests proving colon-suffixed variant identifiers such as `node_format:check` are accepted by the `commandId` pattern, and that a legacy underscore form produces an actionable error naming the accepted form.
- [ ] Audit the `git_log` and `git_status` argument contracts and eliminate whatever produces the observed error rate. `git_log` errors were concentrated in an "other" category, which suggests the union schema is not self-describing; make the mutually exclusive shapes separate and name the violated constraint in the error.
- [ ] In `git_status`, stop accepting calls that will be discarded: 269 of 676 calls were exact duplicates, so the response should tell the caller what changed since their last call rather than reprinting the same status.

Acceptance:

- The recorded error rate for `git_log`, `git_status`, `git_diff`, and `project_command` drops by more than half, measured by your own invocation records.
- No validation error message is emitted without an actionable remediation line.

### R6 (P1) Actionable error payloads for `edit`, resolution, and policy

Problem: 157 failed `edit` calls, whose stored error text is tiny (p50 20 tokens, p95 37) and gives no candidate, no line number, and no signal distinguishing a zero match from an ambiguous match, so agents re-read the file and retry blind. Policy denials and path resolution failures are inconsistent dead ends: during that review `ls ~/.pi/agent` was denied while reading a file under `~/.pi/agent` succeeded, and the message did not say what was allowed.

Ask:

- [ ] On an `edit` failure, report the match count, distinguish zero from many, give the nearest candidate with a line number, and add an indentation-mismatch hint when the difference is whitespace only.
- [ ] Offer an optional dry-run preflight that validates `oldText` uniqueness without applying.
- [ ] On a path resolution error, return the nearest existing path.
- [ ] On a policy denial, return the authorized roots and the rule kind that produced the denial, in a stable machine-readable field.

Acceptance:

- A failed `edit` is recoverable in one step in the majority of cases, judged by whether a retry follows without an intervening `read`.
- Every policy denial names the allowed roots.

### R7 (P1) Join keys in observability

Problem: your invocation records are keyed by pi session id only, and the analyzer cannot attribute child cost to a delegation (296 children against 285 delegation links). Truncation is recorded as unknown for every call, so oversized-output analysis cannot distinguish a capped result from a full one.

Ask:

- [ ] Add `flowId`, `delegationId`, and `role` to the per-invocation record and the session summary in `src/observability/project-command-invocation.ts`, taken from env, absent when unset.
- [ ] Persist the truncation flag, total bytes and total lines you already compute in `output.truncated`, `totalBytes`, `totalLines` into the invocation record.
- [ ] Persist `repeatedUnchangedRequests` context: which request key repeated, so dedupe wins are measurable per command rather than per session.
- [ ] Add a per-record step count or batch flag if you can observe it, so "calls per model step" becomes measurable.

Acceptance:

- Your existing invocation records join to orchestration records on `delegationId` or `flowId` without transcript parsing.

### R8 (P2) Batch reads and read ETags

Problem: 1,279 intra-session excess `read` calls when range differences are ignored, 26% of all reads, and 72 byte-identical repeats; the same file appears twice under relative and absolute paths. 1.41 tool calls per model step means almost everything is one call per turn, and each avoidable turn re-reads ~68K tokens.

Ask:

- [ ] Add a batch read that takes a `paths` array (each optionally with a range) and returns bounded results per path with per-path errors.
- [ ] Return `unchanged` plus the prior ref when the same path and range were already served for the same content hash in the same scope.
- [ ] Normalize reported paths to repository-relative so downstream analysis stops double counting.

Priority is lower because R2 and R3 remove more cost per unit of work, and because our W6 read-manifest work removes part of the demand for this.

### R9 (P2) Curated read-only probe surface

Problem: the window recorded tool calls with hallucinated names (`exec`, `node_repl`, and a shell-argument `ls src src/lib ...` string) indicating the model reaching for shell introspection that the tool surface does not expose.

Ask: absorb that shape with one read-only probe covering file stat, directory listing, and git introspection, or make the existing surface discoverable enough that the guess does not happen. Include a "no such tool; here is the closest tool" response for unknown names where you can intercept them.

## 5. Explicit non-goals

- No role or workflow policy inside `bash-tools`. Role capabilities are enforced by the spawning extension.
- No implicit cross-role or cross-session cache sharing. Effective scope comes from the spawner environment and can only be narrowed per call (R1a).
- No persistence of raw environment, secrets, or command output beyond what a bounded record needs.
- No weakening of authorization, confirmation, or policy gates to make any of the above faster. If `verify` needs a broader budget, widen it deliberately and record it.
- No behavior change when the orchestration env is absent.

## 6. Verification we would like to see

- Fan-out test: two processes, same flow, same repo state, one `project_command` and one `git_diff` each, asserting one execution and one scoped hit.
- Invalidation test: mutate a relevant input in process A, assert process B misses.
- Isolation test: an entry from flow X or another repository can never be read by flow Y.
- Poisoning test: a manually crafted entry cannot claim a different working directory or HEAD than the one that resolves it.
- Fallback test: unset env produces byte-identical results to the current implementation.
- Budget test: a `verify` run that exceeds the current 30s and 50KiB defaults completes and returns a bounded failure tail.

## 7. Open questions for `bash-tools`

1. Can you reuse the existing `ProjectCommandResultCache` interface with the namespace argument widened, or do you want a separate persistence layer with its own interface.
2. What do you need from us to make `verify` authorization comfortable: one composed policy id, or one gate per underlying command.
3. Can you widen the timeout and output limits for `verify` alone, or do you want streaming output with a tail-only model payload.
4. Do you want the batch and ETag work in R8, given that R2 and R3 attack the same window signals harder.
5. Do you want a flow-end signal from us at all, or is TTL plus size eviction sufficient. We assumed the latter, which is why we only publish `flow.json` as an optional hint.
6. Should R1a downscoped requests be an error or a silent downscope. We have no strong preference as long as the effective scope is always recorded.

## Appendix A: code anchors referenced above

In `bash-tools`:

- `src/tools/project-command/cache.ts` - `ProjectCommandCacheDecision`, `ProjectCommandResultCacheEntry`, `ProjectCommandResultCache`, and the process-local default with its "deliberately process-local, session-scoped ... no restore or persistence path" comment.
- `src/tools/project-command/runner.ts` - `createProjectCommandExecute` with the cache default parameter, `lookupCacheEntry`, `invalidateStaleEntry`, `inspectCacheEntry`, `inspectResultCache`, `snapshotAfterExecution`, the cache `set` site, `setResultFingerprints`, `getContextSessionId`, `validateProjectCommandInput`, and `state.forced = validatedParams.force === true`.
- `src/tools/project-command/state-snapshot.ts` - `ProjectCommandStateSnapshot` with per-path sha256 `contentHash`, `projectCommandStateSnapshotDigest`, `equalProjectCommandStateSnapshots`.
- `src/tools/project-command/definitions.ts` - `PROJECT_COMMAND_NAMESPACE`, `PROJECT_COMMAND_PROCESS_TIMEOUT_MS = 30_000`, `PROJECT_COMMAND_OUTPUT_LIMIT_BYTES = 50 * 1024`, `fingerprintProjectCommandDefinition`.
- `src/tools/project-command/node/project-state/manifest.ts` - `NODE_SCRIPT_COMMANDS` mapping `node_test`, `node_build`, `node_lint`, `node_typecheck`, `node_format` to package scripts.
- `src/tools/git/output.ts` - `STRUCTURED_OUTPUT_LIMIT`, `MAX_RECORDS`, `MAX_CONTENT_BYTES = 1024 * 1024`, `validateIntegerLimit`, `truncateUtf8`.
- `src/tools/git/diff/tool.ts` - required `maxBytes` shared schema fragment, the `path` versus `paths` variants, `validateIntegerLimit(params.maxBytes, 1, MAX_CONTENT_BYTES, "maxBytes")`.
- `src/observability/project-command-invocation.ts` - per-invocation records and per-session summary with `invocationCount`, `cacheDecisions`, `repeatedUnchangedRequests`, `resultCategories`, `processStatuses`, `outputBytes`, keyed by `sessionManager.getSessionId()`.

In `subagent-herdr` (our side, for context only):

- `src/run.ts` `buildLaunchCommand` - composes the child command line (`--model`, `--tools`, `--append-system-prompt`) and is where the env export lands.
- `src/registry-store.ts` - the registry lock with stale-lock stealing, the model for the locking we will provide.
- `PLAN.md` sections "Flow store and identity contract" and "Workstream 7" - the consuming side of R3 and R4.

## Appendix B: baseline for measuring the wins

Numbers to compare against, from the same window, so improvement is measurable rather than asserted:

- `git_diff`: 4,279,168 tokens from 547 calls; p50 1,675; p95 49,847; p99 86,628; max 99,330.
- `project_command`: 2,163 calls; 728 errors; 1,075 excess duplicate calls; 130 validation and 24 resolution errors.
- `read`: 4,886 calls; 133 errors; 1,279 intra-session excess reads; 72 exact duplicates.
- `edit`: 1,879 calls; 157 errors (8.4%).
- `git_log`: 64 calls, 31 errors (48.4%). `git_status`: 676 calls, 130 errors (19.2%) with 269 duplicate calls.
- Tool errors overall: 1,393, of which ~898 are interface friction rather than real failures.

Caveat for whoever ranks this work: dollar attribution in that window is not reliable enough to rank by cost alone (2.3x computed-versus-reported divergence, 7.1% of steps with no computed cost, partially populated fresh-input totals). Rank by steps and tokens; treat cost as a tiebreaker.
