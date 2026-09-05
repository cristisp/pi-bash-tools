# Subagent Herdr telemetry schema

Telemetry is written as one JSON object per completed delegation turn.

The top-level `v` field is `1`.

`flowId` identifies the orchestration flow when flow persistence is enabled.

`delegationId` identifies one logical delegation and remains stable across reuse turns.

`taskId`, `tier`, `workflowMode`, and `reviewMode` preserve the orchestration identity supplied by the parent.

`workspace`, `label`, `agent`, and `role` identify the child execution.

`parentSession` is the immediate parent session when known.

`rootSession` is the explicit root Pi session attribution and is preferred for root-level aggregation.

`parentPaneId` is the pane that directly launched the child.

`reused` and `reuseCount` describe whether this turn reused an existing child session.

`outcome` is `settled`, `failed`, or `aborted`.

`usage` contains provider-reported input, output, cache, cost, context, and turn totals.

`metrics` contains extension-measured duration, tool calls, failed tool calls, repeated reads, manifest-protected rereads, discovery calls, validation passes, output tokens, message counts, and interaction wait time.

`budget` contains the role limits, observed usage, breach records, enforcement outcome, and whether automatic steering entered report-only mode.

`report` contains full-report token size, delivered digest token size, truncation status, ledger parsing status, and the persisted report path.

`ledgerRevision` and `ledgerInjection` identify the flow-ledger revision and the route used to provide its pointer to the child.

`scope` records the assigned paths, hunks, and explicit out-of-scope areas.

`reviewSurfacePath` identifies the one flow-level status, diff-stat, and hunk-header snapshot shared by fan-out children.

`readManifest` records the child-visible artifact paths, allowed paths, prior reports, established evidence, do-not-reread paths, and its persisted flow artifact reference.

Analyzer guidance:

- Group by `rootSession` for root-owned activity.
- Group by `flowId` for one orchestration flow.
- Group by `delegationId` before comparing fresh and reused turns.
- Use `metrics` for extension-measured behavior and `usage` for provider-reported token accounting.
- Treat missing optional attribution as unknown rather than assigning a root from the child session file.
- Treat `budget.breaches` as evidence of enforcement, not as a replacement for `outcome`.
- Compare `reviewSurfacePath` within a `flowId` to verify that siblings share one review acquisition.
- Use `readManifest.persistedPath` to inspect the manifest after temporary prompt files have been removed.
- Treat `metrics.manifestRereads` as a warning signal for subsequent reads of manifest-protected paths and inspect the corresponding evidence gap before reusing the session.
- Read `metrics.validationRefs` for the tool-issued `verify` refs a child minted or resolved. `lookup: true` means the child resolved existing evidence instead of running the gate, and a ref only resolves inside the flow that minted it. `head` and `stateDigest` record the repository state the evidence was minted against; refs inside one flow that carry different digests are evidence that crossed a repository state, and `verify:N ran:M` in the spend line counts references against executions.
