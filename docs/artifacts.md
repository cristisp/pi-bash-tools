# Artifacts and observability

The extension produces bounded in-process results, optional disk cache records, pi custom session entries, and an optional JSONL invocation stream.

Generated records are diagnostic artifacts and are not authorization inputs.

## Evidence references

Successful `read_batch` results expose the record's `contentHash` (the lowercase SHA-256 digest of the full file bytes) directly on each item, including unchanged repeats.

Read evidence is no longer published or resolvable across sessions; the repeated-read cache is process-local and the content hash identifies unchanged repeats.

`project_command` evidence references use the `pc_` prefix.

A `project_command` execution reports the deterministic `pc_` audit reference in `details` as `ref`; the reference never enters model-facing content.
The reference is derived from the result itself, so it needs no store.
A failing or cancelled execution reports the `pc_` reference in the failure or cancellation message and keeps `ref` in its error details and invocation records.

`project_command` no longer publishes evidence to flows and no longer accepts lookup requests; the retired fields (`ref`, `flowId`, `covers`, and `publish`) are rejected with an `invalid-request` error.

`verify` evidence references use the `vr_` prefix.

Evidence references are non-replayable lookups, not commands and not permission grants.

A `verify` lookup with `ref` returns stored evidence without executing a command.

Root-session evidence is process-local by default.

Flow-scoped evidence is available only to the effective authorized flow and is stored under the flow cache directory.

Completed `verify` runs publish their evidence to the effective flow scope automatically; no request field is involved, and outside a flow nothing is published.

Publication is reported only after the destination write succeeds; when the run cannot publish (unreadable or drifted repository state, or no compatible stable evidence), the result reports a best-effort `publication` with `published: false` and a bounded error instead of failing.

Lookups are `{ ref }` alone; the lookup flow is derived from the effective flow scope, and the retired lookup-time `flowId` and `covers` fields are rejected.

### Lookup outcome telemetry

When a session identity is available, `vr_` lookup invocations record an additive bounded `lookup.outcome` field on the invocation record alongside the existing `lookup` block (`attempted`, `success`, `failure`), without changing any model-facing error message or code.

The outcome is one of `success`, `not-found`, `unauthorized-flow`, or `corrupt`; any other value is dropped at persistence time.

`unauthorized-flow` stays in the shared outcome set, but no current producer emits it: verify lookup flows are derived from the caller's own environment and can never name another scope.

`corrupt` is emitted only where the store detects a present-but-invalid record in-process: the verify cache and all durable disk records are never probed for corruption and clamp to `not-found`.

Expiry is not applicable: lookup records have no TTL, so capacity-trimmed records are indistinguishable from missing records and both report `not-found`.

## Shared evidence envelope

Bash Tools evidence records carry a producer-neutral envelope so that evidence metadata from participating extensions can be compared without importing another extension's implementation modules.

The envelope format version is `1` and is tracked by the constant `EVIDENCE_ENVELOPE_FORMAT_VERSION` in `src/evidence/envelope.ts`.

Envelope fields are additive on top of each producer's own record shape:

- `producer` is `bash-tools` for every Bash Tools record; Codegraph records use `codegraph-runner`.
- `kind` is `verify` for `vr_` records; the `read-batch` and `project-command` kinds are retired and no producer emits them.
- `scope` is `session` or `flow` where the record has no other scope carrier.
- `requestHash` and `contentHash` are lowercase SHA-256 hex digests over canonical JSON of the request identity and the stored result identity respectively.
- `workspace` is an optional block with `repositoryId` (the SHA-256 digest of the canonical repository identity), `head`, `dirtyDigest`, and `status` (`readable` or `degraded`).
- `output` is an optional block with `truncated`, `totalBytes`, and `totalLines`.

The canonical repository identity and raw paths stay inside producer-owned records; the envelope carries only the digested `repositoryId`.

Producers keep their own record version fields: `vr_` records keep `cacheFormatVersion: 3`.

The retired `pc_` record store and its versioned canonical record shape were removed with `pc_` publication; the surviving `pc_` reference is a deterministic audit identifier derived from result details and needs no stored record.

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

### Semantic result defaults

The default cross-extension semantic result is bounded source snippets, precise file ranges, signatures, and relevance summaries.

Full file bodies are fetched only through Bash Tools' own bounded read tools (`read`, `read_batch`), never through another extension's evidence.

Codegraph evidence reaches Bash Tools only as opaque `cg_` references that Bash Tools never resolves.

The `SharedEvidenceKind` union stays Bash Tools-only and must not be extended to carry Codegraph evidence, because the independence rule forbids importing another extension's modules and `cg_` references stay out-of-band.

