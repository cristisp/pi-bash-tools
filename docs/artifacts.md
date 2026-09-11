# Artifacts and observability

The extension produces bounded in-process results, optional disk cache records, pi custom session entries, and an optional JSONL invocation stream.

Generated records are diagnostic artifacts and are not authorization inputs.

## Evidence references

`read_batch` references use the `rr_` prefix and are process-local cache references.

`project_command` evidence references use the `pc_` prefix.

`verify` evidence references use the `vr_` prefix.

Evidence references are non-replayable lookups, not commands and not permission grants.

A lookup with `ref` returns stored evidence without executing a command.

Root-session evidence is process-local by default.

Flow-scoped evidence is available only to the effective authorized flow and is stored under the flow cache directory.

An execution may request explicit publication with `publish: { "flowId": "..." }` after authorization and compatible repository-state checks.

Publication is reported only after the destination write succeeds.

Lookups with a `flowId` succeed only when the caller has the same effective flow scope.

Evidence includes opaque `covers`, producer provenance, repository state, and current-state comparison when available.

## Shared evidence envelope

Bash Tools evidence records carry a producer-neutral envelope so that evidence metadata from participating extensions can be compared without importing another extension's implementation modules.

The envelope format version is `1` and is tracked by the constant `EVIDENCE_ENVELOPE_FORMAT_VERSION` in `src/evidence/envelope.ts`.

Envelope fields are additive on top of each producer's own record shape:

- `producer` is `bash-tools` for every Bash Tools record; Codegraph records use `codegraph-runner`.
- `kind` is `project-command` for `pc_` records, `verify` for `vr_` records, and `read-batch` for `rr_` records.
- `scope` is `session` or `flow` where the record has no other scope carrier.
- `requestHash` and `contentHash` are lowercase SHA-256 hex digests over canonical JSON of the request identity and the stored result identity respectively.
- `workspace` is an optional block with `repositoryId` (the SHA-256 digest of the canonical repository identity), `head`, `dirtyDigest`, and `status` (`readable` or `degraded`).
- `output` is an optional block with `truncated`, `totalBytes`, and `totalLines`.

The canonical repository identity and raw paths stay inside producer-owned records; the envelope carries only the digested `repositoryId`.

Producers keep their own record version fields: `pc_` records keep `evidenceFormatVersion: 1`, `vr_` records keep `cacheFormatVersion: 2`, and in-memory `rr_` records use the envelope format version.

### Compatibility and version negotiation

Envelope fields are additive and independently optional.

Record validators accept stored records with and without envelope fields so existing on-disk records remain valid.

A change to the shared envelope field set bumps `EVIDENCE_ENVELOPE_FORMAT_VERSION`.

Consumers that encounter an unknown envelope version or unknown fields must treat those fields as absent rather than fail, and must never execute, replay, or reinterpret an evidence reference from another producer.

Evidence references remain producer-owned, opaque, and non-replayable; the orchestration layer may transport references but must not resolve them.

### Root to session scope mapping

Root-session evidence uses the envelope scope name `session`, and flow-scoped evidence uses `flow`.

The internal `root` scope name used by verify provenance maps to the envelope name `session` without changing any stored value or widening authorization.

A `session` envelope scope still means process-local evidence that becomes cross-process only after explicit publication to an authorized flow.

### Workspace digest comparison

Within one producer's records, two workspace blocks describe the same repository state when `repositoryId`, `head`, and `dirtyDigest` are all equal non-null digests.

Digest derivations are producer-specific: `repositoryId` hashes each producer's canonical repository identity, and `dirtyDigest` summarizes each producer's dirty-state observation, so cross-producer equality is meaningful only for fields both producers derive identically, such as the Git `head` object ID.

A missing or null `head` or `dirtyDigest` is unknown state and must be treated as a mismatch for reuse decisions, never as a match.

The `workspace` block describes Git workspace freshness only; Codegraph index freshness lives in the Codegraph `producerState` block and stays distinct.

A `degraded` status means the producer could not fully observe the workspace and consumers must not treat the block as a complete identity.

## Disk caches

The default cache root is `~/.pi/agent/bash-tools`.

Flow-scoped project-command and verification records are stored below `flows/<flow-id>/project-command/`.

Disk cache files use hashed logical request keys and JSON records rather than user-provided filenames.

Entries are validated before use, capped at 2 MiB per record, evicted after seven days by default, and bounded to 50 MiB per cache directory.

Cache writes use temporary files, atomic rename, and lock files with stale-owner handling.

Cache coordination may briefly create `flows.lock`, per-entry claim files, owner-token files, and temporary files under the cache root.

