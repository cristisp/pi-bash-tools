# Bash Tools Plan

## Purpose

Build a pi extension that gives agents narrowly scoped, observable, and safe project tools instead of unrestricted shell access.

The extension must not expose an arbitrary shell command interface.

Every tool must define explicit input and output contracts, enforce workspace boundaries, cap output, support cancellation where execution is possible, and report errors without hiding them from the agent.

## Current status

The extension currently registers six tools: environment, git_status, git_diff, git_log, git_show, and project_command.

The environment tool provides explicit-key access with fail-closed authorization, canonical project identity, restrictive policy storage, locking, atomic writes, cancellation, and timeout handling.

The Git tools provide validated, bounded, cancellable, read-only repository inspection with temporary-repository integration coverage.

The project_command tool currently supports exactly two extension-owned semantic commands: workspace_path and node_version.

project_command accepts only a strict commandId and executes fixed definitions with direct spawn, shell disabled, canonical project working directories, a minimal static environment, bounded output, cancellation, timeouts, and process cleanup.

The project_command schema and prompt metadata describe which semantic command ID to use without introducing dynamic tool loading.

Project command authorization uses the user-owned policy at `getAgentDir()/bash-tools.json`, canonical project paths, command fingerprints, policy precedence, and interactive confirmation.

Existing environment-only version-one policy documents remain valid, while project command decisions use the projectCommands namespace in the version-two composite document.

Displayed project paths below the current home directory use ~, while policy identity and storage continue to use canonical absolute paths.

Native macOS validation currently passes the full test suite, TypeScript checks, lint, formatting, Fallow analysis, Fallow audit, and git diff checks.

Linux runtime validation remains deferred, and Windows and FreeBSD remain unsupported by design.

## Existing pi capabilities

Pi already provides the built-in `read`, `write`, `edit`, `grep`, `find`, `ls`, and `bash` tools.

Pi's default coding tool set contains `read`, `bash`, `edit`, and `write`.

Pi's read-only tool set contains `read`, `grep`, `find`, and `ls`.

All seven tools are real pi-provided capabilities, even when they are not active in the default tool set.

This extension must not duplicate those tools or register replacements for them by default.

The built-in `bash` tool remains intentionally outside this extension's safe-tool surface.

The extension should use `ctx.cwd` and existing pi path handling instead of adding a redundant working-directory tool.

## Current extension tool catalog

Each extension tool has a dedicated source folder under `src/tools/`.

| Tool            | Implementation                         | Current safety boundary                                                                   |
| --------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| Environment     | `src/tools/environment/environment-tool.ts` | Return only explicitly requested and authorized environment variables.                    |
| Git status      | `src/tools/git/status/tool.ts`         | Inspect repository status without changing the working tree.                              |
| Git diff        | `src/tools/git/diff/tool.ts`           | Read bounded diffs for approved paths without changing the repository.                    |
| Git log         | `src/tools/git/log/tool.ts`            | Read bounded commit history with validated revision and path inputs.                      |
| Git show        | `src/tools/git/show/tool.ts`           | Read a bounded object or file revision without executing repository content.              |
| Project command | `src/tools/project-command/tool.ts`   | Run only fixed extension-owned semantic commands after user-owned policy authorization.   |

The project_command catalog currently contains exactly workspace_path and node_version.

The project_command input does not accept executable paths, arguments, working directories, shell settings, environment values, scripts, or package-script names.

The extension does not register replacements for Pi's built-in read, write, edit, grep, find, ls, or bash tools.

The existing pi tools cover directory listing, file discovery, text search, file reading, directory creation, and file mutation.

## Requirements

- Load the extension through the root pi package entrypoint.
- Keep production source under `src/`.
- Keep source-specific tests next to their source file.
- Keep broad cross-tool and integration tests under `test/`.
- Keep each extension tool implementation isolated in its dedicated tool folder.
- Keep tool contracts stable and versioned as part of the extension API.
- Resolve relative paths against the project workspace and reject paths that escape approved roots.
- Reject ambiguous, malformed, or unsupported input rather than guessing.
- Apply output limits consistently and report when output was truncated.
- Return structured details suitable for rendering and session persistence.
- Preserve cancellation and timeout information in command results.
- Avoid shell interpolation when invoking an allowlisted command.
- Never silently fall back to unrestricted shell execution.
- Require explicit policy decisions for Git operations that can expose sensitive history or content.
- Add telemetry-free diagnostics sufficient to explain why a request was rejected.

## Implementation tasks

### Foundation

- [x] Review and approve the contracts in `src/tools/`.
- [x] Define output limits, truncation, error, and cancellation behavior for executable tools.
- [x] Define workspace identity behavior using Pi's current `ctx.cwd` and canonical paths.
- [x] Keep project command definitions extension-owned and semantic rather than accepting arbitrary package-script input.
- [x] Define the policy configuration format and default-deny behavior.
- [x] Define structured result and error mappings for the extension tools.
- [x] Register only extension capabilities that are not already provided by Pi.
- [x] Verify that no custom tool name or behavior duplicates `read`, `write`, `edit`, `grep`, `find`, `ls`, or unrestricted `bash`.

### Read-only tools

- [x] Implement allowlisted environment inspection.
- [x] Implement Git status inspection.
- [x] Implement bounded Git diff inspection.
- [x] Implement bounded Git log inspection.
- [x] Implement bounded Git show inspection.

### Controlled execution

- [x] Implement allowlisted project-command execution with fixed argument arrays instead of shell strings.
- [ ] Evaluate fixed semantic project-code commands without accepting package-script input.
- [x] Add timeout, cancellation, process cleanup, and output truncation behavior.
- [ ] Add confirmation or blocking behavior for commands that can mutate state, access secrets, or use the network before adding those command classes.

### Pi integration

- [x] Add TypeBox schemas that match the TypeScript contracts.
- [x] Register tool descriptions and prompt metadata that clearly communicate limits and command selection.
- [x] Use Pi's default tool rendering where custom rendering is not necessary.
- [x] Add session-safe details for structured tool results.
- [x] Add a migration path for policy and contract changes.
- [ ] Verify the package loads and behaves correctly in interactive, print, JSON, and RPC modes.

### Testing and quality

- [x] Add unit tests for workspace policy, allowlists, validation, truncation, and error mapping.
- [x] Add contract tests for every extension tool input and output shape.
- [x] Add mocked execution tests for project commands and Git operations.
- [x] Add integration tests covering tool registration and tool-call dispatch.
- [x] Add rejection tests for path traversal, shell metacharacters, unallowlisted commands, oversized output, invalid revisions, and sensitive operations.
- [x] Add cancellation and timeout tests for every executable tool.
- [x] Add broad cross-tool tests under `test/` for policy composition and command execution behavior.
- [ ] Add Vitest coverage reporting with `@vitest/coverage-v8`.
- [ ] Add a coverage script and enforce at least 75% lines, functions, statements, and branches.
- [x] Keep the available test, type, lint, format, and Fallow checks passing before committing.
- [x] Run the Fallow audit and targeted checks before committing AI-generated changes.
