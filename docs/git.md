# Git tools

All Git tools operate from the current pi workspace and first resolve its canonical Git repository root.

They are read-only and do not reset, checkout, write, stage, commit, push, fetch, or intentionally execute repository content.

Git invocations disable optional index locks and the configured fsmonitor.

Diff, log, and show also disable external diff and text conversion helpers.

Git failures, invalid revisions, unsafe paths, non-repository workspaces, and cancellation are tool errors.

When observability is active, every Git read invocation is recorded as a bounded `bash-tools.git-invocation` entry described in [Artifacts and observability](artifacts.md).

The record carries identity, timing, outcome classification, result size, and the same repository-state block as other producers; it never contains revisions, paths, or output text, and recording never changes a result or error.

A `git_diff` record also carries the effective `mode`, a `git_diff` or `git_show` record carries the requested `maxBytes` when one was supplied, and a completed record carries the result `truncated` flag when the result exposes it.

## Empty optional fields and deterministic retries

An empty `path` or `revision` field is treated as absent before the request is validated, because an empty string carries no path or revision meaning.

The Git invocation record names each applied coercion as `path:empty-string-omitted` or `revision:empty-string-omitted` in its bounded `coercions` list.

Entries inside a `paths` array are never coerced, because dropping one entry would silently widen the request scope.

A request that supplies both `path` and `paths` is still rejected; an empty `path` is first treated as absent, and a non-empty conflict keeps its existing rejection and wording.

A request-shape failure that an identical retry would reproduce is remembered per session, tool, and effective request shape.

A repeated identical request is rejected without a Git execution with the code `unchanged-invalid-request`, `retryable: false`, and `executed: false`, and its record carries `retryInvalidation: "invalid-request-repeat"`.

Its message is `Identical invalid Git request was already rejected for this session; change the request before retrying; action: Correct the request shape or value and retry.`

Only request-shape validation failures participate: empty or control-character `path` and `revision` text, an empty `paths` array, and the `path`-and-`paths` conflict.

Unsafe paths and unsafe revision expressions, cancellation, spawn failures, command failures, output-limit breaches, and repository-resolution failures never participate, so a transient failure is never blocked from a retry.

A changed request has a different effective shape and proceeds normally.

The tracking state is process-local, bounded to 256 entries with FIFO eviction, and stores only session ids, tool names, and SHA-256 fingerprints of the effective request shape.

When no session identity is available, no retry invalidation is applied and the request executes normally.

## `git_status`

### Input

```json
{
  "path": "optional/workspace-relative/path",
  "refresh": false
}
```

Both fields are optional and unknown fields are rejected.

`refresh` also accepts the compatibility strings `"true"` and `"false"`.

### Result

```json
{
  "repositoryRoot": "/absolute/repository",
  "unchanged": false,
  "entries": [
    {
      "path": "src/file.ts",
      "indexStatus": " ",
      "worktreeStatus": "M",
      "renamedFrom": "optional/original.ts"
    }
  ],
  "head": "40-64 hexadecimal characters",
  "dirtyFilesDigest": "64 hexadecimal characters",
  "output": {
    "truncated": false,
    "totalBytes": 42,
    "totalLines": 1
  }
}
```

`renamedFrom` is present for rename and copy records.

A fresh status also carries repository-state identity: `head` is the resolved HEAD commit id, and `dirtyFilesDigest` is a content-sensitive digest over the dirty paths and their hashed content. Identity fields are omitted when their computation cannot complete (for example an empty repository or an oversized dirty state). Computing identity runs one extra `git rev-parse HEAD` process per fresh status and a bounded `git hash-object` process only when the tree is dirty; the unchanged path runs no extra processes.

An unchanged response contains `repositoryRoot`, `unchanged: true`, `previous` with the prior digest, entry count, identity fields, and output metadata, the zero-sized current `output`, and a message explaining how to request a refresh.

Status output is capped at 50 KiB and 2,000 records.

A repeated request for the same repository and path returns `unchanged: true` with zero output metadata when the status digest is unchanged, unless `refresh` is true.

The status unchanged cache is process-local.

## `git_diff`

### Input

```json
{
  "mode": "summary",
  "staged": false,
  "maxBytes": 16384,
  "paths": ["src/file.ts"]
}
```

`mode` is `summary` by default and may be `patch`.

`staged` defaults to false and also accepts `"true"` and `"false"`.

`maxBytes` must be an integer from 1 through 1 MiB and defaults to 16 KiB.

Omit path filters to inspect the whole repository.

The legacy single `path` field remains supported, but new calls should use a non-empty `paths` array.

