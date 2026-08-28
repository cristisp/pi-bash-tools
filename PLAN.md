# Bash Tools Plan

## Purpose

Improve the existing `@ztc/bash-tools` extension through better contract observability, consistent project-command results, and safe suppression of unchanged validation runs.

This plan deliberately focuses on the tools that already exist.
New tools and additional operating-system support will be considered separately when there is measured demand and an agreed design.

## Current baseline

The extension currently registers these custom tools:

- `git_status`.
- `git_diff`.
- `git_log`.
- `git_show`.
- `environment`.
- `project_command`.
- `move`.
- `delete`.

The extension also applies filesystem policy to Pi's built-in `read`, `write`, `edit`, `ls`, `find`, and `grep` tools through a `tool_call` interceptor.
The `move` and `delete` tools enforce filesystem policy within their own implementations.
Unrestricted Bash is not governed by the filesystem interceptor.

The existing `project_command` implementation already provides fixed command definitions, schema validation, canonical project resolution, policy authorization, bounded output, cancellation, process timeouts, and stable command-definition fingerprints.
Those fingerprints represent authorization identities and must remain separate from fingerprints used to reuse command results.

## Goals

- Record the exact tool contracts active during each session.
- Make project-command failures consistently classified and actionable.
- Prevent unchanged validation commands from being executed repeatedly when reuse is demonstrably safe.
- Preserve policy authorization on every request, including requests that may reuse an earlier result.
- Produce compact metadata that can explain cache decisions and failures without retaining source content, environment values, or full command output.
- Keep all new behavior testable through injected dependencies and deterministic fixtures.

## Non-goals

- Adding new tools.
- Adding support for additional operating systems.
- Replacing existing tools with parallel alternatives.
- Replacing Pi's built-in read or edit tools or changing their core input and mutation semantics.
- Adding arbitrary command execution.
- Building the complete audit-retention system in the first implementation batch.
- Reusing results across sessions or process restarts.
- Treating project trust or project-command authorization as process isolation.

## Design principles

### Keep authorization and result identities separate

The existing project-command fingerprint identifies the approved command definition, resolved executable shape, and package-script binding.
It remains the policy authorization identity.

A new result fingerprint will identify one resolved command request and the relevant project state used by that request.
Changing result-reuse behavior must not silently change persisted authorization decisions.

### Authorize before reuse

Every project-command request must load current policy and complete authorization before a cached result can be returned.
A previously authorized and cached command must not bypass a later deny rule or unavailable confirmation requirement.

### Default to no reuse

Every command definition must have an explicit result-reuse policy.
The default policy must be `never`.

A command becomes reusable only when its relevant inputs can be identified and it is not known to depend on uncontrolled external state.
Mutating commands must never be reusable.

### Keep process status and result category distinct

The existing process statuses describe execution mechanics:

- `success`.
- `nonzero`.
- `timeout`.
- `spawn-failure`.
- `cancelled`.

A separate result category will describe the higher-level outcome.
Existing status, exit, stdout, stderr, timeout, and cancellation fields must remain available.

### Keep audit data compact

Audit and inventory records must contain metadata rather than source content or complete outputs.
Environment values must never be recorded.
Unknown or sensitive argument values must be redacted or represented by a stable hash.

### Use Pi lifecycle identifiers

Pi's existing session ID and tool call ID will identify invocations.
The extension must not introduce a second unrelated invocation ID system.

## Phase 1: Active tool contract inventory (complete)

### Implementation

- [x] Load the extension version from `package.json` at runtime through a single source.
- [x] Add canonical JSON serialization for JSON-compatible metadata.
- [x] Preserve array order while sorting object keys recursively.
- [x] Add SHA-256 hashing for serialized tool parameter schemas.
- [x] Record all configured tools from `pi.getAllTools()` during `session_start`.
- [x] Record the active tool names from `pi.getActiveTools()`.
- [x] Record each tool's name, active state, source provenance, and schema hash.
- [x] Record the extension version, session ID, session-start reason, hash algorithm, and inventory format version.
- [x] Persist the inventory through `pi.appendEntry()` so it remains outside model context.
- [x] Deduplicate only an identical inventory recorded more than once in the same active runtime.
- [x] Record a new inventory after reload when schemas, provenance, or active tools change.

### Proposed files

- `src/version.ts`.
- `src/observability/canonical-json.ts`.
- `src/observability/tool-inventory.ts`.
- `src/observability/types.ts`.
- `src/index.ts`.
- `test/index.test.ts`.
- `test/observability/tool-inventory.test.ts`.

