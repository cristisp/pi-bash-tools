# Artifacts and observability

The extension produces bounded in-process results, optional disk cache records, pi custom session entries, and an optional JSONL invocation stream.

Generated records are diagnostic artifacts and are not authorization inputs.

## Evidence references

`read_batch` references use the `rr_` prefix and are process-local cache references unless the request opts into publication.

Successful `read_batch` results also expose the record's `contentHash` (the lowercase SHA-256 digest of the full file bytes) directly on each item, including unchanged repeats.

A `read_batch` execution may request explicit publication with `publish: { "flowId": "..." }`.

A published `rr_` batch record is stored under the caller's own authorized flow and is resolvable by the `ref` returned in the additive `publish.ref` result field.

A published `rr_` reference is reauthorized and re-read on every lookup; only paths whose current bytes still match the recorded hash return content.

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

### Lookup outcome telemetry

When a session identity is available, `pc_` and `vr_` lookup invocations record an additive bounded `lookup.outcome` field on the invocation record alongside the existing `lookup` block (`attempted`, `success`, `failure`), without changing any model-facing error message or code.

The outcome is one of `success`, `not-found`, `unauthorized-flow`, or `corrupt`; any other value is dropped at persistence time.

`unauthorized-flow` is derived only from the caller's own orchestration context before any store query, so a wrong-flow lookup never probes another scope.

`corrupt` is emitted only where the store detects a present-but-invalid record in-process: the `project_command` root map and in-memory flow maps classify present-but-invalid records as `corrupt`, while the verify cache and all durable disk records are never probed for corruption and clamp to `not-found`.

Expiry is not applicable: lookup records have no TTL, so capacity-trimmed records are indistinguishable from missing records and both report `not-found`.

`rr_` references support the same additive `lookup.outcome` telemetry for lookup requests.

An `rr_` lookup that is unauthorized, missing, or corrupt reports the same generic not-found wording, the wording names only the caller's own flow or no flow, and `unauthorized-flow` is derived only from the caller's own orchestration context before any store query.

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

Producers keep their own record version fields: `pc_` records keep `evidenceFormatVersion: 1`, `vr_` records keep `cacheFormatVersion: 2`, and `rr_` records use the envelope format version both in memory and when published to disk.

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

### Cross-producer repository-state comparison

The `head` field is the only directly comparable workspace field across producers: it holds a Git commit object ID, and exact string equality of two non-null `head` values is authoritative evidence that both producers observed the same commit.

A `head` that is null on either side is unknown state, never a match.

The `repositoryId` and `dirtyDigest` fields are producer-local identities: Bash Tools hashes the realpath of the Git toplevel while Codegraph hashes its canonical root plus Git directory, and the dirty-digest inputs and bounds differ, so cross-producer equality of those fields must never be treated as authoritative.

Any `degraded` status on either side makes the whole cross-producer comparison unknown.

Cross-producer comparison consumes only envelope workspace fields, never private cache records, and no module is imported from the Codegraph extension.

### Semantic result defaults

The default cross-extension semantic result is bounded source snippets, precise file ranges, signatures, and relevance summaries.

Full file bodies are fetched only through Bash Tools' own bounded read tools (`read`, `read_batch`), never through another extension's evidence.

Codegraph evidence reaches Bash Tools only as opaque `cg_` references that Bash Tools never resolves.

The `SharedEvidenceKind` union stays Bash Tools-only and must not be extended to carry Codegraph evidence, because the independence rule forbids importing another extension's modules and `cg_` references stay out-of-band.

## Disk caches

The default cache root is `~/.pi/agent/bash-tools`.

Flow-scoped project-command and verification records are stored below `flows/<flow-id>/project-command/`.

Published `rr_` read evidence records share that flow directory and are keyed by their distinct `rr_` logical reference; they are bounded to 384 KiB per record, 256 KiB of stored content, and 32 entries. Each flow retains at most 128 records in memory, while durable records persist until the shared cache evicts them under the per-record, age, and directory bounds below. A record that meets the content caps but exceeds the 384 KiB serialized bound is rejected with a distinct `published: false` error instead of the unauthorized-publication error.

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

A read-batch invocation that resolves a published `rr_` reference carries the additive `lookup` block (`attempted`, `success`, optional `failure`, and the clamped `outcome`) with empty per-path items and zeroed aggregate content.

When observability is active, read-batch invocations observe repository state and record it as an additive `repositoryState` block that follows the shared evidence envelope workspace shape.

The block carries `repositoryId` (the SHA-256 of the resolved workspace root), `head` and `dirtyDigest` (null when they cannot be derived), and `status` (`readable` when full state was derived, `degraded` otherwise).

Repository-state observation runs only when a recorder and session identity are present, uses the same derivation as `project_command` and `verify`, and never changes read results or errors.

An orchestrated read-batch invocation also carries the additive bounded `role` and `delegationId` fields when the orchestration context provides them.

A read-batch invocation whose request asked to publish read evidence also carries an additive `publication` block with `scope`, an optional bounded `flowId`, `published`, and an optional bounded `error`; the block mirrors the project-command publication shape, which is omitted when no publication was requested.
The block is derived from the result's own `publish` block, so it reflects the realized outcome and is omitted on early failures that return before result shaping, such as request validation or cancellation.

Git read-tool invocations are recorded as `bash-tools.git-invocation` entries.

Each Git record carries the tool name, session and tool-call identity, the schema hash, the requested path-filter count, the outcome reason (`completed`, `cancelled`, `invalid-request`, or `failed`), a bounded error code, duration, an `unchanged` flag for `git_status` and `git_diff` unchanged repeats, an aggregate block with the model-facing result byte count, and the same additive `repositoryState` workspace block described above.

