# Tool catalog

## Custom tools

| Tool | Purpose | Detailed reference |
| --- | --- | --- |
| `git_status` | Read bounded porcelain working-tree status. | [Git tools](git.md) |
| `git_diff` | Read a staged or working-tree summary or patch. | [Git tools](git.md) |
| `git_log` | Read bounded commit identifiers, authors, dates, and subjects. | [Git tools](git.md) |
| `git_show` | Read bounded revision output with an optional path filter. | [Git tools](git.md) |
| `environment` | Read explicitly requested environment variables after authorization. | [Environment](environment.md) |
| `read_batch` | Read up to 32 authorized repository-relative files with bounded ranges. | [Filesystem tools and policy](filesystem.md) |
| `move` | Move or rename one authorized regular file. | [Filesystem tools and policy](filesystem.md) |
| `delete` | Delete one authorized regular file. | [Filesystem tools and policy](filesystem.md) |
| `project_command` | Run one command from the fixed Node and Fallow catalog or look up evidence. | [Project commands](project-command.md) |
| `verify` | Run the configured verification phases in fixed order or look up evidence. | [Verification](verify.md) |

## Native pi tools with additional capabilities

The filesystem interceptor applies to native `read`, `write`, `edit`, `grep`, `find`, and `ls` calls.

`read`, `ls`, `find`, and `grep` require `read` access, while `write` requires `write` access.

`edit` requires both `read` and `write` access and receives an edit preflight that can report empty, missing, ambiguous, or overlapping replacements before the native call runs.

The interceptor canonicalizes and authorizes the requested path before allowing the native implementation to execute.

Native `bash` and `user_bash` calls have no filesystem-policy interception from this extension.

## Common result conventions

Structured custom tools return JSON text plus a typed `details` object.

Bounded text commonly includes `truncated`, `totalBytes`, and `totalLines`.

Project commands and verification also expose status, category or verdict, execution state, cache state, repository state, and evidence metadata as described in their dedicated pages.
