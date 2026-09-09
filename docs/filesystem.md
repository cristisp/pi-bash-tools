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
  ]
}
```

Each result has either bounded content metadata, `unchanged: true` with the prior `rr_` reference, or a bounded per-path error.

Each file result is capped at 64 KiB of returned text and 8 MiB of inspected regular-file size.

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

An edit preflight reads at most 256 KiB and diagnoses empty `oldText`, no match, ambiguous matches, and overlapping edits before the native edit is allowed to run.

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