### Policy coverage inventory

- [x] Add a table-driven test proving that `read`, `write`, `edit`, `ls`, `find`, and `grep` are handled by the filesystem `tool_call` interceptor.
- [x] Add tests proving that `move` and `delete` use policy within their implementations rather than inheriting interceptor authorization.
- [x] Add a test proving that an unknown tool receives no filesystem authorization accidentally.
- [x] Add a test documenting that Bash is outside the filesystem interceptor.
- [x] Keep canonicalization and symlink resolution tests associated with the existing policy implementation.

### Acceptance criteria (met)

- Every active tool can be associated with its exact parameter-schema hash and source provenance.
- Inventory records contain no source content, environment values, prompts, or tool outputs.
- Equivalent schemas produce the same hash regardless of object-key insertion order.
- Array ordering remains significant to schema hashes.
- Reloading with a changed schema or active tool set produces a new inventory record.
- Tests explicitly distinguish interceptor-governed tools from tools that enforce policy internally.

## Phase 2: Structured project-command outcomes (complete)

### Stable error contract

- [x] Define a structured error contract that can later be reused by all existing tool families.
- [x] Apply the contract to `project_command` first.
- [x] Give every error a stable code and result category.
- [x] Include the invalid field when a specific field caused validation failure.
- [x] Include a concise explanation.
- [x] Support a corrected example field only when the correction is unambiguous.
- [x] State whether retrying the identical request can succeed.
- [x] State whether command execution was attempted.
- [x] Preserve fail-closed behavior for policy and authorization errors.

### Result categories

- [x] Add `PASS`.
- [x] Add `INVALID_REQUEST`.
- [x] Add `IMPLEMENTATION_FAILURE`.
- [x] Add `TEST_FAILURE`.
- [x] Add `FORMAT_FAILURE`.
- [x] Add `LINT_FAILURE`.
- [x] Add `TYPE_CHECK_FAILURE`.
- [x] Add `RESOLUTION_FAILURE`.
- [x] Add `POLICY_FAILURE`.
- [x] Add `ENVIRONMENT_FAILURE`.
- [x] Add `TIMEOUT`.
- [x] Add `SPAWN_FAILURE`.
- [x] Add `CANCELLED`.
- [x] Add `BLOCKED`.

`PASS` means that the tool accepted the command outcome as normal data.
For example, an accepted Fallow findings exit code can be `PASS` even when the returned analysis contains findings.

`BLOCKED` represents a deliberate denial or an unavailable authorization path.
`POLICY_FAILURE` represents a failure to load, evaluate, confirm, or persist policy rather than an intentional denial.
Categories must be assigned from known execution state and must not be guessed by parsing arbitrary output text.

### Result metadata

- [x] Add the current `toolCallId` as the invocation identifier.
- [x] Add `executed`.
- [x] Add `reused` as `false` until Phase 3 reuse is implemented.
- [x] Add total duration and command-execution duration separately.
- [x] Add normalized command scope.
- [x] Add output truncation metadata.
- [x] Add a deterministic primary diagnostic.
- [x] Add a suggested next action.
- [x] Add retryability metadata.
- [x] Keep exit information separate from the result category.
- [x] Distinguish confirmation timeout from command timeout.

### Diagnostic extraction

- [x] Prefer bounded stderr when it contains a meaningful diagnostic.
- [x] Fall back to bounded stdout when stderr is empty.
- [x] Remove terminal control sequences from the compact diagnostic.
- [x] Keep the bounded raw stdout and stderr fields unchanged.
- [x] Keep diagnostic extraction deterministic and command-family aware where reliable parsing exists.
- [x] Avoid claiming that an arbitrary first output line is actionable when it is only a command banner.

### Proposed files

- `src/tools/errors.ts`.
- `src/tools/project-command/categories.ts`.
- `src/tools/project-command/diagnostics.ts`.
- `src/tools/project-command/output.ts`.
- `src/tools/project-command/runner.ts`.
- `src/tools/project-command/schema/validation.ts`.

### Acceptance criteria (met)

- Successful, accepted-nonzero, failed, timed-out, blocked, and cancelled requests have stable categories.
- Policy denial, policy infrastructure failure, confirmation timeout, process timeout, and nonzero exit are distinguishable.
- Failure details state whether execution occurred.
- Existing process details remain backward-compatible.
- One compact diagnostic and one suggested action are available when they can be determined safely.