Root-session result caches remain in memory and do not become durable unless explicitly published to an authorized flow.

## Pi session entries

At session start, the extension records a tool inventory custom entry when that inventory snapshot has not already been recorded in the process.

The inventory entry type is `bash-tools.tool-inventory`.

The inventory format contains `inventoryFormatVersion`, `extensionVersion`, `sessionId`, `sessionStartReason`, `hashAlgorithm: "sha256"`, `activeTools`, and `tools`.

Each tool entry contains its name, active state, source information, and a SHA-256 schema hash.

The inventory describes the complete active tool snapshot visible to the extension, not only tools owned by Bash Tools.

Consumers must use each tool's source information when attributing ownership and must not treat the custom-entry producer as the owner of every listed tool.

The inventory `extensionVersion` identifies the Bash Tools version that emitted the entry, while inventory format versions, tool schema hashes, Node versions, and pi versions are separate identities and are not substitutes for the extension version.

Project-command invocations are recorded as `bash-tools.project-command-invocation` entries.

One aggregate invocation record is emitted for each `verify` call rather than one record per phase.

Read-batch invocations are recorded as `bash-tools.read-batch-invocation` entries.

Each read-batch record carries the session and tool-call identity, the requested path count, per-path size entries (path hash and length, range, unchanged and truncation flags, file bytes and line totals, returned content bytes, evidence reference, and error code), an aggregate block (model-facing result bytes, returned content bytes, file bytes and line totals, and unchanged, truncated, and error counts), duration, and the evidence scope.

Read-batch records never contain path strings or file content, and they are omitted when the session identity is unavailable.

When observability is active, read-batch invocations observe repository state and record it as an additive `repositoryState` block that follows the shared evidence envelope workspace shape.

The block carries `repositoryId` (the SHA-256 of the resolved workspace root), `head` and `dirtyDigest` (null when they cannot be derived), and `status` (`readable` when full state was derived, `degraded` otherwise).

Repository-state observation runs only when a recorder and session identity are present, uses the same derivation as `project_command` and `verify`, and never changes read results or errors.

At session shutdown, the extension emits a `bash-tools.project-command-summary` entry for the active session when possible.

The summary aggregates invocation count, cache decisions, result categories, process statuses, durations, output bytes, truncation counts, measurements, and a bounded set of schema hashes.

Custom-entry persistence failures are ignored and do not change tool results.

### Telemetry importer requirements

Pi custom entries are top-level session records rather than tool-result payload fields.

External telemetry importers that need version-aware analysis must preserve the custom-entry type, JSON data, session identity, ordering, and timestamp when present.

Discarding `bash-tools.tool-inventory` entries prevents reliable historical attribution of extension versions, active tools, and schema hashes.

Importers should join inventory records through their explicit session identity and should report missing or multiple version observations as unknown or ambiguous rather than assigning a version by timestamp proximity.

Historical analysis must not infer an extension version from current source files or an installed extension.

## Optional invocation JSONL stream

Set `BASH_TOOLS_INVOCATIONS_PATH` to an absolute file path to enable the producer-owned JSONL stream.

`BASH_TOOLS_INVOCATION_STREAM` and `BASH_TOOLS_TELEMETRY_PATH` are accepted as lower-priority aliases.

The canonical variable is selected first when multiple variables are set.

The selected path is read when each record is emitted, and parent directories are created as needed.

Each bounded invocation record is appended as one newline-delimited JSON object with append mode.

The stream contains the same compact records sent to pi custom entries, including execution decisions, evidence references, repository metadata, lookup outcomes, and failed or denied requests.

Read-batch invocation records use the same stream and follow the same privacy and bounding rules as project-command records.

A denied or failed `verify` call still emits an invocation record with `executed: false` when no phase ran.

String parameters are represented by hashes and lengths where possible, and outputs and raw policy contents are not written to invocation records.

Each record is capped at 8 KiB, and a missing or unwritable path produces a process warning without changing command behavior.

## Useful observability fields

Invocation records may include `flowId`, `delegationId`, `role`, `ref`, `verdict`, `mutating`, `publication`, `lookup`, `coercions`, `concurrentExecutions`, `stateDrift`, `sharedExecution`, and aggregate metadata.

Read-batch records add `requestedPaths`, per-item size entries, and an `aggregate` block with `resultBytes` for the full model-facing result text, which supports result-size attribution per read-batch call.

`cacheDecision` is one of `miss`, `hit`, `forced`, `ineligible`, or `invalidated`.

`reason` distinguishes cache reuse, forced execution, invalid requests, resolution and policy failures, execution failures, cancellation, lookup failures, and preparation failures.

Process status remains separate from the result category and verification verdict.
