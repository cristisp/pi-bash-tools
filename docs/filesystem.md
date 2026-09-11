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

Both paths must identify regular files or a safe missing destination.

The destination must not already exist and may not contain a symbolic link.

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

Diagnostics include the nearest candidate line numbers, a `fileFingerprint` (sha256 of the preflight-read content), and bounded repair context (`contentLength`, `lineCount`) without file content. A `read_batch` full-file read records the observed content hash (hash-only, bounded, best-effort): when a later edit no longer matches content that changed since that observation, the failure is classified as `edit-stale-context`; without observed evidence it stays `edit-no-match`. Repeating an identical edit after any preflight failure is rejected once per session with `edit-unchanged-retry` until the edit is rebased on a fresh reread. The extension never retries or rebases a mutation automatically.

The interceptor reports blocked calls as `Tool call blocked by access policy` with the tool, access type, path, and reason.

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
