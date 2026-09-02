# Bash Tools Implementation Plan

## Status

This plan supersedes the previous roadmap in this file.

The current implementation scope is limited to R5 and R2 from `docs/handoffs/bash-tools-flow-cache-requirements.md`.

Do not begin implementation of R1, R1a, R3, R4, or R7 until the current scope has been completed and reviewed.

The R2 behavior that depends on the R1 persistent cache is explicitly deferred until the R1 work is authorized.

## Context and measured priorities

A measurement window over 334 Pi sessions found that orchestration cost is dominated by repeated context and tool-result output rather than by agent count.

The largest relevant signals are oversized `git_diff` results and repeated `project_command` executions.

The baseline for this work is:

- `git_diff`: 547 calls, 4,279,168 result tokens, p95 result size of 49,847 tokens, and a maximum of 99,330 tokens.
- `project_command`: 2,163 calls, 1,075 excess duplicate calls, 130 validation errors, and 24 resolution errors.
- `git_log`: 64 calls with 31 errors.
- `git_status`: 676 calls with 130 errors and 269 exact duplicate calls.
- Tool errors overall: 1,393, of which approximately 898 were interface friction rather than real command failures.

Rank improvements by steps and tokens first.

Treat dollar attribution as a tiebreaker because the source measurement is not reliable enough for cost-based ranking.

## Non-negotiable constraints

- Do not import from or depend on `subagent-herdr`.
- Consume orchestration information only through the environment contract when that work is eventually enabled.
- Do not add role or workflow policy to `bash-tools`.
- Do not weaken authorization, confirmation, filesystem, or command policy gates.
- Preserve existing behavior when orchestration environment variables are absent.
- Keep cached or summarized output bounded and distinguishable from complete output.
- Preserve the existing `project_command` cache decision vocabulary: `miss`, `hit`, `forced`, `ineligible`, and `invalidated`.
- Keep command-definition fingerprints separate from result-reuse fingerprints.
- Treat command output as untrusted text and do not retain unnecessary source content, environment values, secrets, or full logs.

## Immediate implementation sequence

### Phase 1: R5 schema and interface friction

#### Project-command validation

- [ ] Normalize the literal strings `"true"` and `"false"` to booleans for boolean parameters, at minimum `project_command.force`.
- [ ] Preserve normal boolean validation for all other values.
- [ ] Keep `force` as a per-call fresh-run escape hatch and do not include it in semantic request fingerprints.
- [ ] Include the valid `commandId` set in project-command schema and resolution errors.
- [ ] Include the nearest valid command identifier when a requested identifier is close to a supported value.
- [ ] Make the nearest-match suggestion deterministic.
- [ ] Add an actionable remediation line to every validation and resolution error.

#### Command variant compatibility

- [ ] Add regression coverage proving that colon-suffixed identifiers such as `node_format:check` are accepted by the command identifier contract.
- [ ] Ensure the legacy underscore form produces an actionable error naming the accepted colon-suffixed form.
- [ ] Verify that package-script variant validation remains consistent with the command identifier pattern and package manifest mapping.

#### Git-log and Git-status contracts

- [ ] Audit the public and runtime argument contracts for `git_log` and `git_status` against the observed failure cases.
- [ ] Represent mutually exclusive `git_log` request shapes separately where the current union is not self-describing.
- [ ] Name the violated constraint and the accepted shape in each relevant error.
- [ ] Ensure invalid Git requests identify the field or shape that must be corrected.
- [ ] Investigate the observed `git_log` and `git_status` error categories before changing successful request behavior.
- [ ] Add regression tests for each corrected failure shape.

#### Duplicate Git-status requests

- [ ] Detect an unchanged repeated `git_status` request within the supported scope.
- [ ] Return a compact unchanged indication and the relevant prior reference or metadata instead of blindly reprinting identical status output.
- [ ] Preserve an explicit way to request fresh status when needed.
- [ ] Keep duplicate suppression independent from authorization and filesystem policy.
- [ ] Do not introduce cross-process persistence as part of R5.

#### R5 acceptance criteria