## Phase 3: Result fingerprints and session-local reuse

### Session state

- [ ] Key all reusable results by Pi session ID.
- [ ] Keep cache contents in memory only.
- [ ] Do not restore cache entries when a session is resumed in a new extension runtime.
- [ ] Use Pi's `toolCallId` to identify the invocation that produced a reusable result.
- [ ] Return the producing invocation ID when a result is reused.
- [ ] Rely on `project_command` sequential execution mode to prevent duplicate concurrent execution.

### Force behavior

- [ ] Add an optional `force` boolean to every project-command schema variant.
- [ ] Validate `force` consistently at runtime.
- [ ] Exclude `force` from the semantic result fingerprint.
- [ ] Exclude `force` from arguments forwarded to command resolution or execution.
- [ ] Report a forced execution as a cache bypass.

### Reuse policy

- [ ] Add an explicit reuse policy to every command definition.
- [ ] Support `never`, `static`, `project-metadata`, and `workspace-snapshot` policies.
- [ ] Default missing or unknown policies to `never`.
- [ ] Keep `node_lint_fix` and `node_format_write` permanently non-reusable.
- [ ] Treat commands that depend on uncontrolled external state as non-reusable.
- [ ] Review build, test, coverage, and E2E commands individually instead of assuming that all package scripts are non-mutating.
- [ ] Require an explicit test and rationale before making any project-code command reusable.

### Result fingerprint

- [ ] Add a versioned result-fingerprint format.
- [ ] Include the extension version.
- [ ] Include the authorization command fingerprint.
- [ ] Include the canonical project path rather than its display form.
- [ ] Include normalized effective parameters.
- [ ] Include the selected process timeout and output limit.
- [ ] Include the reuse-policy identifier.
- [ ] Include a canonical manifest of relevant input paths and hashes.
- [ ] Record which files and configuration values contributed to the fingerprint.
- [ ] Keep content out of the fingerprint metadata returned to the session.

### Relevant inputs

- [ ] Implement relevant-input discovery separately from command resolution.
- [ ] Allow resolution to expose discovered paths without making resolution responsible for hashing them.
- [ ] Include `package.json` when package scripts or package-manager selection affect the command.
- [ ] Include relevant lockfiles when package-manager selection or dependency state affects the command.
- [ ] Include the selected package-script hash.
- [ ] Include explicit test paths and command-specific configuration when applicable.
- [ ] Use a conservative workspace snapshot only for definitions explicitly approved for that strategy.
- [ ] Mark the command non-reusable when complete relevant-input discovery fails.
- [ ] Never silently fall back to an incomplete fingerprint.

### Mutation detection

- [ ] Capture relevant project state before executing a reusable project-code command.
- [ ] Capture relevant project state after execution.
- [ ] Do not cache the result when execution changes relevant project state.
- [ ] Treat created, removed, replaced, or metadata-changed relevant files as mutation.
- [ ] Do not use a successful exit code as evidence that a command was non-mutating.

### Cacheable outcomes

- [ ] Cache successful outcomes for eligible commands.
- [ ] Cache deterministic nonzero validation outcomes for eligible commands.
- [ ] Treat accepted nonzero Fallow outcomes according to the command's explicit reuse policy.
- [ ] Do not cache authorization denials or confirmation failures.
- [ ] Do not cache policy load or persistence failures.
- [ ] Do not cache incomplete resolution failures.
- [ ] Do not cache timeouts.
- [ ] Do not cache spawn failures.
- [ ] Do not cache cancellations.
- [ ] Do not cache results from mutating commands.

### Cache metadata

- [ ] Report `miss` when an eligible result is not present.
- [ ] Report `hit` when execution is skipped and an earlier result is returned.
- [ ] Report `forced` when `force` bypasses an available result.
- [ ] Report `ineligible` when the command or outcome cannot be reused.
- [ ] Report `invalidated` when a prior command request exists but relevant inputs changed.
- [ ] Return the result fingerprint for eligible requests.
- [ ] Return the producing invocation ID for cache hits.
- [ ] Preserve the original outcome while marking the current response as reused.

### Proposed files

- `src/tools/project-command/result-fingerprint.ts`.
- `src/tools/project-command/result-cache.ts`.
- `src/tools/project-command/session-state.ts`.
- `src/tools/project-command/relevant-inputs.ts`.
- `src/tools/project-command/definitions.ts`.
- `src/tools/project-command/schema.ts`.
- `src/tools/project-command/schema/validation.ts`.
- `src/tools/project-command/runner.ts`.
- `src/tools/project-command/output.ts`.

