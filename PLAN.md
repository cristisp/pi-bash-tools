# Bash Tools Implementation Plan

## Status

The R1, R1a, R2, R3, and R5 implementation batches are complete.

The verify evidence portion of R4 is implemented and independently approved.

The latest fresh primary review returned `PASS` with no Critical, High, or Medium finding, and closed F-008, F-009, F-011, and F-012.

A follow-up batch closed F-013, F-014, and F-015, leaving only F-016 as an open non-blocking Low item. That follow-up batch changed production code in `src/tools/git/execution.ts` after the primary `PASS` and was closed by a fresh validator plus a fresh scoped remediation review, not by a new full primary review.

No implementation batch is currently running. The uncommitted change set is releasable and should be committed before new work starts in this area.

The next work should not reopen completed cache, schema, Git diff, or verify behavior except to address a new requirement, regression, or security finding, or one of the non-blocking follow-ups below.

### Closed continuation blockers

- **F-008 - bounded Git cleanup ordering:** closed. `test/git/execution.test.ts` gates on a child-recorded `SIGTERM`, asserts the promise is still pending before a `SIGUSR1` release, and asserts the child exited from that release before rejecting, on both the bounded-output overflow and the cancellation path. The review confirmed the gate fails an implementation that settles at termination-request time.
- **F-009 - shared-cache invalidation coverage:** closed. `test/verify/tool.integration.test.ts` shares one cache across three verify calls and asserts a cold miss, then `unchanged` with `reused: true`, an identical ref, and no executor re-invocation, then `completed` with `reused: false` and a new ref after both tracked and untracked content changes.
- **F-011 - review-status documentation:** closed by the fresh primary review `PASS` recorded under validation evidence.

### Follow-up items

- **F-013 - Low, closed:** an output-limit breach now surfaces as contract code `git-output-limit-exceeded` with category `IMPLEMENTATION_FAILURE`, `retryable: false`, and `executed: true` from both detection layers, instead of `SPAWN_FAILURE`. Cancellation precedence and the genuine spawn-failure path are unchanged.
- **F-014 - Low, closed:** the gated ordering tests now pre-check the child and fail with an explicit exhausted-grace-window message instead of an opaque `ESRCH` or missing marker. The production `CHILD_TERMINATION_GRACE_MS` value was deliberately left at 100 ms and no test-only knob was added, so a stall longer than the grace window still fails these tests, now loudly and with the correct cause.
- **F-015 - Low, closed with accepted risk:** no-op `error` listeners are attached to both child streams immediately after spawn, so a stream-level `error` cannot escape as an uncaught exception. No dedicated regression test exists, because a real one would need either a production seam or a harness approach with no precedent in this repository. `src/tools/project-command/execution/monitor.ts` has the same shape and was left untouched.
- **F-016 - Low, open, non-blocking:** the new release diagnostic hardcodes the 100 ms grace value in its message instead of deriving it from the production constant, so the two can drift.

## Completed workstreams

### R1 and R1a: Flow-scoped cache and evidence scope

- [x] Added bounded disk-backed project-command cache storage behind the existing cache interface.
- [x] Added process-local fallback when orchestration scope is absent.
- [x] Enforced session versus flow evidence scope and authorized flow persistence.
- [x] Added repository, working-directory, HEAD, dirty-state, and relevant-input provenance.
- [x] Added bounded records, corruption-as-miss handling, age and size eviction, atomic replacement, mutation locking, and stale-lock recovery.
- [x] Added cancellation-safe claims and serialized deletion and clearing.
- [x] Added isolation tests for repositories, working directories, flow scope, invalidation, corruption, poisoning, interrupted writes, and replacement races.

### R2: Bounded and summary-first Git diff

- [x] Added bounded summary-first output with status, stat, and hunk headers without hunk bodies.
- [x] Preserved staged and worktree selection, path scoping, and explicit full-patch behavior.
- [x] Added UTF-8-safe output bounds and model-facing truncation guidance.
- [x] Added deterministic summary keys using repository identity, absolute working directory, HEAD, dirty state, staged state, path filters, and output-shaping inputs.
- [x] Added authorized flow persistence through the R1 store.
- [x] Added raw Git state invalidation using bounded status metadata and per-path content hashes for tracked and untracked changes.
- [x] Added same-tool single-flight coordination, opaque claim handles, stale-claim recovery, and cancellation-safe release.

### R5: Project-command schemas and interface friction

- [x] Canonicalized requests around `{ commandId, variant }`.
- [x] Preserved colon-suffixed command identifiers as compatibility aliases.
- [x] Added deterministic nearest-command guidance and actionable validation errors.
- [x] Added exact package-script variant validation, including shell-syntax rejection and bounded names.
- [x] Preserved accurate resolved command and script metadata without silently aliasing lint as typecheck.
- [x] Added schema fixtures and regression coverage for valid, invalid, legacy, and conflicting requests.