- [ ] Error rates for `project_command`, `git_log`, and `git_status` decrease by more than half in the added invocation measurements.
- [ ] `git_diff` validation errors decrease by more than half after the R2 schema changes are included.
- [ ] No validation error is emitted without an actionable remediation line.
- [ ] A string boolean supplied for `force` follows the same execution and cache semantics as the corresponding boolean value.
- [ ] Invalid command identifiers identify valid alternatives and provide a nearest match where one exists.
- [ ] Existing authorization and successful result shapes do not regress.

### Phase 2: R2 bounded and summary-first Git diff

#### Request contract

- [ ] Make `maxBytes` optional for `git_diff`.
- [ ] Use a default between 8 KiB and 16 KiB, selected and documented as a stable constant.
- [ ] Retain the existing upper bound for explicit full-patch requests.
- [ ] Preserve the legacy single `path` form while continuing to recommend the `paths` array for new path-scoped requests.
- [ ] Add an explicit summary-first mode.
- [ ] Add an explicit full-patch escape hatch, such as `full: true` or an explicitly requested large `maxBytes`.
- [ ] Keep the request shapes mutually clear and reject conflicting path or output-mode parameters with actionable errors.

#### Summary mode

- [ ] Return `git status --porcelain` data, `git diff --stat` data, and hunk headers containing `@@` lines with function context.
- [ ] Do not include hunk bodies in summary mode.
- [ ] Keep summary output bounded independently from full patch output.
- [ ] Include enough per-file information for a caller to choose a scoped follow-up.
- [ ] Support fetching full hunks for an explicit path list so reviewers can retrieve only the files they are reviewing.
- [ ] Preserve staged versus worktree selection in every mode.

#### Truncation behavior

- [ ] Continue using the existing UTF-8-safe truncation metadata: `truncated`, `totalBytes`, and `totalLines`.
- [ ] Surface truncation in model-facing text rather than exposing it only in structured details.
- [ ] When the default cap is exceeded, return the summary, total output size, and per-file sizes where available.
- [ ] Do not return a byte-sliced patch that could be mistaken for a complete diff.
- [ ] State the scoped follow-up required to retrieve additional hunks.
- [ ] Ensure the full-patch escape hatch is explicit in the rendered call and response metadata.

#### Summary cache boundary

- [ ] Define the summary cache key as repository identity, absolute working directory, HEAD, dirty-file digest, and staged state.
- [ ] Keep the cache key content-addressed and deterministic.
- [ ] Do not implement the disk-backed cross-process backend during this phase because that belongs to R1.
- [ ] Once R1 is authorized, route the summary through the R1 store so separate processes in one permitted flow can share one snapshot.
- [ ] Ensure a changed working tree cannot reuse a prior summary.

#### R2 acceptance criteria

- [ ] The default `git_diff` result size is reduced by an order-of-countable-margin relative to the baseline.
- [ ] A truncated response explicitly states that it is incomplete, reports the total size, and gives a scoped follow-up.
- [ ] Summary mode contains status, stat, and hunk headers without hunk bodies.
- [ ] Explicit path-scoped retrieval returns only the requested file hunks.
- [ ] Full patches remain available only through an explicit request.
- [ ] Staged and unstaged results remain correct and distinct.
- [ ] The no-environment path preserves existing behavior except for the intentionally changed R2 default and response contract documented by this plan.

### Phase 3: Focused validation and measurement

- [ ] Add unit tests for boolean normalization, nearest command matching, command-shape errors, diff-mode validation, truncation text, and summary parsing.
- [ ] Add integration tests for `git_diff` summary, staged output, explicit path hunks, full-patch escape hatch, and truncation.
- [ ] Add regression tests for malformed `git_log` and `git_status` requests.
- [ ] Add tests proving that existing authorization and confirmation gates still run before command execution.
- [ ] Run focused tests for every changed module.
- [ ] Run the complete test suite.
- [ ] Run the project lint script, which includes TypeScript checking through the Oxlint TypeScript plugin.
- [ ] Run the formatter check without rewriting unrelated files.
- [ ] Inspect the final Git diff for accidental policy, authorization, or unrelated contract changes.
- [ ] Record before-and-after invocation measurements for validation errors, duplicate status calls, diff result sizes, truncation, and scoped follow-up usage.

## Deferred workstreams

The following requirements are acknowledged but are not part of the current implementation batch.