### Acceptance criteria

- An identical eligible request with unchanged relevant inputs executes at most once in one active session unless forced.
- A relevant source or configuration change invalidates the prior result.
- A policy change can block a request even when a matching cached result exists.
- Mutating and externally dependent commands are never served from cache.
- Timeouts, spawn failures, cancellations, and policy failures are never served from cache.
- Cache entries do not cross session IDs or extension runtime restarts.
- Cache metadata explains every reuse, bypass, ineligibility decision, and invalidation.

## Phase 4: Extend the stable error contract to existing tools

This phase begins only after the project-command contract has been exercised and stabilized.
It changes error structure without adding new tool capabilities.

- [ ] Apply stable error codes to the existing Git tools.
- [ ] Apply stable error codes to the environment tool.
- [ ] Apply stable error codes to filesystem policy interception.
- [ ] Apply stable error codes to `move` and `delete`.
- [ ] Use the same field, explanation, example, retryability, and execution-attempt conventions.
- [ ] Preserve existing policy decisions and fail-closed behavior.
- [ ] Avoid changing public success-result shapes unless needed for consistency.

### Acceptance criteria

- Equivalent validation failures have equivalent structured details across existing tool families.
- Every failure indicates whether an unchanged retry can succeed.
- Authorization denial remains distinguishable from policy infrastructure failure.
- No tool gains broader filesystem or command authority through the refactor.

## Phase 5: Measurement and refinement

- [ ] Record compact project-command invocation metadata using session ID and tool call ID.
- [ ] Record schema hash, result category, duration, cache decision, output size, and truncation state.
- [ ] Do not record environment values, source content, prompts, or complete command output.
- [ ] Measure repeated unchanged requests before and after result reuse is enabled.
- [ ] Measure cache hits, misses, forced runs, ineligible commands, and invalidations.
- [ ] Measure failure categories separately from process exit status.
- [ ] Review false reuse, unexpected invalidation, and commands that remain safely ineligible.
- [ ] Adjust command reuse policies only from test evidence and observed behavior.

### Acceptance criteria

- The recorded metadata can explain why a command executed or was reused.
- The recorded metadata can attribute a failure to one session, invocation, active schema, and extension version.
- Unchanged validation reruns decline without hiding source changes or policy changes.
- Measurement does not retain secrets or duplicate large context payloads.

## Deferred workstreams

The workstreams in this section remain part of the roadmap but are not scheduled within the first five phases.
They improve existing tools and workflows without committing to new tool names, new execution capabilities, or additional operating-system support.
Their implementation order will be decided from evidence gathered by the earlier phases.

### Built-in read metadata

- [ ] Evaluate a Pi-supported wrapper or result-interception design for the built-in `read` tool.
- [ ] Preserve the existing read tool rather than registering a parallel repository reader.
- [ ] Return a content hash, canonical path, file size, requested range, actual range, and truncation status.
- [ ] Preserve Pi's existing line and byte limits.
- [ ] Detect binary files before returning unusable textual content.
- [ ] Detect unusually large lines and return bounded metadata rather than an uncontrolled payload.
- [ ] Add explicit continuation metadata for bounded follow-up reads.
- [ ] Keep source content out of audit records.

### Duplicate-read detection

- [ ] Key read observations by canonical path, requested range, and content hash.
- [ ] Detect identical unchanged reads within one session.
- [ ] Return a compact reference when Pi's integration points allow the duplicate payload to be avoided safely.
- [ ] Invalidate prior references when the file hash changes.
- [ ] Design an explicit reread control that remains compatible with Pi's built-in tool contract.
- [ ] Record duplicate-read events without duplicating source content.
- [ ] Verify that deduplication never returns content for a different range or file version.

### Built-in edit metadata

- [ ] Evaluate a Pi-supported result-interception design for the built-in `edit` tool.
- [ ] Preserve the existing transactional multi-replacement input contract.
- [ ] Preserve Pi's per-file mutation queue and concurrency guarantees.
- [ ] Return matched ranges and changed ranges when the host API exposes them safely.
- [ ] Return the resulting content hash.
- [ ] Return structured details for missing, stale, ambiguous, overlapping, and no-op replacements.
- [ ] Identify the specific replacement responsible for an edit failure.
- [ ] Avoid registering a parallel patch or edit tool.