### R3: Composite verify

- [x] Added the registered `verify` tool with fixed `format -> lint -> typecheck -> test` ordering.
- [x] Defaulted the format phase to `format:check`.
- [x] Added configurable exact package-script names, path forwarding, explicit omissions, and `continueOnFailure`.
- [x] Added one composite authorization decision for the resolved command list.
- [x] Added aggregate and per-step timeouts, cancellation handling, failure tails, bounded output, and timeout evidence fallback.
- [x] Added durable refs, unchanged-result reuse, repository-state invalidation, and authorized flow persistence.
- [x] Added explicit incomplete results when phases are omitted and rejection when all phases are omitted.
- [x] Added fail-closed validation for persisted records, direct request keys, ref aliases, command identity, step state, aggregate verdicts, failure-tail safety, and integer durations.
- [x] Kept failure tails only on failed steps, stripped ANSI SGR sequences before bounding, and removed duplicate tails from complete by-ref step output.
- [x] Kept compact output bounded by omitting redundant command fields and marking reused step rows as not executed in the current call.
- [x] Deduplicated top-level and step-level failure tails per response and stripped ANSI SGR sequences from full by-ref output while preserving raw byte totals.
- [x] Made repository-state digests content-aware for tracked and untracked changes, fail closed when bounded state capture is incomplete, added regression coverage for already-dirty tracked files, nested project paths, state races, and non-persisted refs, and bumped the verify cache format version.
- [x] Added production bounded Git capture for repository-state status and content hashes, file identity checks across hashing, and cancellation-safe subprocess termination with escalation.
- [x] Classified bounded-output-limit breaches with a dedicated `git-output-limit-exceeded` contract on both detection layers instead of reporting them as spawn failures, and attached error-suppressing listeners to the bounded child streams.

### R4: Verify evidence references

- [x] Verify records include bounded exact commands, executable arguments, repository state, per-step results, verdicts, timestamps, and coverage identifiers.
- [x] Stable verify refs support lookup without execution.
- [x] Ref aliases are bound to both the requested ref key and the derived record ref.
- [x] Persisted records are validated before direct-key and ref-based reuse.

The standalone project-command validation-reference API is not currently implemented and remains a possible future extension if a new requirement needs it.

## Validation evidence

- [x] `npm run format:check` passed after the latest batch.
- [x] `npm run lint` passed with zero warnings and zero errors, which includes the TypeScript check.
- [x] `npm run test` passed twice in a row with 87 test files and 365 tests after the F-008 and F-009 batch, and twice more with 368 tests after the F-013 to F-015 batch, including 9 tests in `test/git/execution.test.ts`.
- [x] Path filters cannot be forwarded by the available test command in this environment, so focused per-file runs were not executed. `test/git/execution.test.ts` (9 tests) and `test/verify/tool.integration.test.ts` (2 tests) ran as part of the full-suite runs above, alongside `test/project-command/repository-state.test.ts`, `test/verify/tool.test.ts`, and `test/index.test.ts`.
- [x] An earlier session recorded a focused run of `test/git/execution.test.ts test/project-command/repository-state.test.ts test/verify/tool.integration.test.ts test/verify/tool.test.ts test/index.test.ts` passing 31 tests. That exact command could not be repeated here and is not treated as current evidence; the full-suite runs above supersede it.
- [x] The F-008 and F-009 batch added the child-close ordering regressions for the bounded-output overflow and cancellation paths, each gating on a child-recorded `SIGTERM`, asserting the promise is still pending before a `SIGUSR1` release, and asserting the child exited from that release, plus the shared-cache regression covering unchanged reuse with no executor re-invocation and tracked-plus-untracked invalidation. Red evidence came from two temporary mutations, both reverted.
- [x] Codegraph was synchronized after the final implementation changes.
- [x] The composite `verify` gate ran fresh, reporting `reused: false` with `format`, `lint`, and `test` passed and `typecheck` explicitly omitted, giving aggregate verdict `incomplete` by design. Ref `vr_df7609f7ebb3348d2172a1d7`, recorded as historical because plan prose edits changed the repository state afterwards.
- [x] An earlier fresh independent review returned `FAIL` with F-008 and F-009 open; that finding set was remediated and re-reviewed as recorded in the next two bullets.
- [x] A remediation review returned `PASS` on F-008 and F-009 with validation references V-001 through V-005, and a separate fresh primary review of the whole change set returned `PASS` on the acceptance criteria and on every non-negotiable constraint. That review opened F-013, F-014, and F-015 as non-blocking Low follow-ups and left `npm run format:check` re-verified after the plan prose edits.
- [x] The F-013 to F-015 batch was validated by a fresh validator (`PASS` on two full-suite runs, `format:check`, and `lint`) and closed by a fresh remediation reviewer with a `PASS` verdict. Discrimination was proven by two temporary mutations that were fully reverted and fingerprint-compared: restoring the old spawn-failure mapping turned exactly the 3 new output-limit tests red, and settling at termination-request time turned exactly the 2 gated ordering tests red while the escalation test stayed green.
- [x] The first validator delegation of that batch failed to start and was retried in a fresh session; the main session independently reproduced the full-suite result at 87 files and 368 tests.

