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

Every optional field also accepts explicit `null`, treated as omitted (strict-decoder compatibility).

Unknown fields, including the retired evidence fields (`ref`, `flowId`, `covers`, and `publish`), are rejected with an `invalid-request` error.

`read_batch` declares an `outputSchema` covering the execution result, the unchanged repeat items, and the aggregate-limit continuation, and returns the same payload as `structuredContent` for successful results.
Failures throw as before and carry no structured content.

### Result

```json
{
  "results": [
    {
      "path": "src/index.ts",
      "range": { "offset": 1, "limit": 200 },
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

Each result has either bounded content metadata, `unchanged: true` with the prior read's `contentHash`, or a bounded per-path error.

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

`source` must identify an existing regular file or directory and must not itself be a symbolic link.
A directory source is relocated together with its tree in one atomic rename, and a destination inside the source directory is rejected.

`destination` must be absent before the operation and is resolved relative to the current workspace when it is not absolute.

Unsafe symbolic-link paths are rejected during destination canonicalization.

The operation authorizes both source and destination with the `move` capability.

`move` declares an `outputSchema` and returns the same payload as `structuredContent` for successful results.
Failures throw as before and carry no structured content.

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

The target must be an existing regular file or directory.

Symbolic links are rejected.
A directory target is deleted together with its contents; entries that are symbolic links are removed as directory entries without being followed, and a tree above 10,000 entries is rejected so oversized trees can be removed in batches.
A directory target is authorized at the directory itself, so an `allowDelete` approval persisted for its files also covers deleting the folder.

The operation uses the separate `delete` capability.

`delete` declares an `outputSchema` and returns the same payload as `structuredContent` for successful results.
Failures throw as before and carry no structured content.

## Native filesystem tools

`read`, `ls`, `find`, and `grep` request `read` access.

`write` requests `write` access.

`edit` requests both `read` and `write` access.

An edit preflight reads at most 256,000 bytes and diagnoses empty `oldText`, no-op replacements, no match, stale context, ambiguous matches, and overlapping edits before the native edit is allowed to run.

Diagnostics include the nearest candidate line numbers, a `fileFingerprint` (sha256 of the preflight-read content), and bounded repair context (`contentLength`, `lineCount`) without file content. A `read_batch` full-file read records the observed content hash (hash-only, bounded, best-effort): when a later edit no longer matches content that changed since that observation, the failure is classified as `edit-stale-context`; without observed evidence it stays `edit-no-match`. A stale-context or equal-hash no-match diagnostic carries the additive `evidenceBacked: true` flag when an observation existed for the path, so the `edit-stale-context` hit rate is measurable; the flag is omitted when no observation existed. Repeating an identical edit after any preflight failure is rejected once per session with `edit-unchanged-retry` until the edit is rebased on a fresh reread. The extension never retries or rebases a mutation automatically.

The interceptor reports blocked calls as `Tool call blocked by access policy` with the tool, access type, path, and reason.
A blocked path-resolution failure additionally carries `resolutionFailure.reason` and `resolutionFailure.action` additive details.
The reason is one of `missing-target`, `unreadable`, `symlink`, `control-character`, `wildcard-path`, `invalid-path-form`, or `unknown`, derived from the failing resolution step.
The action is a short fixed hint for the reason and never includes the requested path, policy contents, or environment values.
The block decision, the `policy-path-resolution-failure` contract, and the message text are unchanged.
Resolution failures never reason about outside-workspace or traversal forms: the request path is normalized before resolution, and containment or traversal outcomes remain policy decisions that are reported as policy denials.

Successful native `read` results are checked for unchanged repeats.
When the same session repeats a read of the same path with the same `offset` and `limit` and the returned content hashes identically to the previous result, the extension answers the repeat with a short unchanged notice naming the earlier read instead of resending the content.
This mirrors the `unchanged: true` response that `read_batch` already provides.
The observation store is bounded (8 sessions, 256 entries per session) and keyed by session id, so concurrent sessions never share observations.
It is cleared on session start, switch, fork, and shutdown, and after every completed compaction.
Nested calls, error results, and results containing images are never replaced; a changed file makes the next read hash differ, so no stale dedupe can fire.
Every failure inside the check degrades to passing the original result through.

Whole-file native `read` results also receive an informational suffix when the file is large: whole-file reads returning at least 32,768 bytes of text, and whole-file reads the native tool truncated, get an appended one-line hint pointing to ranged `read_batch` requests.
The content itself is never blocked, removed, or replaced.
Ranged reads, error and image results, and nested calls never receive the suffix, and the repeat dedupe observes the pre-suffix content, so the hint never breaks repeat detection.

## Default access

The active workspace and its descendants have implicit read and write access.

Tracked files under the active workspace also have implicit move and delete access when Git is available.

An untracked existing source or destination is never implicitly approved for mutation.

A directory target always requires explicit approval; implicit tracked-file access never covers a directory tree, and a move or delete of a folder that contains the active workspace is rejected.

Explicit deny rules override implicit access and explicit allow rules.

A path rule applies to the path itself and its descendants.

Deny rules also consider overlapping paths, so a denied descendant can block a containing recursive listing or search.

Unknown filesystem paths are prompted only in TUI or RPC mode.

Filesystem prompts offer `Deny once`, `Deny globally`, `Deny for this project`, `Allow once`, `Allow globally`, and `Allow for this project`.

Delete prompts are project-scoped and offer `Deny once`, `Deny for this project`, `Allow once`, and `Allow for this project`.

A timeout records a project-level deny for the requested access type and blocks only the current call.

Invalid policy files, unsafe parent paths, special files, symlinks in the policy path, and ambiguous filesystem races fail closed.
