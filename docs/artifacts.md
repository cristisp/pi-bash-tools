# Artifacts and handoffs

The extension stores durable orchestration state below the Pi agent directory.
For a typical installation, that means `~/.pi/agent`.
The store is best-effort: an unwritable store should not stop delegation, but the affected measurement or handoff artifact is unavailable.

## Durable flow artifacts

A flow id is derived from the root Pi session and is shared by its child delegations.
The flow directory is:

```text
~/.pi/agent/subagent-herdr/flows/<flowId>/
```

It contains:

| Path | Contents and lifecycle |
| --- | --- |
| `flow.json` | Flow id, root session, participants, timestamps, and the highest ledger revision ever issued. |
| `ledger.md` | Append-only dispatch and result revisions. It is owner-written and mode `0400`, so children cannot record their own verdicts. |
| `reports/<label>-<timestamp>.md` | Full settled role reports with identity, scope, manifest, and completion metadata. |
| `predigest/review-surface.md` | Bounded snapshot with per-file SHA-256 content hashes for the first `MAX_DIRTY_PATHS` dirty paths, diff stat, working-tree status, and diff hunk headers, all read from the repository root, for a scoped delegation. It refreshes whenever the status codes, the diff stat, the head, the capped worktree delta, the hunk-header digest, or a hashed path changes, including a same-size edit that leaves the diff stat untouched and a permission change on an already dirty file; paths come from a NUL-separated status read, so a non-ASCII name is hashed rather than quoted and a symlink is hashed by its target string, while a failed git read, an incomplete hashing window, or any other path it cannot address or read (except a deletion) taints the fingerprint and forces a refresh instead of reuse. |
| `predigest/surfaces/review-surface-r<N>.md` | Retained earlier revisions of the review surface (newest 10, created only once a revision is superseded), so a later reviewer can compare per-file hashes across rounds. |
| `predigest/manifests/<delegationId>.json` | Persisted read manifest for the delegation's allowed paths and established artifacts. |
| `predigest/refs/<delegationId>.json` | Per-turn knownRefs record: the `vr_` validation refs and published `rr_` read refs observed in that turn, capped per turn. |

The flow directory is created when a flow-backed delegation needs it.
Its manifest tracks participants and liveness.
Idle flow directories are pruned at session start after `flowRetentionDays`, which defaults to 14 days.

## Session and registry artifacts

Fresh children use session files named like `~/.pi/agent/sessions/subagent-<workspace>-<label>.jsonl`.
Closing a tab removes its registry entry but preserves its session file.

The registry is `~/.pi/agent/subagent-herdr.json`.
It records workspace and tab identity, session file, current status, reuse count, recent task history, delegation identity, scope, review surface, read manifest, budget, and the last run summary.
It stores only bounded failure text and report metadata for successful runs, not successful report prose.

Registry entries are workspace-scoped and use a file lock for concurrent updates.
They move from `running` to `done` when the child settles.
Reusing a label changes it back to `running` for one turn and then locks it again at delivery.

## Temporary artifacts

Each launch uses temporary task and system-prompt files with restrictive permissions.
A scoped launch also writes a temporary `read-manifest.json`.
These files are removed after the run, while the flow copy of the manifest and the child session file remain.

A read manifest gives the child bounded recovery and audit context:

- Which flow artifacts are available.
- Which repository paths are allowed by the delegation scope.
- Which prior reports and established evidence exist.
- Which known evidence refs can be confirmed through their minting tools.
- Which review-surface paths should not be reread unless a named evidence gap requires it.
- Which dirty paths were present in the review-surface snapshot, and where the snapshot and its retained revisions live.

The review surface is content-derived: the snapshot fingerprint covers the status codes, the diff stat, the git head, a capped binary delta of the worktree against the head, a digest of the hunk-header read, and bounded SHA-256 content hashes for the first `MAX_DIRTY_PATHS` dirty paths, so an edit that changes no line counts still invalidates the revision.
The binary delta is what makes the fingerprint complete for tracked content: it is not a sample, so it sees a content change of any size at any path, and it sees permission changes, which neither the status codes nor the diff stat show.
Untracked files are listed individually, so a collapsed untracked directory cannot hide a change, and the diff stat remains human-readable evidence whose line counts also enter the fingerprint.
A window that leaves a dirty path out - more than `MAX_DIRTY_PATHS` dirty paths, or a path longer than `MAX_DIRTY_PATH_LENGTH` - makes the fingerprint incomplete, so such a tree is refreshed on every delegation instead of being reused.
The status read is NUL-separated with renaming disabled, so git's line-mode C-quoting cannot turn a non-ASCII or escaped path into an unhashable literal, a rename appears as a delete plus an add with both sides hashed, and a dirty symlink is hashed by its target string so repointing it refreshes the revision even when the target bytes are unchanged.
A dirty path whose name does not round-trip through a JavaScript string is refused instead of hashed, because the decoded name could address a different file than the one git reported, and the refusal taints the fingerprint.
Every git read runs from the repository root, so paths stay root-relative and a delegation rooted in a subdirectory still hashes the right files; the header records repository facts only, because the snapshot belongs to the flow rather than to one delegation.
Fail closed by outcome rather than by cause: a failed git read of any kind, including a delta or hunk-header read too large for the read bound to hold in full, or any hash that stays `(unavailable)` for a path whose status code is not a deletion, taints the fingerprint and forces a new revision instead of reuse, so a path the snapshot cannot address or read is never served as unchanged.
The hunk-header read compares against the head like the stat and delta reads, so a staged change reaches that section, its digest is exposed in the header next to the worktree delta, and a read that fails renders `(unavailable)` instead of looking like a tree without hunks.
A dirty path that is not a regular file - a submodule checkout, or a tracked file replaced by a FIFO - has no readable content, so it counts as unreadable and refreshes on every delegation rather than opening something a FIFO would leave blocking; git neither lists nor tracks other non-regular files, so an untracked FIFO cannot reach the hash in the first place. That churn is the accepted fail-closed cost.
Residual bounds: an equal-size edit strictly between the head and tail windows of an untracked path above the hashing bound is not covered by that path's `(partial)` hash, and git-ignored paths are outside the snapshot by design.
Changes git itself does not model - the permission bits of a clean tracked file, ownership, extended attributes, or an empty directory - are outside the snapshot's change set, which describes what git reports for the worktree plus the bytes and permission bits of every dirty path.
Paths above the hashing bound are hashed as their first bytes, their size, and a tail window and marked `(partial)`; paths that cannot be read are marked `(unavailable)`.
The hash section and diff stat precede the working-tree status, so the snapshot size cap spends itself on the status text and the hunk tail rather than the hashes or diff stat; the full stat is still in the fingerprint.
An unusable retention directory costs the earlier revisions, never the refreshed snapshot, and the read-only reuse path writes no snapshot revision (only the flow lock file is created and removed around the call).
The generated compact handoff cites the snapshot path, revision, and head; the fingerprint and the worktree delta and hunk digests live in the snapshot header, and because the extension cannot observe a harness validation digest, handoffs cite that digest from the validation evidence instead of expecting the snapshot to embed it.

