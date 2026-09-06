# Bash Tools Implementation Plan

## Status

The R1, R1a, R2, R3, R4, R5, and consumer-aligned validation evidence implementation batches are complete.

The consumer handoff recorded in `docs/handoffs/BASH_TOOLS_DECISIONS.md` is implemented across project-command evidence, verify evidence, authorization scope, publication, repository-state freshness, mutability, single-flight coordination, bounded observability, documentation, and regression coverage.

The latest completed validation run passed the full test suite: 89 test files and 397 tests.
The preceding validation reference was `vr_3a117ca82e8da911ff7c34aa`, and it is retained only as historical evidence because it predates the current remediation.
The repository has no separate `typecheck` package script, and TypeScript checking is included through the Oxlint TypeScript plugin invoked by the lint script.

`npm run format:check` now passes because the protected `docs/handoffs/` directory is excluded by the formatter and linter configuration; those files remain unchanged by policy.

The latest focused independent primary completion review returned `review_verdict: PASS`.
F-017 is accepted as an explicit verification exception by the user: TypeScript checking is handled by the Oxlint TypeScript plugin in `lint`, and the reduced verifier has a flow-published validation reference.
F-018 through F-021 remain resolved with fail-closed evidence validation, durable set handling, and direct publication-boundary regressions.

No implementation batch is currently running.
The current remediation changes are uncommitted, and the available tool surface does not expose Git commit operations.

Future work should not reopen completed R1, R1a, R2, R3, R4, R5, or validation-evidence behavior except for a new behavior requirement, regression, security finding, or the follow-up items below.

### Closed continuation blockers

- **F-008 - bounded Git cleanup ordering:** closed. `test/git/execution.test.ts` gates on a child-recorded `SIGTERM`, asserts the promise is still pending before a `SIGUSR1` release, and asserts the child exited from that release before rejecting, on both the bounded-output overflow and the cancellation path.
- **F-009 - shared-cache invalidation coverage:** closed. `test/verify/tool.integration.test.ts` shares one cache across three verify calls and asserts cold, unchanged, and invalidated behavior for tracked and untracked content changes.

### Current review finding dispositions

- **F-002 - accepted by D5:** root-to-flow publication is an explicit executing request, not a lookup or an environment-only grant.
  The persistence boundary requires explicit publication metadata, matching repository identity, source-scope compatibility, and a confirmed durable write.
  A flow-scoped caller can publish only to its effective flow, while root publication is intentionally allowed by the agreed repository-provenance contract.
  `test/project-command/evidence.test.ts` covers matching and mismatching repository publication, durable reload, and cross-flow rejection.
- **F-005 - closed:** each verify consumer now races its own request and step/aggregate cancellation signal against the shared promise.
  Shared execution has an independent controller and remains alive while another consumer remains attached.
  `test/verify/tool.test.ts` proves that cancelling one consumer does not abort the producer or the shared executor.
- **F-006 - closed:** project-command evidence validation now checks the bounded nested details, repository state, provenance, publication, output metadata, and content-derived key.
  In-memory and durable lookups apply the same fail-closed validation.
- **F-012 - superseded:** the historical reference is no longer presented as current release evidence.
  A fresh focused and full validation run is required before final approval.
- **F-014 - closed by host-contract inspection and regression coverage:** the diagnostic normalizer mirrors the installed host edit implementation, including LF normalization and progressive fuzzy matching.
  The host source and `test/filesystem/access-policy.test.ts` cover line endings, Unicode punctuation, and whitespace diagnostics.
- **F-015 - closed:** edit preflight checks cancellation before the read, after the read, before returning a diagnostic, and again after preflight at the interceptor boundary.
  Read/stat failures fall through to the host rather than being converted into mutation approval.
- **F-016 - closed:** `CHILD_TERMINATION_GRACE_MS` is exported and the ordering diagnostic derives its message from the production constant.
- **F-017 - accepted verification exception:** the user confirmed that TypeScript checking is handled by the Oxlint TypeScript plugin in `lint`.
  The full verifier cannot resolve a standalone `typecheck` script, but the reduced verifier covers format, lint, and tests with a published reference.
