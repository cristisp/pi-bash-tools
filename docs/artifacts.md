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

A denied or failed `verify` call still emits an invocation record with `executed: false` when no phase ran.

String parameters are represented by hashes and lengths where possible, and outputs and raw policy contents are not written to invocation records.

Each record is capped at 8 KiB, and a missing or unwritable path produces a process warning without changing command behavior.

## Useful observability fields

Invocation records may include `flowId`, `delegationId`, `role`, `ref`, `verdict`, `mutating`, `publication`, `lookup`, `coercions`, `concurrentExecutions`, `stateDrift`, `sharedExecution`, and aggregate metadata.

`cacheDecision` is one of `miss`, `hit`, `forced`, `ineligible`, or `invalidated`.

`reason` distinguishes cache reuse, forced execution, invalid requests, resolution and policy failures, execution failures, cancellation, lookup failures, and preparation failures.

Process status remains separate from the result category and verification verdict.