The repository has no separate `typecheck` package script.

TypeScript checking is included through the Oxlint TypeScript plugin invoked by the lint script.

## Remaining roadmap

### R6: Actionable edit, resolution, and policy errors

- [ ] Report edit match counts and distinguish zero matches from ambiguous matches.
- [ ] Include nearest candidates, line numbers, and whitespace-mismatch hints where useful.
- [ ] Consider an optional edit dry-run preflight.
- [ ] Include nearest existing paths in resolution errors.
- [ ] Include authorized roots and stable rule kinds in policy denials.

### R7: Orchestration join keys and output telemetry

- [ ] Add flow, delegation, and role identifiers to invocation records when present.
- [ ] Persist bounded repeated-request context and any host-provided batch markers.
- [ ] Keep all orchestration fields absent when the environment is absent.
- [ ] Add before-and-after measurements for cache reuse, invalidation, truncation, and repeated requests.

Some bounded output and effective producer-scope telemetry is already present.

The remaining R7 work is limited to fields and measurements not supplied by the current host contract.

### R8: Batch reads and read references

- [ ] Add bounded batch reads with per-path ranges and per-path errors.
- [ ] Return unchanged results and prior refs for repeated content-hash-equivalent reads.
- [ ] Normalize reported paths to repository-relative paths.

### R9: Curated read-only probe surface

- [ ] Evaluate whether existing tools are discoverable enough to prevent hallucinated shell-style probes.
- [ ] If evidence supports it, add one bounded read-only probe surface for file metadata, directory listing, and Git introspection.
- [ ] Return the closest supported tool when an unknown probe can be intercepted.

## Follow-up validation and measurement

- [ ] Record before-and-after invocation measurements for project-command validation errors.
- [ ] Record before-and-after measurements for duplicate status requests.
- [ ] Record Git diff result sizes, truncation frequency, summary reuse, and scoped follow-up usage.
- [ ] Confirm no-environment fallback behavior in a separate integration run when the host can provide that environment.
- [ ] Review the final Git diff before each future release batch.

## Non-negotiable constraints

- Do not import from or depend on `subagent-herdr`.
- Consume orchestration information only through the environment contract.
- Do not add role or workflow policy to `bash-tools`.
- Do not weaken authorization, confirmation, filesystem, or command-policy gates.
- Preserve existing behavior when orchestration environment variables are absent.
- Keep cached and model-facing output bounded and distinguish complete output from compact output.
- Preserve the existing project-command cache decision vocabulary: `miss`, `hit`, `forced`, `ineligible`, and `invalidated`.
- Keep command-definition fingerprints separate from result-reuse fingerprints.
- Treat command output as untrusted text and do not retain unnecessary source content, environment values, secrets, or full logs.
- Do not edit handoff documentation or `CHANGELOG.md` as part of future implementation batches unless explicitly requested.

## Design decisions to preserve

- Flow persistence is allowed only with an authorized flow scope and valid repository provenance.
- Unset orchestration variables retain process-local, session-scoped behavior.
- Cache keys include repository identity, absolute working directory, HEAD, dirty state, relevant inputs, path filters, staged state, and output-shaping inputs where applicable.
- Persisted JSON is strictly validated, bounded, atomically replaced, and protected by the shared mutation-lock protocol.
- Verify uses one authorization decision for the complete resolved command list.
- Semantic verify phases may resolve to project-specific exact scripts while retaining accurate command metadata.
- Omitted phases remain visible and never count as passed.
- Missing `typecheck` is an explicit omission for normal execution and a resolution failure when it is explicitly requested.
- Timeout and cancellation behavior must preserve bounded evidence and exact cancellation semantics.
- Raw Git discovery and summary computation must not bypass repository resolution, path validation, authorization, or Git execution policy.

## Priority for the next batch

1. R6 actionable errors, if new measurement confirms remaining interface friction.
2. R7 host-supported join keys and durable telemetry.
3. R8 batch reads and read references.
4. R9 curated read-only probes.
5. Standalone project-command validation refs only if a consumer requires them.

Do not reopen R1, R1a, R2, R3, or R5 without a new behavior requirement, regression, or security finding.