- **F-018 - closed:** persisted and in-memory project-command evidence now requires a supported `RESULT_CATEGORIES` value.
  The evidence store rejects malformed records at `set`, rejects malformed sources and final records before publication, and durable reload coverage rejects an unsupported category.
- **F-019 - closed:** publication validates the source record and the final flow-scoped publication record before invoking the durable writer.
  Focused tests cover malformed publication sources, repository mismatch, durable reload, and cross-flow rejection.
- **F-020 - closed:** disk-cache `set()` now returns a write-success result, and flow evidence is added to memory only after durable persistence succeeds.
  Failed durable storage cannot be retrieved or published as flow evidence, and runner output omits the evidence reference when storage fails.
- **F-021 - closed:** publication tests now mutate an already-stored source to exercise source validation directly and separately reject malformed final publication metadata.

Earlier budget-blocked reviews remain historical review-status findings; the latest focused completion review supersedes them with a PASS.

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

The standalone project-command validation-reference API is part of the next consumer-aligned evidence handoff below.
Its refs are addressable evidence only and must not make any currently non-reusable command replayable.

## Validation evidence

- [x] The current full `npm run test -- test` run passed with 89 test files and 397 tests.
- [x] Focused project-command, verify, Git, filesystem, and batch-read suites passed during the remediation.
- [x] The latest flow-published reduced verification reference passed format, lint, and tests for AC-005 through AC-007, R6 through R8, and F-017 through F-021 with only typecheck explicitly omitted.
- [x] The current `npm run lint` run passed with zero warnings and zero errors.
- [x] `npm run format` completed successfully for the implementation and test surfaces.
- [x] `npm run format:check` passes after excluding the protected `docs/handoffs/` directory; those files remain intentionally unchanged.
- [x] The user accepted the typecheck exception because TypeScript checking is included in the `lint` script.
      The full verifier still cannot resolve a standalone `typecheck` package script; the reduced verifier covers the executed format, lint, and test phases.
- [x] Codegraph was synchronized after this remediation before the next graph-dependent review.
- [x] The focused remediation coverage includes project-command publication, corruption, durable-write failure, direct source validation, and final publication validation, plus verify shared-consumer cancellation, Git grace-window diagnostics, and the existing R6/R8 regressions.
- [x] The latest focused independent primary review completed with `review_verdict: PASS` and accepted the explicit typecheck exception.

The repository has no separate `typecheck` package script.

TypeScript checking is included through the Oxlint TypeScript plugin invoked by the lint script.

## Remaining roadmap

### Completed batch: Consumer-aligned validation evidence handoff

This batch implemented the contract in `docs/handoffs/BASH_TOOLS_DECISIONS.md` as an ordered dependency sequence.
The implementation preserved completed R1, R1a, R2, R3, R4, and R5 behavior except where the handoff added evidence, authorization, publication, or telemetry requirements.
Focused tests were added and run during the batch.

#### Step 1: Shared bounded records and observability foundations

- [x] Extend bounded invocation metadata with optional `flowId`, `delegationId`, `role`, `ref`, recorded repository state, `verdict`, `mutating`, publication metadata, and coercion metadata.
- [x] Keep orchestration fields absent when their environment values are absent, and keep the existing invocation and summary format versions unless an external parser proves incompatible.
- [x] Preserve the existing project-command cache-decision vocabulary and the existing bounded summary count without adding per-request-key repetition data.
- [x] Register the existing invocation recorder with `verify` and emit one aggregate invocation record per `verify` tool call, never one record per phase.
- [x] Keep process `status` separate from the aggregate verify `verdict`, preserving `passed`, `failed`, and `incomplete` rather than mapping `incomplete` to success.
- [x] Preserve default tool outputs and process-local evidence behavior when the new request options and orchestration variables are absent.

#### Step 2: Request shapes, lookup modes, and normalization

