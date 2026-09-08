# Bash Tools Plan

## Status

The implementation is feature-complete for the current 1.0 release scope.

The completed work covers the Git, filesystem, environment, policy, project-command, verify, cache, evidence, authorization, observability, and orchestration contracts documented in the README.

No implementation batch is currently active.

## Previous decisions

This section consolidates the decisions formerly recorded in handoff documents.

### Evidence and cache

- Evidence refs are addressable records, not replay permissions.
- `verify` refs use the `vr_` namespace. Project-command refs use a distinct namespace.
- Lookup requests execute nothing and cannot be combined with execution options.
- `covers` values are opaque, stored verbatim, and participate in evidence identity. The package never interprets orchestration acceptance IDs.
- Project-command script and Fallow commands remain non-reusable even when their evidence is addressable.
- Evidence scope is spawner-controlled and can only be narrowed by a request. An unset scope retains process-local behavior.
- Flow publication is explicit through `publish: { flowId }`; lookup of flow evidence names the flow explicitly.
- Publication requires repository compatibility and valid provenance. A caller publishing into its own effective flow is an accepted no-op.
- Persisted records are bounded, strictly validated, atomically written, lock-protected, and treated as misses when corrupt or unreadable.
- Repository state fingerprints include the content, mode, size, and status of paths reported by Git. Ignored paths are outside the fingerprint.
- A repository-state fingerprint is evidence of state at observation time, not a content lock. Fresh execution and state-drift metadata remain distinct concerns.
- `verify` uses one authorization decision for its resolved command set and preserves the distinction between process status and aggregate verdict.
- Omitted verify phases are visible and produce an incomplete result rather than success.
- `fresh: true` forces verify execution without changing the content-addressed evidence ref. It is invalid with lookup requests.
- Mutability is derived from the resolved command variant where possible. `node_format` and `node_lint:fix` are mutating; `node_format:check`, `node_lint`, and `node_lint:check` are non-mutating. Unknown variants in a family with a writing form are treated conservatively as mutating.
- Shared execution, cache reuse, repository-state invalidation, publication, current-state comparison, and state drift must remain observable without exposing secrets or unbounded output.

### Interface and output decisions

- The public tool catalog is intentionally fixed and rejects arbitrary commands, aliases, shell syntax, watch modes, and dependency installation.
- Validation errors identify the offending field, expected shape, and an actionable example where possible.
- Boolean string coercion is limited to unambiguous accepted forms and is recorded in invocation metadata.
- Git output is bounded, summary-first where applicable, UTF-8 safe, and explicit about truncation.
- Failure tails are bounded and retained only for failed steps. ANSI control sequences are removed from model-facing output.
- Filesystem reads are bounded and batchable. Repeated equivalent reads may return an unchanged result with a stable reference.
- Observability records use one aggregate record per `verify` call and include bounded orchestration, evidence, repository-state, mutability, and reuse metadata when available.
- Public error wording and metadata shapes are compatibility contracts unless a future major release explicitly changes them.

## Remaining scope

### R9: Curated read-only probe surface

This work was intentionally deferred from the completed implementation batches.

- [ ] Evaluate whether the existing tools are discoverable enough to prevent hallucinated shell-style probes.
- [ ] If evidence supports it, add one bounded read-only probe surface for file metadata, directory listing, and Git introspection.
- [ ] Return the closest supported tool when an unknown probe can be intercepted.
- [ ] Keep the surface read-only and bounded; do not expand it into arbitrary command execution.

### Deferred validation and measurement

- [ ] Record before-and-after invocation measurements for project-command validation errors.
- [ ] Record before-and-after measurements for duplicate status requests.
- [ ] Record Git diff result sizes, truncation frequency, summary reuse, and scoped follow-up usage.
- [ ] Confirm no-environment fallback behavior in a separate integration run when the host can provide that environment.

### Deferred quality work

- [ ] Add direct tests for the remaining low-complexity rendering helpers if their CRAP findings are useful to remove:
  - `src/tools/filesystem/read-batch-tool.ts:renderCall`
  - `src/tools/git/log/tool.ts:renderCall`
  - `src/tools/git/status/tool.ts:renderCall`
  - `src/tools/git/show/tool.ts:renderCall`
- [ ] Add platform-specific Linux policy tests where a Linux CI environment is available.
- [ ] Revisit `src/tools/value-validation.ts` only if its fan-in creates a real maintenance problem.
