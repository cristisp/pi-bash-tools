# Filesystem tools and policy

The filesystem layer has two parts: the `read_batch`, `move`, and `delete` custom tools, and an interceptor for native pi filesystem tools.

All filesystem paths are canonicalized and must remain within the active workspace or an explicitly authorized location.

The filesystem policy is stored in the shared user-owned policy document described in [Policy document](policy.md).

## `read_batch`

### Input

```json
{
  "paths": [
    {
      "path": "src/index.ts",
      "range": {
        "offset": 1,
        "limit": 200
      }
    }
  ]
}
```

`paths` contains 1 through 32 entries.

Each `path` is a non-empty repository-relative path of at most 4,096 characters.

`range.offset` is a 1-indexed line number from 1 through 1,000,000.

`range.limit` is a line count from 1 through 2,000.

A request may instead resolve previously published evidence with `{ "ref": "rr_...", "flowId": "optional-flow", "covers": ["optional"] }`.

Every optional field also accepts explicit `null`, treated as omitted (strict-decoder compatibility).

The `ref` form rejects `paths`, `publish`, `range`, execution options, and any other unknown field with an `invalid-request` error.

A published-evidence lookup returns `{ "results": [], "lookup": { ... } }` and never executes a file read or a command.

### Publication

An execution request may opt into flow publication with `"publish": { "flowId": "flow-1" }` alongside `paths`.

Publication succeeds only when every requested path was freshly read in that request, the caller's effective orchestration flow equals `publish.flowId`, and the flow cache write succeeds.

The result carries the additive `publish` block with `scope`, `flowId`, `published`, and, on success, the aggregate `ref`.

A failed or unauthorized publication leaves the read results unchanged and reports `published: false` with a bounded `error`, and nothing is stored. A publication that meets the content caps but exceeds the 384 KiB serialized record bound is rejected with the distinct bounded `error` `Read evidence exceeds the published record size bound.`, so callers can tell a size rejection apart from an unauthorized publication.

The read-batch invocation record mirrors the requested publication as an additive `publication` block (`scope`, optional `flowId`, `published`, optional bounded `error`) and records orchestrated `role` and `delegationId` when the orchestration context provides them. A publish-requested call that fails before its result details are built is recorded without a `publication` block because no result payload exists to describe.

Combining `publish` with `ref` is rejected up front.

### Lookup result

```json
{
  "results": [],
  "lookup": {
    "ref": "rr_example",
    "executed": false,
    "repositoryStateStatus": "matches",
    "entries": [
      {
        "path": "src/index.ts",
        "contentHash": "sha256 hex digest of the recorded file bytes",
        "status": "unchanged",
        "content": "bounded stored file text",
        "output": { "truncated": false, "totalBytes": 100, "totalLines": 4 }
      }
    ]
  }
}
```

Every recorded path is reauthorized for the current process and re-read when resolving a published reference.

Stored text is served only when it equals the text re-derived from the current bytes, and the returned `output` metadata is re-derived the same way, so a corrupted or tampered record can cause a denial but never wrong content or metadata.

`status` is `unchanged`, `changed`, `unreadable`, or `unauthorized`, and `content` with `output` appears only for `unchanged`.

`repositoryStateStatus` compares the recorded workspace block with the current one and is `matches`, `mismatch`, or `unreadable`.

The recorded workspace block is an observation stored with the record and is not re-derivable, so it remains advisory metadata; the binding guarantee is per-path reauthorization plus content re-derivation.

An unauthorized, missing, corrupt, or trimmed reference returns one generic not-found error that never reveals evidence from another flow. The error names only the caller's own flow, or no flow, in every case.

Published records are bounded to 32 entries, 64 KiB stored content per entry, 256 KiB stored content per record, and 384 KiB per serialized record. Each flow retains at most 128 records in memory, while durable records persist on disk until the shared flow cache evicts them under its byte and age bounds (2 MiB per record, seven days, and 50 MiB per shared directory).

An `rr_` reference returned by a read that did not request publication stays process-local and resolves to the same generic not-found error.

### Result

```json
{
  "results": [
    {
      "path": "src/index.ts",
      "range": { "offset": 1, "limit": 200 },
      "ref": "rr_example",
      "contentHash": "sha256 hex digest of the file bytes",
      "content": "bounded file text",
      "output": {
        "truncated": false,
        "totalBytes": 100,
        "totalLines": 4
      }
    },
    {
      "path": "missing.ts",
      "error": {
        "code": "...",
        "message": "..."
      }
    }
  ],
  "continuation": {
    "nextIndex": 4,
    "totalPaths": 6
  }
}
```

Each result has either bounded content metadata, `unchanged: true` with the prior `rr_` reference, or a bounded per-path error.

