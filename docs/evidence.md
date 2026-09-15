# Validation and evidence

## Ownership

The session that changes files owns the composite validation gate.
In a parallel fan-out, the session that integrates the combined state owns the gate.
Siblings should run focused read-only checks or no composite check.
A gate run while another sibling is editing describes the union of an in-flight tree and is not reliable evidence for either change.

The standard worker flow runs one composite `verify` after the last implementation change and reports the returned reference.
A validator resolves that reference first and executes only uncovered or independently required checks.
A reviewer only looks up references and never executes project validation.

## Reference lifecycle

The `verify` tool runs the project's format, lint, typecheck, and test phases in order when called as an execution request.
A pure lookup has the shape `{ ref, flowId?, covers? }` and executes nothing.
`fresh: true` requests execution rather than lookup.
`publish: { flowId }` publishes completed evidence for flow consumers rather than coordinating an active execution.

A reference is tied to the command, coverage scope, and repository state.
Consumers must confirm:

- The reference can be resolved in the current process or flow.
- Its verdict is usable and its `covers` include every required acceptance or finding id.
- `repositoryStateStatus` is `matches`.
- The required phases were not omitted.
- Its freshness is recorded as `executed`, `reused`, or `resolved`.

`resolved` means a consumer looked up stored evidence and ran nothing.
It is not a validation pass.
A `mismatch` or `unreadable` repository state is not evidence of success.
A resolved ref is evidence only when its lookup succeeded, and a failed, stale, or not-found lookup is `NOT_RUN` or otherwise unverified.

References minted by a child seat in a flow can be resolved by its siblings and travel upward in the child report.
Validation refs share the manifest with `read_batch` evidence refs: manifest `knownRefs` entries carry a kind, `vr_` verify refs resolve through a verify ref lookup, and `kind: "read"` entries are `rr_` read refs that resolve through a `read_batch` ref lookup.
A read ref is advertised only when its minting call published it to the flow, because `read_batch` refs are session-scoped otherwise.
The root session shares the flow id with its children: the extension sets `PI_ORCHESTRATION_FLOW` in the root process at startup, so a reference minted by the root also resolves from children.
The root is not a delegation and can publish evidence outside any orchestration context; consumers still confirm every reference by lookup, so published root evidence is a hint with the same guarantees as any other.
A child with `evidenceScope: "session"` cannot resolve sibling references and must execute the required checks itself.
A child with the default `flow` scope may resolve completed sibling evidence.
A request can narrow scope from `flow` to `session`, but cannot widen the configured policy.

The external producer's flow publication and single-flight behavior are separate concerns.
Publication shares completed evidence, while single-flight coordination is process-local and does not serialize active executions in separate child processes.
This extension therefore keeps its repository write lock enabled by default.
It consumes the producer policy but does not write the producer's policy or store.

## Command permissions

The defaults are intentionally conservative:

- `worker` and `validator` may execute validation.
- Other roles may only resolve a pure `verify` reference.
- `worker` is the default role allowed to run repository-mutating project commands.
- Read-only roles must not use `verify` script overrides because an override can select a writing formatter, lint fix, or snapshot script.

The exact role lists are configurable with `validationExecutionRoles` and `mutatingCommandRoles`.
The runtime classifies known command families conservatively, but the role workflow remains the primary ownership rule.

## Repository write lock

When `repositoryWriteLock` is enabled, a write-capable command takes an exclusive lock for its call.
A validation read refuses to start while another session is writing because it would inspect a half-written tree.
A session is identified by label and flow together, so two flows sharing one checkout still contend.
The lock is keyed by the repository root and stored below `~/.pi/agent/subagent-herdr/repo-locks`.

The lock normally expires after five minutes if a child dies.
An unreadable lock entry is held briefly for corruption recovery, while a lock the current session cannot inspect is not removed early.
The exclusion fails open if the lock store itself is unusable, so a broken coordination store does not wedge every write.
A refusal costs a tool call but no validation pass.
After repeated refusal, report repository contention instead of calling the check a pass.

## Parallel fan-out rule

All parallel children use the same working tree.
Only one owner should run the composite gate after fan-in.
A sibling that runs a formatter, lint fix, build, coverage, snapshot update, or another write-capable check can change the state seen by every other sibling.
The lock prevents concurrent recognized writers and prevents checks from reading during those writes, but it does not turn parallel edits into independent worktrees.
Use separate worktrees when independent full validation is required.