### R1: Flow-scoped result cache backend

- [ ] Add a disk-backed implementation of the existing `ProjectCommandResultCache` interface.
- [ ] Use the existing namespace argument as the scope key, with a flow namespace only when a validated flow identity is present.
- [ ] Keep the process-local cache as the default and no-environment fallback.
- [ ] Store provenance including producing session, role, flow, repository identity, absolute working directory, HEAD, snapshot digest, and write time.
- [ ] Use atomic replacement, exclusive locking, stale-lock stealing, corruption-as-miss behavior, and bounded age and size eviction.
- [ ] Prevent hits across repositories or absolute working directories.
- [ ] Add `producerScope: "session" | "flow"` to details and invocation records.
- [ ] Add separate-process, invalidation, isolation, poisoning, and interrupted-write tests.

### R1a: Spawner-set evidence scope

- [ ] Read `PI_ORCHESTRATION_EVIDENCE_SCOPE` as the maximum scope available to the process.
- [ ] Treat an unset value as `session`.
- [ ] Allow a call parameter to narrow scope only.
- [ ] Record requested and effective scope on every invocation.
- [ ] Keep `force` independent of evidence scope.
- [ ] Prevent a process with `session` scope from receiving a flow-scoped hit by any parameter combination.

### R3: Composite verification

- [ ] Add a fixed-order `verify` command for format, lint, typecheck, and tests.
- [ ] Support optional path scoping and `continueOnFailure`.
- [ ] Reuse validation results only when repository state, working directory, and resolved command list are unchanged.
- [ ] Return compact unchanged results with a ref and bounded failure tail.
- [ ] Give `verify` a separate configurable aggregate budget and per-step timeout.
- [ ] Use one authorization decision for the composed operation.

### R4: Tool-issued validation references

- [ ] Return stable opaque refs from cache-eligible `project_command` executions and `verify`.
- [ ] Add lookup without execution.
- [ ] Store exact resolved command, state digest, working directory, HEAD, covered identifiers, result, exit code, and timestamps.
- [ ] Keep `covers` opaque and preserve it verbatim.
- [ ] Mark records non-reusable when a reliable state digest is unavailable.

### R7: Orchestration join keys and output telemetry

- [ ] Add flow, delegation, and role identifiers to project-command invocation records when present.
- [ ] Persist truncation, total bytes, total lines, effective scope, and repeated-request context.
- [ ] Add a step count or batch marker if the host can expose it.
- [ ] Keep all orchestration fields absent when the environment is absent.

### R6: Actionable errors for edit, resolution, and policy

- [ ] Report edit match counts and distinguish zero matches from ambiguous matches.
- [ ] Include nearest candidates, line numbers, and whitespace-mismatch hints.
- [ ] Consider an optional edit dry-run preflight.
- [ ] Include nearest existing paths in resolution errors.
- [ ] Include authorized roots and stable rule kinds in policy denials.

### R8: Batch reads and read references

- [ ] Add bounded batch reads with per-path ranges and per-path errors.
- [ ] Return an unchanged result and prior ref for repeated content-hash-equivalent reads.
- [ ] Normalize reported paths to repository-relative paths.

### R9: Curated read-only probe surface

- [ ] Evaluate whether existing tools can be made discoverable enough to prevent hallucinated shell-style probes.
- [ ] If needed, add one read-only probe surface covering file metadata, directory listing, and Git introspection.
- [ ] Return the closest supported tool when an unknown tool can be intercepted.

## Design decisions and handoff responses

### Existing cache interface

The R1 implementation should reuse the existing `ProjectCommandResultCache` interface.

Its first argument is already a string namespace, although it is currently named `sessionId`.

The disk-backed implementation can interpret that namespace as either a session namespace or a flow namespace without changing logical request keys.

If clearer naming is needed, rename the implementation parameter internally or introduce a semantic alias without breaking existing injected test caches.

A separate persistence interface is not required unless atomic locking, eviction, or corruption recovery cannot be expressed cleanly behind the existing cache seam.

### Verify authorization

The preferred authorization shape for R3 is one composed policy decision for the `verify` request.

The underlying format, lint, typecheck, and test commands must still be resolved and recorded individually.