### Read and edit acceptance criteria

- Agents can determine whether previously read content is still current.
- Identical unchanged ranges can be recognized without confusing file versions.
- Edit failures identify the affected replacement and stable failure category.
- Existing read limits, transactional edits, and mutation serialization do not regress.

### Filesystem policy verification

- [ ] Verify canonicalization before authorization for existing paths.
- [ ] Verify canonicalization before authorization for missing write destinations.
- [ ] Verify symlink escape handling for read, write, edit, search, move, and delete operations.
- [ ] Verify path replacement races around authorization and mutation boundaries.
- [ ] Verify that unsupported and unrecognized tools cannot inherit filesystem authorization.
- [ ] Keep Bash explicitly documented as outside the built-in filesystem interceptor.

### Move and delete dry-run behavior

- [ ] Add an explicit dry-run option to the existing `move` tool.
- [ ] Add an explicit dry-run option to the existing `delete` tool.
- [ ] Return canonical affected paths and the policy decisions that real execution would require.
- [ ] Ensure dry-run performs no mutation.
- [ ] Ensure dry-run does not persist mutation authorization.
- [ ] Ensure dry-run authorization cannot be reused implicitly by a later mutating request.
- [ ] Preserve the existing regular-file and destination-collision restrictions.
- [ ] Avoid introducing recursive or broad filesystem mutation.

### Filesystem acceptance criteria

- Canonicalization and symlink tests cover every existing filesystem operation explicitly.
- Dry-run results accurately preview paths and required decisions without changing policy or files.
- Existing move and delete safety properties do not regress.
- No broader mutation authority is introduced.

### Project-command timeout review

- [ ] Record representative durations for each existing project-command definition.
- [ ] Measure legitimate test, build, and analysis durations before changing the current timeout.
- [ ] Define command-specific timeouts only where measurements justify them.
- [ ] Keep a hard upper bound for every command definition.
- [ ] Include the selected timeout in authorization identity review, result fingerprints, and audit metadata.
- [ ] Record confirmation duration separately from process-execution duration.
- [ ] Keep confirmation timeout, process timeout, cancellation, and nonzero exit distinguishable.

### Timeout acceptance criteria

- Timeout values are justified by measured command behavior.
- Every process remains subject to a hard upper bound.
- Changing a security-relevant timeout cannot silently reuse an incompatible authorization or result.
- Audit data identifies which timeout applied and where time was spent.

### Complete audit retention

- [ ] Define a versioned invocation-record format for all existing tools.
- [ ] Record session ID, tool call ID, tool name, extension version, and schema hash.
- [ ] Record validated argument metadata with sensitive values redacted.
- [ ] Record canonical paths and policy decisions where applicable.
- [ ] Record confirmation outcomes, duration, exit status, output size, and truncation state.
- [ ] Record validation-cache and duplicate-read decisions.
- [ ] Avoid retaining environment values, source content, prompts, or complete command output.
- [ ] Define retention and rotation behavior for local audit data.
- [ ] Apply restrictive permissions to audit files and their parent directories.
- [ ] Verify that imported session analysis can correlate records by session ID and tool call ID.

### Session handoff metadata

- [ ] Generate a compact summary of files and ranges read, hashes observed, files changed, commands run, and failures encountered.
- [ ] Make handoff metadata usable by parent agents and subagents without copying source content.
- [ ] Mark reread guidance as advisory.
- [ ] Invalidate handoff evidence when observed file hashes no longer match.
- [ ] Keep handoff metadata bounded and versioned.

### Audit and handoff acceptance criteria

- A failed call can be attributed to one invocation and one active schema.
- Policy and confirmation outcomes are distinguishable without parsing prose.
- Audit retention cannot expose secrets or duplicate large model context.
- Handoffs provide reusable mechanical evidence while remaining safe when files change.

### Using existing tools during development

- [ ] Use policy-controlled `grep`, `find`, and `ls` for normal repository inspection.
- [ ] Record operations that still require Bash and the reason each existing tool was insufficient.
- [ ] Categorize Bash calls by inspection, validation, Git, filesystem, package, and exceptional operations.
- [ ] Record whether an existing narrow tool could have performed each operation.
- [ ] Track successful task completion and workaround cost alongside Bash-call count.
- [ ] Use observed gaps to guide future discussions without preselecting new tools.

### Comprehensive failure-path exercises