Git invocation records never contain revision expressions, path strings, or output text, and they are omitted when the session identity is unavailable.

An invocation whose request contained an empty optional field also carries an additive bounded `coercions` list naming each applied coercion, and a blocked identical retry carries `retryInvalidation: "invalid-request-repeat"`.

A `git_diff` record carries the effective `mode` (`summary` or `patch`), and a `git_diff` or `git_show` record carries the requested `maxBytes` when the request supplied one; other Git tools record neither field.

A completed invocation also carries `truncated` from the result's truncation block when that block is present, so Git truncation is measurable without parsing result text.

The Git observation uses the identical repository-state reader and derivation as `read_batch`, runs concurrently with the tool's own Git work, and never changes a Git result or error.

Authorization outcomes are recorded as `bash-tools.authorization-outcome` entries.

Each authorization record carries the authorization surface (`project-command`, `verify`, `filesystem`, or `environment`), an optional bounded command or tool identifier, session and tool-call identity, a structured outcome (`authorized`, `allowed-once`, `allowed-and-persisted`, `deferred-persistence`, `deferred-decision-persisted`, `denied`, `denied-once`, `not-authorized`, `confirmation-timeout`, `confirmation-failure`, `dismissed`, `cancelled`, `policy-save-failure`, `policy-load-failure`, `decision-lookup-failure`, `invalid-choice`, `unsafe-global`, or `unchanged-retry-after-denial`), flags for whether a persistent policy decision was written and whether execution was attempted, a flag for whether an approval prompt was emitted, and the bounded prompt wait time.

When a session repeats an unchanged request that was persistently denied or timed out earlier in the same session, the authorization layer rejects the retry as an unchanged retry and records `unchanged-retry-after-denial` without prompting again or writing a policy decision.

Authorization records never contain environment values, path strings, commands, or policy contents, and they are omitted when the session identity is unavailable.

An authorization record may also carry additive optional attribution fields: `mode` (`tui`, `rpc`, `json`, or `print`), `flowId`, and `decisionSource`.

`mode` is the interaction mode the caller observed and is omitted when it is not one of those bounded values.

`flowId` is emitted only when the caller's own orchestration context resolves to the flow evidence scope, never from a request field, and it carries no policy or path data.

`decisionSource` is the configured policy authorization (`deny-global`, `deny-project`, `allow-global`, or `allow-project`) for an outcome that came from an existing decision, or `prompt` when the outcome followed a confirmation prompt; the `prompt` value also applies to a deferred prompted approval when it is committed after the prompt.

It is omitted for policy load and decision lookup failures, `not-authorized`, cancellation, dismissal, and confirmation failure, because no policy decision source exists for those outcomes; a cancellation encountered while committing a deferred prompted approval also omits it, because the decision was not recorded.

The closed set also accepts `unknown` as the clamp target when external input supplies an unrecognized value, but the shared authorization path never emits it: an undetermined outcome omits the field instead.

Determination: an implicit in-project filesystem read or write that the policy does not configure is recorded as `allow-project`, because it is flattened to the same value as a configured project allow inside the decision functions and is not distinguishable without changing decision logic, which this instrumentation does not do.

Recording is best effort from the shared authorization path and never changes an authorization decision, error, or fail-closed behavior; lock-level failures inside the policy store still surface as save failures at this layer.

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

Invocation records may include `flowId`, `delegationId`, `role`, `ref`, `verdict`, `mutating`, `publication`, `lookup` (with the additive clamped `outcome` field), `coercions`, `concurrentExecutions`, `stateDrift`, `sharedExecution`, and aggregate metadata.

A `project-command` invocation record may also carry the additive optional phase durations `preparationDurationMs`, `authorizationDurationMs`, and `queueDurationMs`, each clamped like every other metadata number and omitted when it was never measured.

`preparationDurationMs` spans tool entry to the authorization mark, which is the start of the authorization call, or tool entry to invocation end when the invocation failed during preparation.

`authorizationDurationMs` spans the authorization call only and includes any confirmation prompt wait, so `promptWaitMs` remains the finer breakdown of that prompt.

`queueDurationMs` is recorded only for a single-flight follower that waited on an in-flight execution and covers the wait until that execution settled, and it is omitted on the leader, cache-hit, and other paths.

All three are omitted for evidence-`ref` lookups, which return before preparation, so a lookup record never labels any part of its duration as preparation, authorization, or queue time.

The phase intervals are disjoint, so `preparationDurationMs + authorizationDurationMs + queueDurationMs + executionDurationMs` never exceeds `durationMs`; the unlabeled remainder is the post-authorization preparation gap between the authorization mark and the execution-or-queue mark and is never assigned to a phase.

`executionDurationMs` runs from execution start through record emission, so post-execution result shaping, evidence storage, and publication fall inside `executionDurationMs` rather than in the unlabeled remainder.

Read-batch records add `requestedPaths`, per-item size entries, and an `aggregate` block with `resultBytes` for the full model-facing result text, which supports result-size attribution per read-batch call.

Edit-preflight failure details carry an additive `evidenceBacked: true` flag when a prior `read_batch` observation backed the diagnostic, so the `edit-stale-context` hit rate is measurable from existing details.

`cacheDecision` is one of `miss`, `hit`, `forced`, `ineligible`, or `invalidated`.

`reason` distinguishes cache reuse, forced execution, invalid requests, resolution and policy failures, execution failures, cancellation, lookup failures, and preparation failures.

Process status remains separate from the result category and verification verdict.