## Disk caches

The default cache root is `~/.pi/agent/bash-tools`.

Setting `BASH_TOOLS_CACHE_ROOT` to an absolute directory relocates the cache root for every durable cache surface and the maintenance passes; relative, empty, or unset values keep the default.

Flow-scoped verification records are stored below `flows/<flow-id>/project-command/`.

Disk cache files use hashed logical request keys and JSON records rather than user-provided filenames. Each `vr_` verification record is written once, keyed by its own reference, so request-key and reference lookups resolve the same durable record; records from the earlier double-written key layout stay resolvable by reference until they are overwritten or evicted.

Entries are validated before use, capped at 2 MiB per record, evicted after seven days by default, and bounded to 50 MiB per cache directory.

Cache writes use temporary files, atomic rename, and lock files with stale-owner handling.

Cache coordination may briefly create `flows.lock`, per-entry claim files, owner-token files, and temporary files under the cache root.

Root-session result caches remain in memory and do not become durable unless published to a flow; completed `verify` runs inside a flow publish automatically.

### Cache maintenance

Expired and over-capacity records under all flow directories are pruned with the same age and byte-cap policy as lazy eviction on a cache write.

The extension runs one bounded prune pass on every session start with a 500 ms wall-clock budget and fails soft, so session start is never delayed or broken by prune failures.

The `/bash-tools-prune` command runs the same prune pass with a 10 s budget and reports the removed file count, removed bytes, scanned directory count, and whether the pass hit the time budget.

A prune pass takes the shared cache lock once and skips silently with a lock-busy notice when another session holds it.

The same pass reclaims orphaned temp files that an interrupted cache write could leave behind (`<hash>.json.<pid>.<hex>.tmp`), deleting only files matching that exact pattern and only when they are older than one minute.

Fresh-looking, pattern-mismatched, and coordination files (`flows.lock`, `*.claim`, owner tokens, and records) are never touched; the summary reports reclaimed temp files separately from records.

## Pi session entries

At session start, the extension records a tool inventory custom entry when that inventory snapshot has not already been recorded in the process.

The inventory entry type is `bash-tools.tool-inventory`.

The inventory format contains `inventoryFormatVersion`, `extensionVersion`, `sessionId`, `sessionStartReason`, `hashAlgorithm: "sha256"`, `activeTools`, and `tools`.

Each tool entry contains its name, active state, source information, and a SHA-256 schema hash.

Format 2 entries additively record bounded SDK metadata per tool when the runtime provides it: the allowlisted `exposure` value, the bounded `namespace` name, and allowlisted boolean `annotations` hints.
The fields are omitted when absent or invalid, so entries emitted against older pi versions remain identical to format 1 entries apart from `inventoryFormatVersion`.

The inventory describes the complete active tool snapshot visible to the extension, not only tools owned by Bash Tools.

Consumers must use each tool's source information when attributing ownership and must not treat the custom-entry producer as the owner of every listed tool.

The inventory `extensionVersion` identifies the Bash Tools version that emitted the entry, while inventory format versions, tool schema hashes, Node versions, and pi versions are separate identities and are not substitutes for the extension version.

Project-command invocations are recorded as `bash-tools.project-command-invocation` entries.

One aggregate invocation record is emitted for each `verify` call rather than one record per phase.

Read-batch invocations are recorded as `bash-tools.read-batch-invocation` entries.

One invocation record is emitted per execute call, and the outcome reason is one of `completed`, `cancelled`, `invalid-request`, or `failed`.

Each read-batch record carries the session and tool-call identity, the requested path count, per-path size entries (path hash and length, range, unchanged and truncation flags, file bytes and line totals, returned content bytes, and error code), an aggregate block (model-facing result bytes, returned content bytes, file bytes and line totals, and unchanged, truncated, and error counts), duration, and the evidence scope.

Read-batch records never contain path strings or file content, and they are omitted when the session identity is unavailable.

When observability is active, read-batch invocations observe repository state and record it as an additive `repositoryState` block that follows the shared evidence envelope workspace shape.

The block carries `repositoryId` (the SHA-256 of the resolved workspace root), `head` and `dirtyDigest` (null when they cannot be derived), and `status` (`readable` when full state was derived, `degraded` otherwise).

Repository-state observation runs only when a recorder and session identity are present, uses the same derivation as `project_command` and `verify`, and never changes read results or errors.

An orchestrated read-batch invocation also carries the additive bounded `role` and `delegationId` fields when the orchestration context provides them.

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