- [ ] Test empty and unsafe paths.
- [ ] Test empty and unsafe revisions.
- [ ] Test invalid Git input variants and legacy compatibility.
- [ ] Test missing files, directory reads, and out-of-range reads.
- [ ] Test invalid search expressions and output truncation.
- [ ] Test stale, ambiguous, overlapping, and no-op edits.
- [ ] Test workspace and symlink escapes.
- [ ] Test move destination collisions and delete authorization.
- [ ] Test confirmation timeout, policy denial, and non-interactive behavior.
- [ ] Test duplicate validation requests and relevant-input invalidation.
- [ ] Test duplicate unchanged reads and hash invalidation.
- [ ] Test process timeout, cancellation, and mutating-command authorization.

### Post-implementation session analysis

- [ ] Re-run the session analysis using the same baseline methodology as `findings.md`.
- [ ] Compare failed tool-result rates.
- [ ] Compare malformed input, policy, confirmation, timeout, and command-failure categories.
- [ ] Compare unchanged validation reruns.
- [ ] Compare exact duplicate and repeated reads.
- [ ] Compare Bash usage for operations covered by existing tools.
- [ ] Compare cache-read tokens, output tokens, cost, completion time, and tool-call volume.
- [ ] Check for increased workarounds, unresolved tasks, or subagent count caused by over-restriction.
- [ ] Revise priorities from measured results rather than assumptions.

### Internal-use and measurement acceptance criteria

- Failure and duplicate rates decline without reducing successful task completion.
- Validation calls per coherent edit batch decline.
- Existing narrow tools replace equivalent Bash usage where practical.
- Audit data is sufficient to explain regressions and adjust existing behavior.
- Future capability discussions are grounded in recorded gaps rather than a predetermined tool list.

## Required test strategy

### Unit tests

- [x] Test canonical metadata serialization and hashing.
- [x] Test result-category mapping as pure functions.
- [x] Test diagnostic extraction as pure functions.
- [ ] Test result-fingerprint stability and sensitivity.
- [ ] Test cache eligibility and cache-decision functions.
- [ ] Test force normalization and exclusion from result fingerprints.

### Integration tests

- [x] Exercise session inventory through a realistic mocked Pi extension lifecycle.
- [ ] Execute the same project command twice and assert that the executor runs once when reuse is eligible.
- [ ] Modify a relevant source file and assert that the command executes again.
- [ ] Modify package metadata or a relevant lockfile and assert invalidation where applicable.
- [ ] Change policy after an initial execution and assert that the cached result cannot bypass the new decision.
- [ ] Run a mutating command twice and assert that both requests execute.
- [x] Simulate timeout, spawn failure, cancellation, policy denial, and confirmation timeout.
- [ ] Verify that none of those outcomes becomes reusable.
- [ ] Verify that separate session IDs do not share results.
- [ ] Verify that `force: true` executes and records a forced bypass.

### Regression validation

- [x] Run focused tests for every changed project-command module.
- [x] Run the complete test suite.
- [x] Run lint, which includes TypeScript checking in this project.
- [x] Run the formatter check without rewriting unrelated analysis files.
- [x] Inspect the final Git diff for accidental contract or policy changes.

## Implementation sequence

1. Implement active tool inventory and policy coverage tests. **Completed.**
2. Introduce structured project-command errors and result categories. **Completed.**
3. Add project-command diagnostics, duration, scope, and retry metadata. **Completed.**
4. Define command reuse policies and the relevant-input interface. **Next.**
5. Add versioned result fingerprints.
6. Add session-local result storage and `force` behavior.
7. Enable reuse command by command only after each command's input and mutation tests pass.
8. Extend the stable error contract to the other existing tool families.
9. Add compact measurement records and refine behavior from evidence.

After step 9, select deferred workstreams from measured impact, security risk, and implementation dependencies.
Do not interpret their order in this document as a commitment to implement them sequentially.

## First implementation target

The first implementation target was Phase 1.

It added:

- The runtime extension version loaded from package metadata.
- Canonical schema serialization and SHA-256 hashing.
- Session-start inventory records for configured and active tools.
- Source provenance and inventory version metadata.
- Explicit filesystem-policy coverage tests.

It should not change project-command execution, schemas, authorization identities, or success-result shapes.
It should not add result caching.
It should not add new tools or platform support.

The first pull request is complete when a recorded session inventory can identify the exact active schema and provenance for every available tool without storing sensitive or high-volume content.