Normal handoffs carry the manifest pointer and a compact summary without requiring the child to preload this file.
A named stale, rejected, ambiguous, or otherwise required evidence gap permits one bounded manifest or ledger reacquisition.
Failed or stale evidence remains `NOT_RUN`, and runtime scope and tool permissions remain authoritative.

The manifest is guidance and audit context.
Runtime scope and tool permissions remain authoritative.

## Creation and consumption order

1. The extension derives the flow and delegation identity.
2. It creates or refreshes the review surface when the delegation needs one.
3. It appends a ledger `dispatch` revision.
4. It writes the child task, system prompt, and read manifest.
5. It allocates the label, session file, herdr tab, and registry entry.
6. The child receives the compact current handoff and works in the shared checkout.
   It reads the ledger or manifest only for a named bounded recovery, explicit full-context handoff, or required audit task.
7. On settlement, the extension writes the full role report and computes the bounded digest.
8. It appends a ledger `result` revision, updates the registry, and writes telemetry.
9. The parent consumes the digest for immediate routing and reads the report or ledger path for details.
10. Later roles consume existing reports and validation references instead of rereading everything.

If a report omits its ledger block, the digest still carries status lines and leading prose.
The `reportContractPolicy` setting controls whether that omission is flagged or treated as unfinished.
Reviewer reports also require a `## Files Reviewed` section.

## Telemetry

The append-only telemetry file is `~/.pi/agent/subagent-herdr.telemetry.jsonl`.
It records delegation identity, flow, role, tier, mode, scope, reuse, outcome, usage, budgets, reports, validation references, context mode and reason, read-manifest status, and wait time.
Separate typed events record composition warnings or refusals, S4 preflights, and correlated child outcomes.

`npm run test:analyze` reads live telemetry and flow stores to generate the measurement report in `analysis/MEASUREMENT.md`.
That generated report must not be edited by hand.
`npm run s4:gate` writes a separate S4 decision artifact and never rewrites the measurement report.

## External validation artifacts

Validation references are issued by the installed validation producers, not by this extension's flow store.
The extension records their refs, verdicts, freshness, repository state, and flow provenance in run summaries, reports, ledger fields, and telemetry.
See [Validation and evidence](evidence.md) for how those references are consumed.

## Producer evidence publication

A child that runs `verify`, `project_command`, or `read_batch` can share completed evidence with its flow siblings by adding `publish: { flowId }` with the flow id of its delegation.
The producers check that request against the flow id they resolve from the environment, so a delegation can only publish into its own flow.
The extension exports `PI_ORCHESTRATION_FLOW` into delegation launch commands and sets it in the root session process itself, so the root and its children resolve the same flow id, and the installed producers read it: `@ztc/bash-tools` reads it directly, and `@ztc/codegraph-runner` reads `CODEGRAPH_RUNNER_FLOW` first and falls back to `PI_ORCHESTRATION_FLOW`.
Each producer writes to its own store and issues its own reference shape: `rr_` for bash-tools read and validation evidence, `cg_` for codegraph-runner artifacts.
Siblings resolve a producer reference with the producer's own lookup surface: the `verify` and `read_batch` lookup forms for bash-tools references, and `codegraph_artifact` for codegraph references.
Use `{ ref }` as the default `read_batch` lookup shape; `flowId` and `covers` are optional lookup-only fields in the current bash-tools contract.
Resolving a `cg_` reference needs only the opaque ref plus its flow scope, so a sibling of the same flow resolves it without herdr involvement.
Published `rr_` read refs, like `vr_` validation refs, are projected into the flow's `knownRefs` for later turns: a read ref carries `kind: "read"` and no verdict, and only refs whose minting call published to the flow are advertised, because a `read_batch` ref is session-scoped otherwise.
This extension never enumerates or reads the producer stores; the refs recorded in reports, ledger fields, telemetry, and manifest `knownRefs` are the only transport.