Successful results expose `contentHash`, the lowercase SHA-256 digest of the full file bytes (also present on `unchanged` results), plus size and line metadata in `output.totalBytes` and `output.totalLines`.

Each file result is capped at 64 KiB of returned text and 8 MiB of inspected regular-file size.

The aggregate returned content across all successful results in one request is capped at 256 KiB (4× the per-file cap). Once the cap is reached, the first affected path and every later path return a bounded `aggregate-limit` error (`category: "INVALID_REQUEST"`, `retryable: false`, `executed: false`) in the original request order without being authorized or read. When that happens, `results.continuation` reports `nextIndex` (the index of the first skipped path in the original request) and `totalPaths` so the caller can re-issue the remaining paths in a follow-up request. Re-issued paths count against a fresh aggregate budget.

The same path string may not appear twice with overlapping ranges (including identical ranges and a full read combined with any range) in one request; such requests are rejected up front with an `invalid-request` error. Disjoint ranges of one path are allowed. Overlap detection compares raw path strings, so distinct spellings that canonicalize to the same file are not detected; the per-file and aggregate caps still bound the returned content in that case.

The repeated-read cache is process-local, scoped by effective flow, and capped at 512 entries.

## `move`

### Input and result

```json
{
  "source": "src/old.ts",
  "destination": "src/new.ts"
}
```

```json
{
  "operation": "move",
  "source": "src/old.ts",
  "destination": "src/new.ts"
}
```

`source` must identify an existing regular file and must not itself be a symbolic link or directory.

`destination` must be absent before the operation and is resolved relative to the current workspace when it is not absolute.

Unsafe symbolic-link paths are rejected during destination canonicalization.

The operation authorizes both source and destination with the `move` capability.

## `delete`

### Input and result

```json
{
  "path": "generated/output.json"
}
```

```json
{
  "operation": "delete",
  "path": "generated/output.json"
}
```

The target must be an existing regular file.

Directories and symbolic links are rejected, and deletion is never recursive.

The operation uses the separate `delete` capability.

## Native filesystem tools

`read`, `ls`, `find`, and `grep` request `read` access.

`write` requests `write` access.

`edit` requests both `read` and `write` access.

An edit preflight reads at most 256 KiB and diagnoses empty `oldText`, no-op replacements, no match, stale context, ambiguous matches, and overlapping edits before the native edit is allowed to run.

Diagnostics include the nearest candidate line numbers, a `fileFingerprint` (sha256 of the preflight-read content), and bounded repair context (`contentLength`, `lineCount`) without file content. A `read_batch` full-file read records the observed content hash (hash-only, bounded, best-effort): when a later edit no longer matches content that changed since that observation, the failure is classified as `edit-stale-context`; without observed evidence it stays `edit-no-match`. A stale-context or equal-hash no-match diagnostic carries the additive `evidenceBacked: true` flag when an observation existed for the path, so the `edit-stale-context` hit rate is measurable; the flag is omitted when no observation existed. Repeating an identical edit after any preflight failure is rejected once per session with `edit-unchanged-retry` until the edit is rebased on a fresh reread. The extension never retries or rebases a mutation automatically.

The interceptor reports blocked calls as `Tool call blocked by access policy` with the tool, access type, path, and reason.
A blocked path-resolution failure additionally carries `resolutionFailure.reason` and `resolutionFailure.action` additive details.
The reason is one of `missing-target`, `unreadable`, `symlink`, `control-character`, `wildcard-path`, `invalid-path-form`, or `unknown`, derived from the failing resolution step.
The action is a short fixed hint for the reason and never includes the requested path, policy contents, or environment values.
The block decision, the `policy-path-resolution-failure` contract, and the message text are unchanged.
Resolution failures never reason about outside-workspace or traversal forms: the request path is normalized before resolution, and containment or traversal outcomes remain policy decisions that are reported as policy denials.

## Default access

The active workspace and its descendants have implicit read and write access.

Tracked files under the active workspace also have implicit move and delete access when Git is available.

An untracked existing source or destination is never implicitly approved for mutation.

Explicit deny rules override implicit access and explicit allow rules.

A path rule applies to the path itself and its descendants.

Deny rules also consider overlapping paths, so a denied descendant can block a containing recursive listing or search.

Unknown filesystem paths are prompted only in TUI or RPC mode.

Filesystem prompts offer `Deny once`, `Deny globally`, `Deny for this project`, `Allow once`, `Allow globally`, and `Allow for this project`.

Delete prompts are project-scoped and offer `Deny once`, `Deny for this project`, `Allow once`, and `Allow for this project`.

A timeout records a project-level deny for the requested access type and blocks only the current call.

Invalid policy files, unsafe parent paths, special files, symlinks in the policy path, and ambiguous filesystem races fail closed.
