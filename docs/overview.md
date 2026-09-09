# Overview

## What the extension registers

The extension registers `git_status`, `git_diff`, `git_log`, `git_show`, `environment`, `read_batch`, `project_command`, `verify`, `move`, and `delete`.

The extension does not register another shell tool.

The native pi `read`, `write`, `edit`, `grep`, `find`, and `ls` implementations remain unchanged, but their calls are intercepted by the filesystem access policy before execution.

Native `bash` and `user_bash` calls are not intercepted by this extension.

## Shared execution rules

Git commands use pi's argument-array execution API with fixed safety flags and never use shell interpolation.

Project commands use fixed executable and argument definitions, `shell: false`, ignored stdin, piped output, bounded output, and a fixed 30-second process timeout.

The extension uses the canonical `realpath(ctx.cwd)` as the project directory for environment, filesystem policy, project commands, and verification unless a tool explicitly resolves the Git repository root.

Git and `read_batch` repository-relative paths must stay inside the Git repository and reject absolute paths, drive-letter paths, UNC paths, traversal, backslashes, control characters, symlink escapes, wildcard forms, and Git pathspec magic.

Filesystem paths are canonicalized and checked against workspace and policy containment rules.

Tool output is bounded and reports truncation metadata where applicable.

Policy files, command output, environment values, and persisted records are treated as untrusted input.

## Error and cancellation behavior

Invalid requests fail before execution and use structured error contracts where the tool supports them.

Cancellation is checked before authorization, during policy operations, and around execution.

A policy failure, unsafe path, unavailable executable, malformed project file, or unsupported command fails closed instead of falling back to arbitrary execution.

See [Policy document](policy.md) for shared authorization behavior and [Artifacts and observability](artifacts.md) for persistence boundaries.
