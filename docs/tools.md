# Tool catalog

## Custom tools

| Tool              | Purpose                                                                                             | Detailed reference                           |
| ----------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `git_status`      | Read bounded porcelain working-tree status.                                                         | [Git tools](git.md)                          |
| `git_diff`        | Read a staged or working-tree summary or patch.                                                     | [Git tools](git.md)                          |
| `git_log`         | Read bounded commit identifiers, authors, dates, and subjects.                                      | [Git tools](git.md)                          |
| `git_show`        | Read bounded revision output with an optional path filter.                                          | [Git tools](git.md)                          |
| `environment`     | Read explicitly requested environment variables after authorization.                                | [Environment](environment.md)                |
| `read_batch`      | Read up to 32 authorized repository-relative files with bounded ranges and a 256 KiB aggregate cap. | [Filesystem tools and policy](filesystem.md) |
| `move`            | Move or rename one authorized regular file.                                                         | [Filesystem tools and policy](filesystem.md) |
| `delete`          | Delete one authorized regular file.                                                                 | [Filesystem tools and policy](filesystem.md) |
| `project_command` | Run one command from the fixed Node and Fallow catalog or look up evidence.                         | [Project commands](project-command.md)       |
| `verify`          | Run the configured verification phases in fixed order or look up evidence.                          | [Verification](verify.md)                    |

## Native pi tools with additional capabilities

The filesystem interceptor applies to native `read`, `write`, `edit`, `grep`, `find`, and `ls` calls.

`read`, `ls`, `find`, and `grep` require `read` access, while `write` requires `write` access.

`edit` requires both `read` and `write` access and receives an edit preflight that can report empty, no-op, missing, stale-context, ambiguous, overlapping, and unchanged-retry replacements before the native call runs.

Edit preflight failures carry structured details: the diagnostic code, nearest candidate line numbers, a `fileFingerprint` (sha256 of the preflight-read content), and bounded repair context (`contentLength`, `lineCount`) — never file content itself. When a prior `read_batch` read observed the file, a no-match against changed content is classified as `edit-stale-context` with a reread-and-rebase hint; without observed evidence it stays a plain `edit-no-match`. Repeating an identical edit after a preflight failure is rejected with `edit-unchanged-retry` (bounded per session); rebasing the edit on a fresh read clears the block. The tool never retries or rebases a mutation automatically — rereading and rebasing is the single caller-controlled recovery.

The interceptor canonicalizes and authorizes the requested path before allowing the native implementation to execute.
A blocked path-resolution failure additionally carries `resolutionFailure.reason` and `resolutionFailure.action` additive details.
The bounded reasons are `missing-target`, `unreadable`, `symlink`, `control-character`, `wildcard-path`, `invalid-path-form`, and `unknown`, and each action is a short fixed hint.
The block decision, the `policy-path-resolution-failure` contract, and the message text are unchanged, and containment or traversal outcomes remain policy decisions.

Prefer `read_batch` over repeated or multi-file native `read` calls: it returns per-path results, hashes, and repository-state identity in one bounded call, and it is the only file-read path that can report compact `unchanged` metadata for a repeated identical read.

Native `bash` and `user_bash` calls have no filesystem-policy interception from this extension.

## Common result conventions

Structured custom tools return JSON text plus a typed `details` object.

Bounded text commonly includes `truncated`, `totalBytes`, and `totalLines`.

Tools that declare an `outputSchema` also return `structuredContent`, the same machine-readable payload they serialize as JSON text.
`structuredContent` is never sent to the model; codemode scripts and other programmatic consumers receive it instead of the text content.
The host does not validate `structuredContent` against the declared schema, so package tests enforce conformance for every result mode.

Project commands and verification also expose status, category or verdict, execution state, cache state, repository state, and evidence metadata as described in their dedicated pages.

`project_command` is the one exception to the full-details mirror: its `structuredContent` is the compact, sanitized projection that is also the model-facing JSON text, not the full `details`, because the full details add unbounded streams and internal metadata that must not widen the programmatic payload.