- [x] Add `fresh` to `verify`, add `covers` and lookup support to `project_command`, and add the explicit `{ ref, flowId }` lookup shape.
- [x] Make `{ ref }`, `{ ref, flowId }`, and those forms with opaque `covers` lookup-only shapes, reject `ref` with execution options other than `covers` and `flowId`, and keep unknown parameters fail-closed as execution-capable.
- [x] Add nested `publish: { flowId }` only to executing evidence requests, reject `publish` with `ref`, and keep publication metadata out of execution identities.
- [x] Coerce an unambiguous JSON-encoded `paths` array supplied as a string, retain the existing boolean coercions, and record every coercion in bounded invocation metadata.
- [x] Make validation errors name the field, expected shape, and a literal accepted example.
- [x] Mark lookup-only parameters as such in the tool schemas and descriptions so the consumer's allowlist has a source of truth other than a diff.

#### Step 3: Authorization and mutability contracts

- [x] Remove `paths` from the verify authorization identity while retaining it in the evidence key and retaining the script fingerprint in the authorization identity.
- [x] Add one operator-approved composite flow grant bound to the resolved script set and usable only when the effective evidence scope is `flow`.
- [x] Keep session-scoped and unset-scope calls prompting, and never auto-authorize based only on orchestration environment variables.
- [x] Add actionable authorization failures that identify the rejected command shape, project path, searched scope, effective evidence scope, and whether the missing permission concerns execution or publication.
- [x] Report variant-derived `mutating` values on every relevant `project_command` and `verify` result, invocation record, and decision record: `node_format` mutating, `node_format:check` non-mutating, `node_lint:fix` mutating, and `node_lint` plus `node_lint:check` non-mutating.
- [x] Treat unknown variants in a family with any writing form as mutating, and document that package-script bodies remain outside the guarantee.
- [x] Keep role, delegation, and workflow values as provenance and join metadata only; do not add role-based policy to `bash-tools`.

#### Step 4: Verify freshness, lookup, and publication

- [x] Add `fresh: true` to `verify`, reject it with `ref`, exclude it from the content-addressed cache key, and record the forced decision independently of evidence scope.
- [x] Make a fresh execution return the same ref for identical evidence with `reused: false`, while an ordinary unchanged request continues to return the compact reused result.
- [x] Return recorded state, current state, and `stateMatchesCurrent` from evidence lookups, keeping an unreadable current state distinct from a confirmed mismatch.
- [x] Include effective evidence scope and flow-id presence in lookup failures, and include `producerScope`, producing role, and producing delegation id in successful lookups when available.
- [x] Add `publish: { flowId }` to executing `verify` requests rather than using a flat execution-time flow id.
- [x] Treat publication into the caller's own effective flow as an accepted no-op while preserving normal flow persistence.
- [x] Require repository identity compatibility for root publication and stamp `producerScope`, `delegationId`, and `role` on published records when available.
- [x] Keep root evidence process-local unless it was deliberately published, and keep publication out of authorization and content-addressed execution identities.

#### Step 5: Addressable project-command evidence

- [x] Add addressable, non-replayable project-command evidence refs with a distinct `pc_` prefix.
- [x] Preserve `reusePolicy: "never"` for script and Fallow commands, and do not use project-command refs as cache hits or execution short-circuits.
- [x] Store and resolve project-command evidence without requiring a command execution on lookup, including executions that are intentionally non-reusable.
- [x] Add `covers` to project-command execution and lookup shapes with the same opaque, verbatim, key-participating behavior as `verify`.
- [x] Add `publish: { flowId }` to project-command evidence requests using the same restrictions and provenance checks as `verify`.
- [x] Return the same self-describing lookup metadata as `verify`, including effective scope on failures and producer scope, role, and delegation id on successful lookups when available.
- [x] Return recorded state, current state, and `stateMatchesCurrent` for project-command lookups.
- [x] Keep current-state read failure distinct from a confirmed state mismatch.

#### Step 6: Concurrent execution and moving-tree telemetry