`role` and `delegationId` are additive attribution fields carried from the caller's orchestration context when it reports an orchestrated child session with those identifiers; every authorization surface emits them when its caller passes that context, they are bounded and omitted like the other identifier fields, and no behavior gates on them.

`decisionSource` is the configured policy authorization (`deny-global`, `deny-project`, `allow-global`, or `allow-project`) for an outcome that came from an existing decision, or `prompt` when the outcome followed a confirmation prompt; the `prompt` value also applies to a deferred prompted approval when it is committed after the prompt.

It is omitted for policy load and decision lookup failures, `not-authorized`, cancellation, dismissal, and confirmation failure, because no policy decision source exists for those outcomes; a cancellation encountered while committing a deferred prompted approval also omits it, because the decision was not recorded.

The closed set also accepts `unknown` as the clamp target when external input supplies an unrecognized value, but the shared authorization path never emits it: an undetermined outcome omits the field instead.

Determination: an implicit in-project filesystem read or write that the policy does not configure is recorded as `allow-project`, because it is flattened to the same value as a configured project allow inside the decision functions and is not distinguishable without changing decision logic, which this instrumentation does not do.

Recording is best effort from the shared authorization path and never changes an authorization decision, error, or fail-closed behavior; lock-level failures inside the policy store still surface as save failures at this layer.

At session shutdown, the extension emits a `bash-tools.project-command-summary` entry for the active session when possible.

The summary aggregates invocation count, cache decisions, result categories, process statuses, durations, output bytes, truncation counts, and a bounded set of schema hashes.

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

Invocation records may include `flowId`, `delegationId`, `role`, `ref`, `verdict`, `mutating`, `publication`, `lookup` (with the additive clamped `outcome` field), `coercions`, `concurrentExecutions`, `stateDrift`, `sharedExecution`, `retryable`, and aggregate metadata; the publication and lookup fields are populated only by `verify`.

Project-command rejection records preserve the same `resultCategory`, `executed`, and `retryable` values exposed in `tool_result.details`.

An executed failure such as `FORMAT_FAILURE` is recorded with `executed: true`, while invalid, policy, and resolution failures are recorded with `executed: false`.

Repeated identical executed-failure records can be recognized as orchestration churn by their stable command identity, category, and execution state rather than treated as additional preflight failures.

A `verify` preflight rejection carries `executed: false`, `resultCategory: RESOLUTION_FAILURE`, `retryable: true`, and bounded `missingPhase` and `missingScript` fields, and does not create a validation evidence reference.

A completed verification with intentionally omitted phases records the tool outcome as `PASS` while retaining `verdict: incomplete` to distinguish a successful tool call from a complete validation run.

A `project-command` invocation record may also carry the additive optional phase durations `preparationDurationMs`, `authorizationDurationMs`, and `queueDurationMs`, each clamped like every other metadata number and omitted when it was never measured.

`preparationDurationMs` spans tool entry to the authorization mark, which is the start of the authorization call, or tool entry to invocation end when the invocation failed during preparation.

`authorizationDurationMs` spans the authorization call only and includes any confirmation prompt wait, so `promptWaitMs` remains the finer breakdown of that prompt.

`queueDurationMs` is recorded only for a single-flight follower that waited on an in-flight execution and covers the wait until that execution settled, and it is omitted on the leader, cache-hit, and other paths.

All three are omitted for `vr_` evidence-`ref` lookups, which return before preparation, so a lookup record never labels any part of its duration as preparation, authorization, or queue time.

The phase intervals are disjoint, so `preparationDurationMs + authorizationDurationMs + queueDurationMs + executionDurationMs` never exceeds `durationMs`; the unlabeled remainder is the post-authorization preparation gap between the authorization mark and the execution-or-queue mark and is never assigned to a phase.

`executionDurationMs` runs from execution start through record emission, so post-execution result shaping, evidence storage, and `verify` publication fall inside `executionDurationMs` rather than in the unlabeled remainder.

Read-batch records add `requestedPaths`, per-item size entries, and an `aggregate` block with `resultBytes` for the full model-facing result text, which supports result-size attribution per read-batch call.

Edit-preflight failure details carry an additive `evidenceBacked: true` flag when a prior `read_batch` observation backed the diagnostic, so the `edit-stale-context` hit rate is measurable from existing details.

`cacheDecision` is one of `miss`, `hit`, `forced`, `ineligible`, or `invalidated`.

`reason` distinguishes cache reuse, forced execution, invalid requests, resolution and policy failures, execution failures, cancellation, lookup failures, and preparation failures.

Process status remains separate from the result category and verification verdict.
