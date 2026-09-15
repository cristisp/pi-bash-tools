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
| `predigest/review-surface.md` | Bounded working-tree status, diff stat, and diff hunk-header snapshot for a scoped delegation. |
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

A read manifest tells the child:

- Which flow artifacts are available.
- Which repository paths are allowed by the delegation scope.
- Which prior reports and established evidence exist.
- Which review-surface paths should not be reread unless a named evidence gap requires it.
- Which dirty paths were present in the review-surface snapshot.

The manifest is guidance and audit context.
Runtime scope and tool permissions remain authoritative.

## Creation and consumption order

1. The extension derives the flow and delegation identity.
2. It creates or refreshes the review surface when the delegation needs one.
3. It appends a ledger `dispatch` revision.
4. It writes the child task, system prompt, and read manifest.
5. It allocates the label, session file, herdr tab, and registry entry.
6. The child reads the ledger and manifest, then works in the shared checkout.
7. On settlement, the extension writes the full role report and computes the bounded digest.
8. It appends a ledger `result` revision, updates the registry, and writes telemetry.
9. The parent consumes the digest for immediate routing and reads the report or ledger path for details.
10. Later roles consume existing reports and validation references instead of rereading everything.

If a report omits its ledger block, the digest still carries status lines and leading prose.
The `reportContractPolicy` setting controls whether that omission is flagged or treated as unfinished.
Reviewer reports also require a `## Files Reviewed` section.

## Telemetry

The append-only telemetry file is `~/.pi/agent/subagent-herdr.telemetry.jsonl`.
It records delegation identity, flow, role, tier, mode, scope, reuse, outcome, usage, budgets, reports, validation references, and wait time.
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
Resolving a `cg_` reference needs only the opaque ref plus its flow scope, so a sibling of the same flow resolves it without herdr involvement.
Published `rr_` read refs, like `vr_` validation refs, are projected into the flow's `knownRefs` for later turns: a read ref carries `kind: "read"` and no verdict, and only refs whose minting call published to the flow are advertised, because a `read_batch` ref is session-scoped otherwise.
This extension never enumerates or reads the producer stores; the refs recorded in reports, ledger fields, telemetry, and manifest `knownRefs` are the only transport.