- [x] Add single-flight coordination for identical in-flight evidence requests and distinguish a shared execution from an ordinary cache hit.
- [x] Record `concurrentExecutions` for the repository identity observed by the request.
- [x] Compare repository state at completion with state at start and report `stateDrift` when the tree moved during execution.
- [x] Keep the consumer-owned repository write lock as the authority for writer-versus-reader coordination, and do not add a competing role or workflow policy in this batch.

#### Step 7: Documentation and verification

- [x] Document `verify`, `fresh`, project-command refs, lookup-only parameter shapes, publication, and repository-state freshness fields in the README and tool descriptions.
- [x] Document that `dirtyFilesDigest` fingerprints the paths reported by Git, including their content, mode, size, and status, and excludes ignored paths.
- [x] Add focused regression coverage for fresh reruns, stable refs, lookup isolation, root publication, flow lookup, current-state mismatch, unreadable current state, authorization scope, coercion metadata, mutability variants, aggregate invocation records, single-flight sharing, concurrency counts, and state drift.
- [x] Verify the consumer allowlist remains fail-closed for `{ ref }` and `{ ref, flowId }`, rejects `{ ref, publish }` and `{ ref, fresh }`, and treats newly added unknown parameters as execution-capable.

### R6: Actionable edit, resolution, and policy errors

- [x] Report bounded edit match counts and distinguish zero matches from ambiguous matches.
- [x] Include bounded nearest candidates, line numbers, and whitespace-mismatch hints where useful.
- [x] Add an optional non-mutating edit preflight for the local host contract; cancellation is checked around the preflight, and remote, unreadable, oversized, or unsupported targets fall through to the host edit implementation.
- [x] Do not claim a host-native edit dry-run API: the host contract exposes only `path` and `edits`, so local preflight remains advisory and host execution remains authoritative.
- [x] Include bounded nearest existing paths in resolution errors.
- [x] Include bounded authorized roots and stable rule kinds in policy denials.

### R7: Orchestration join keys and output telemetry

The consumer-aligned evidence handoff above owns the requested flow, delegation, role, ref, repository-state, aggregate-verify, and lookup-provenance fields.

- [x] Keep all orchestration fields absent when the environment is absent.
- [x] Add bounded before-and-after measurements for cache reuse, invalidation, truncation, and repeated requests.

Some bounded output and effective producer-scope telemetry is already present.
The remaining R7 work is limited to measurements not supplied by the current host contract, excluding the fields and concurrency telemetry completed in the validation evidence handoff above.

The R7 measurements remain limited to values supplied by the current project-command invocation contract; unsupported Git-specific and host-only follow-up metrics are intentionally not synthesized.

### R8: Batch reads and read references

- [x] Add bounded batch reads with per-path ranges and per-path errors.
- [x] Return unchanged results and prior refs for repeated content-hash-equivalent reads.
- [x] Normalize reported paths to repository-relative paths.

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

- Flow persistence is allowed with an authorized effective flow scope and valid repository provenance, or through an explicitly authorized `publish: { flowId }` request with valid repository provenance.
- Unrequested root evidence remains process-local, and unset orchestration variables retain process-local, session-scoped behavior.
- Cache keys include repository identity, absolute working directory, HEAD, dirty state, relevant inputs, path filters, staged state, and output-shaping inputs where applicable.
- Persisted JSON is strictly validated, bounded, atomically replaced, and protected by the shared mutation-lock protocol.
- Verify uses one authorization decision for the complete resolved command list.
- Semantic verify phases may resolve to project-specific exact scripts while retaining accurate command metadata.
- Omitted phases remain visible and never count as passed.
- Missing `typecheck` is an explicit omission for normal execution and a resolution failure when it is explicitly requested.
- Timeout and cancellation behavior must preserve bounded evidence and exact cancellation semantics.
- Raw Git discovery and summary computation must not bypass repository resolution, path validation, authorization, or Git execution policy.

## Priority for the next batch

1. Retain the current focused and full validation evidence.
2. Begin R9 curated read-only probes only after the user requests them.

Do not reopen R1, R1a, R2, R3, R4, R5, or the completed validation-evidence handoff without a new behavior requirement, regression, or security finding.