A single gate avoids four prompts while preserving the policy boundary around the complete operation.

### Verify budget

`verify` should receive a separate configurable aggregate budget and per-step timeout rather than changing the defaults for ordinary `project_command` calls.

Its model-facing result should be bounded and should return the failure tail for the failing step.

Streaming is not required for the first design if the full output remains retrievable by a stable ref after R4 is implemented.

### R8 priority

R8 is deferred.

R2 and R3 remove more result tokens and duplicate validation work per unit of implementation effort.

R8 should be reconsidered after the R2 and R3 measurements and after the consuming read-manifest work is available.

### Flow-end signal

A flow-end signal is not required for the cache design.

TTL and size-based eviction are sufficient for correctness.

An optional `flow.json` liveness hint may improve cleanup but must never be required input or a reason for a request to fail.

### Downscoped evidence requests

The preferred behavior for a request asking for `flow` scope when the spawner grants only `session` scope is an actionable rejection.

A rejection makes the narrowing-only rule visible and avoids allowing a caller to mistake a session-scoped result for a flow-scoped result.

The response must include the effective scope and record it regardless of whether the final implementation chooses rejection or silent downscope.

## No-environment fallback guarantee

When none of the orchestration environment variables is present, `bash-tools` must use the existing process-local, session-scoped cache path and must not perform flow-store reads or writes.

The existing namespace, authorization sequence, cache decisions, command execution, and result formatting remain unchanged except where an explicitly approved R2 contract change intentionally changes `git_diff` defaults.

No role, flow, delegation, scope, persistence, or cross-process behavior may be inferred from the absence of the environment.

A normal interactive Pi session therefore remains a zero-change path for all future orchestration features.

## Priority ranking

The implementation priority from the `bash-tools` side is:

1. **R5 - Remove the schema tax.** It eliminates wasted retries and interface-friction steps immediately.
2. **R2 - Bounded diff by default.** It removes the largest measured tool-result token source.
3. **R1a - Spawner-set evidence scope.** It is a safety prerequisite for any flow-scoped reuse.
4. **R1 - Flow-scoped result cache backend.** It enables cross-process reuse after scope enforcement is in place.
5. **R3 - Composite verification.** It targets the largest repeated validation-call pattern once shared storage exists.
6. **R7 - Observability join keys.** It makes the orchestration savings and safety properties measurable.
7. **R4 - Tool-issued validation refs.** It makes validation evidence portable and resolvable after the shared store exists.
8. **R6 - Actionable edit, resolution, and policy errors.** It addresses meaningful interface friction but has a smaller measured token impact.
9. **R8 - Batch reads and read references.** It is valuable but overlaps with the lower-cost read-manifest work and follows larger R2 and R3 wins.
10. **R9 - Curated read-only probe surface.** It addresses a smaller hallucinated-tool signal and should follow evidence from the higher-impact work.

R1 and R1a should be released together for cross-process reuse even though R1a is listed first in the safety ranking.

R2's bounded and summary-first behavior is current work.

R2's cross-process summary sharing waits for the R1 backend and must not be implemented through an implicit or model-selected flow scope.

## Files expected to change in the current batch

- `src/tools/project-command/schema.ts` and related schema-definition modules.
- `src/tools/project-command/schema/validation.ts`.
- `src/tools/project-command/parameters/` modules as required by the command-shape audit.
- `src/tools/git/diff/tool.ts`.
- `src/tools/git/output.ts` or focused Git diff helper modules.
- Existing Git and project-command test modules, with new focused tests where an existing test file is not appropriate.

The exact file list may be narrowed after the implementation code and current test seams are inspected.

## Completion checklist

- [ ] R5 and the current non-persistent portion of R2 are implemented.
- [ ] Tests cover valid, invalid, repeated, staged, unstaged, scoped, full, and truncated requests.
- [ ] No-environment behavior remains compatible with the documented fallback guarantee.
- [ ] Authorization and confirmation gates remain intact.
- [ ] Lint, typechecking, formatting, focused tests, and the full test suite pass.
- [ ] Before-and-after measurements are recorded for the targeted baseline signals.
- [ ] Deferred workstreams remain untouched unless explicitly authorized in a later plan update.
