# Bash Tools Implementation Plan

## Status

The R1, R1a, R2, R3, and R5 implementation batches are complete.

The verify evidence portion of R4 is complete.

The implementation has passed a fresh independent review with all in-scope findings closed.

There is no active implementation batch from the previous roadmap.

The next work should be selected from the remaining follow-up workstreams below rather than reopening completed cache, schema, Git diff, or verify work without new requirements.

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
- [x] Added raw Git state invalidation, including status, diff, and untracked-file content changes.
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

### R4: Verify evidence references

- [x] Verify records include bounded exact commands, executable arguments, repository state, per-step results, verdicts, timestamps, and coverage identifiers.
- [x] Stable verify refs support lookup without execution.
- [x] Ref aliases are bound to both the requested ref key and the derived record ref.
- [x] Persisted records are validated before direct-key and ref-based reuse.

The standalone project-command validation-reference API is not currently implemented and remains a possible future extension if a new requirement needs it.

## Validation evidence

- [x] Formatter check passed for 216 files.
- [x] Project lint passed with zero warnings and zero errors.
- [x] Verify-focused tests passed with 14 tests.
- [x] Full test suite passed with 85 test files and 353 tests.
- [x] Codegraph was synchronized after the final implementation changes.
- [x] Fresh independent verify review returned `PASS`.

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