`path` and `paths` cannot be supplied together, and duplicate or empty path arrays are rejected.

### Summary result

```json
{
  "mode": "summary",
  "status": [
    {
      "path": "src/file.ts",
      "indexStatus": " ",
      "worktreeStatus": "M"
    }
  ],
  "stat": "src/file.ts | 4 +++-",
  "hunks": [
    {
      "path": "src/file.ts",
      "header": "@@ -1 +1 @@"
    }
  ],
  "head": "40-64 hexadecimal characters",
  "dirtyFilesDigest": "64 hexadecimal characters",
  "output": {
    "truncated": false,
    "totalBytes": 100,
    "totalLines": 4
  },
  "message": "Diff summary; hunk bodies are omitted."
}
```

The summary is derived from Git status, diff stat, raw diff, and hunk data and is cached by a content-sensitive process-local cache.

A concurrent summary request can share one discovery execution.

A summary also carries request-scoped repository-state identity: `head` is the resolved HEAD commit id, and `dirtyFilesDigest` is a digest over the status output, raw diff, and untracked file content for the requested path filters. Unlike the `git_status` digest, which is repository-global by default and scoped to the requested path when a path filter is supplied, the `git_diff` digest is always scoped to the exact request.

### Unchanged summary result

A repeated identical summary request (same repository root, working directory, staged mode, path filters, and `maxBytes`) whose request-scoped digest matches the previously served summary returns a compact comparison instead of the full summary:

```json
{
  "mode": "summary",
  "repositoryRoot": "/absolute/repository",
  "unchanged": true,
  "previous": {
    "digest": "64 hexadecimal characters",
    "entryCount": 1,
    "head": "40-64 hexadecimal characters",
    "dirtyFilesDigest": "64 hexadecimal characters",
    "output": {
      "truncated": false,
      "totalBytes": 100,
      "totalLines": 4
    }
  },
  "output": {
    "truncated": false,
    "totalBytes": 0,
    "totalLines": 0
  },
  "message": "Git diff summary is unchanged since the previous request. Use mode: \"patch\" with explicit paths for full content."
}
```

The comparison is process-local, mirrors the `git_status` unchanged behavior, and never changes patch mode responses.

### Patch result

```json
{
  "mode": "patch",
  "patch": "diff --git ...",
  "output": {
    "truncated": false,
    "totalBytes": 120,
    "totalLines": 5
  }
}
```

Patch and show text are truncated to the requested UTF-8 byte limit without splitting a code point.

## Cross-process evidence references

Decision: `git_status` and `git_diff` results carry repository-state identity (`head`, `dirtyFilesDigest`) so callers can compare evidence across calls within a process, but no opaque stable evidence reference is issued for Git results and no cross-process lookup resolves one.

Rationale: the identity fields already answer the local "is this the same tree I saw before" question without adding a reference format, a resolver, or producer-authorization semantics. Cross-process stable references interact with the flow evidence-referencing decision tracked in [PLAN](../PLAN.md) and should not be invented piecemeal for one tool family.

Revisit trigger: revisit this determination when the flow-level evidence-referencing decision lands, or when a concrete consumer needs to hand a Git result reference to another process; until then, callers compare the returned identity fields directly.

## `git_log`

### Input

```json
{
  "maxEntries": 20,
  "revision": "main..HEAD",
  "path": "src/file.ts"
}
```

`maxEntries` is required and must be an integer from 1 through 2,000.

`revision` and `path` are optional.

### Result

```json
{
  "entries": [
    {
      "id": "40-64 hexadecimal characters",
      "author": "Author",
      "date": "ISO-8601 date",
      "subject": "Commit subject"
    }
  ],
  "output": {
    "truncated": false,
    "totalBytes": 200,
    "totalLines": 2
  }
}
```

Structured Git output is capped at 50 KiB and 2,000 records.

## `git_show`

### Input

```json
{
  "revision": "HEAD",
  "path": "src/file.ts",
  "maxBytes": 65536
}
```

`revision` and `maxBytes` are required.

`maxBytes` must be an integer from 1 through 1 MiB.

`revision` must be a non-empty safe Git revision expression.

An empty `revision` is treated as absent and then rejected because the field is required, with the existing `revision must not be empty` wording.

`git_show` implements `git show <revision> -- <path>` filtering and does not implement `REV:path` blob extraction.

### Result

```json
{
  "content": "bounded UTF-8 text",
  "output": {
    "truncated": false,
    "totalBytes": 18,
    "totalLines": 1
  }
}
```
