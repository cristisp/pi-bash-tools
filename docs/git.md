# Git tools

All Git tools operate from the current pi workspace and first resolve its canonical Git repository root.

They are read-only and do not reset, checkout, write, stage, commit, push, fetch, or intentionally execute repository content.

Git invocations disable optional index locks and the configured fsmonitor.

Diff, log, and show also disable external diff and text conversion helpers.

Git failures, invalid revisions, unsafe paths, non-repository workspaces, and cancellation are tool errors.

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
  "output": {
    "truncated": false,
    "totalBytes": 42,
    "totalLines": 1
  }
}
```

`renamedFrom` is present for rename and copy records.

An unchanged response contains `repositoryRoot`, `unchanged: true`, `previous` with the prior digest and output metadata, the zero-sized current `output`, and a message explaining how to request a refresh.

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
