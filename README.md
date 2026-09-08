# Bash Tools

A pi package that provides narrowly scoped Git, project, environment, and filesystem access-policy tools instead of exposing another shell interface.

Pi's built-in `read`, `write`, `edit`, `grep`, `find`, `ls`, and `bash` tool implementations remain unchanged.
The `read`, `write`, `edit`, `grep`, `find`, and `ls` calls are intercepted by the filesystem access policy before execution.
The interceptor does not intercept `bash` or `user_bash`.

## Tool catalog

The extension registers exactly these custom tools:

- `git_status` reads porcelain Git status entries and the canonical repository root.
- `git_diff` reads a working-tree or staged diff for the whole repository, a legacy single `path`, or one or more new `paths`.
- `git_log` reads bounded commit IDs, authors, dates, and subjects.
- `git_show` reads bounded output from a revision, optionally filtered by a path.
- `environment` reads only explicitly requested environment variables after policy authorization.
- `read_batch` reads up to 32 authorized repository-relative files with optional bounded line ranges and per-path errors.
- `project_command` runs the fixed `workspace_path` and `node_version` observations, discovers Node project state with `node_project_info`, lists top-level dependencies with `node_deps_list`, runs exact package scripts from the supported Node command families, and runs six fixed Fallow analyses after policy authorization.
- `verify` runs the configured format, lint, typecheck, and test phases in a fixed order with bounded output and evidence.
- `move` moves or renames one authorized regular file.
- `delete` deletes one authorized regular file.

## Environment policy

The environment tool reads its policy only from the user-owned file `~/.pi/agent/bash-tools.json`, or from the path returned by pi's `getAgentDir()` followed by `bash-tools.json`.
It never reads a repository-local authorization file, `.env` file, or any other environment file.
The file is optional, and a missing file starts with an empty policy.

The complete version 1 schema is:

`version` is required and must be `1`.
`confirmationTimeoutMs`, `global`, `global.allow`, `global.deny`, and `projects` are optional.
Each project entry may contain optional `allow` and `deny` arrays.

```json
{
  "version": 1,
  "confirmationTimeoutMs": 120000,
  "global": {
    "allow": ["PUBLIC_API_URL"],
    "deny": ["DATABASE_PASSWORD"]
  },
  "projects": {
    "/real/path/to/project": {
      "allow": ["PROJECT_TOKEN"],
      "deny": ["PRIVATE_KEY"]
    }
  }
}
```

`confirmationTimeoutMs` is optional, applies globally, and defaults to 120000 milliseconds.
Projects cannot override the confirmation timeout.
Project keys are literal normalized absolute path strings.
At runtime, the environment tool compares them with the exact canonical path returned by `realpath(ctx.cwd)`; policy loading does not resolve or normalize project keys.
Environment names must be valid unique names matching `^[A-Za-z_][A-Za-z0-9_]*$`.
Wildcard names, duplicate names, same-scope allow and deny conflicts, unknown properties, invalid JSON, and invalid types are rejected fail closed.

Authorization precedence is global deny, project deny, global allow, project allow, and then unknown.
A global deny is hard and cannot be overridden by any project rule.
An unknown key is prompted for only in TUI or RPC mode when pi reports `hasUI`.
The prompt options are exactly `Deny once`, `Deny globally`, `Deny for this project`, `Allow once`, `Allow globally`, and `Allow for this project`.
`Allow once` and `Deny once` apply only to the current request and never modify policy.
A manual cancellation before the policy commit rejects the current request without changing policy.
A cancellation after the commit rejects without returning environment values, but the completed policy commit is retained.
A confirmation timeout records a project-level deny and returns no environment values.
Print, JSON, and other no-UI modes reject unknown keys without modifying policy.
When an orchestrated subagent reaches a manual policy approval prompt, the extension emits a warning notification through Pi before opening the prompt.
In TUI and RPC modes it also emits a terminal-native notification through OSC 777, Kitty OSC 99, or a Windows toast when the terminal supports it.
Notification failures are ignored and never change the authorization result.

## Filesystem access policy

The interceptor guards the built-in `read`, `write`, `edit`, `ls`, `find`, and `grep` tool calls before they execute.
It does not intercept `bash` or `user_bash`.

The extension also registers `read_batch`, `move`, and `delete` tools.
`read_batch` accepts `{ paths: [{ path, range?: { offset?, limit? } }] }`, reads at most 32 paths, caps each returned file at 64 KiB of text and 2,000 requested lines, and reports a bounded result or error for every path.
Successful entries report repository-relative paths and a stable `rr_` reference.
A repeated path and range in the same process-local scope returns `unchanged: true` with the prior reference when the file content hash is unchanged.
The batch cache is process-local and separates effective flow scopes without using orchestration environment variables as authorization.
`move` authorizes both the source and destination with the move capability and rejects existing destinations.
`delete` uses a separate delete capability and rejects directories, symlinks, and recursive deletion.

Filesystem rules are stored in the same user-owned `~/.pi/agent/bash-tools.json` policy file.
Filesystem decisions are stored in document version 4 while preserving the environment and project command namespaces.
The filesystem namespace has version `2`, with separate read, write, move, and delete allow and deny arrays of canonical absolute paths.

```json
{
  "version": 4,
  "environment": {
    "version": 1,
    "confirmationTimeoutMs": 120000,
    "global": {},
    "projects": {}
  },
  "projectCommands": {
    "version": 1,
    "global": {},
    "projects": {}
  },
  "filesystem": {
    "version": 2,
    "global": {
      "allowRead": ["/Users/example/shared"],
      "allowWrite": ["/Users/example/shared/generated"],
      "denyRead": ["/Users/example/shared/private"],
      "denyWrite": ["/Users/example/shared/private"],
      "allowMove": ["/Users/example/shared/generated"],
      "denyMove": ["/Users/example/shared/private"],
      "allowDelete": ["/Users/example/shared/generated"],
      "denyDelete": ["/Users/example/shared/private"]
    },
    "projects": {}
  }
}
```

`allowRead` controls `read`, `ls`, `find`, and `grep`.
`allowWrite` controls `write` and `edit`.
`allowMove` controls the `move` tool for both its source and destination paths.
`allowDelete` controls the `delete` tool.
Delete prompts authorize the containing folder, so an approved `allowDelete` folder applies to files in that folder and all of its descendants.
A project and all of its descendants have implicit read and write access for the active workspace.
Tracked files under the active workspace also have implicit move and delete access when Git is available.
For `move`, the tracked source grants the move to a new destination under the active workspace; untracked existing files are never implicitly approved.
Untracked files and paths outside the active workspace remain unknown and require an explicit approval.
If Git cannot identify the repository or tracked path, the mutation remains unknown and requires an explicit approval.
Explicit deny rules take precedence over both implicit access and explicit allow rules.
A path rule applies to the path itself and its descendants.
This recursive behavior applies to folder paths in every filesystem capability, including `allowDelete`.
Deny rules also consider overlapping paths, so a denied descendant can block a containing recursive listing or search.
Unknown paths are prompted for only in TUI or RPC mode.
Filesystem prompts offer `Deny once`, `Deny globally`, `Deny for this project`, `Allow once`, `Allow globally`, and `Allow for this project`.
Delete prompts are project-scoped and instead offer `Deny once`, `Deny for this project`, `Allow once`, and `Allow for this project`.
`Allow once` and `Deny once` apply only to the current filesystem request and never modify policy.
The existing `confirmationTimeoutMs` setting applies to filesystem prompts and defaults to 120000 milliseconds.
A timeout automatically records a project-level deny for the requested access type and blocks only the current tool call.
Blocked calls report `Tool call blocked by access policy` with the tool, access type, path, and reason.

Invalid or unreadable policy files fail closed without exposing raw policy contents.
The policy file and every parent directory must be regular, non-symlink filesystem objects.
Unsupported special files, unsafe parent paths, and ambiguous filesystem races are rejected without reading or writing policy data.
Policy filesystem access is supported on macOS and Linux; unsupported runtime platforms fail closed.
Policy decisions use an adjacent exclusive lock for up to 5 seconds with 25 millisecond retries.
Existing locks are never reclaimed automatically.
If a process crashes while holding the lock, remove `bash-tools.json.lock` manually only after confirming that no pi process owns it.

## Project command policy and execution

The project command tool accepts a strict discriminated input union.
The catalog contains exactly `workspace_path`, `node_version`, `node_project_info`, `node_deps_list`, `node_test`, `node_build`, `node_lint`, `node_typecheck`, `node_format`, `fallow_dead_code`, `fallow_dupes`, `fallow_health`, `fallow_audit`, `fallow_list_entry_points`, and `fallow_list_boundaries`.
`node_test` accepts optional workspace-relative `paths` and an optional validated variant, and `fallow_audit` requires the validated `base` revision parameter.
`node_lint` accepts an optional validated variant, and `node_format` accepts an optional validated variant.
A variant selects one exact `base:<suffix>` package script key, including project-defined scripts such as `lint:fix`, `test:coverage`, `test:e2e`, and `format:check`; the selected script must exist in `package.json`.
Variants use bounded package-script-safe segments containing letters, digits, dots, underscores, or hyphens separated by colons, and invalid or missing variants are rejected before execution.
The selected script key participates in the command authorization fingerprint, the result cache key, the displayed command, and the per-script relevant-input hash, and variant requests remain non-cacheable like all other script commands.
Test paths are forwarded as fixed argument forms after the package-manager separator; package-script variants select the complete project-defined command, so the extension does not detect or invoke a particular test runner.

The extension owns the complete command catalog and never reads repository configuration to define commands.
`node_project_info` reads package.json and supported lockfiles in process and reports the active Node version, package manager state, sorted script names, and applicable Node command IDs.

`node_deps_list` invokes only npm `ls --depth=0`, pnpm `list --depth=0`, bun `pm ls`, or Yarn Classic 1.x `list --depth=0` through a fixed absolute executable.
A missing package.json is reported as a non-Node project.

`workspace_path` directly spawns `/bin/pwd` without arguments.
`node_version` directly spawns the current Node executable with `--version`.
The Node script commands invoke only the exact corresponding package.json scripts, or one validated family variant form described above, through a detected npm, pnpm, bun, or explicitly selected Yarn executable.
Package scripts are project-controlled code and are never globally safe; any selected script, including a lint, test, or format variant, may have side effects.

Yarn lockfile-only projects and explicit Yarn versions other than Classic 1.x are rejected for dependency listing.
The six Fallow commands invoke only the project-local `node_modules/.bin/fallow` target through the active Node executable with fixed JSON and quiet flags.
`fallow_audit` requires a safe revision value for its fixed `--base` option.
Missing scripts, malformed manifests, ambiguous managers, unavailable fixed executables, and missing or escaping Fallow binaries fail closed.

Observation commands use the canonical `realpath(ctx.cwd)` as their working directory and fixed head-biased output.
Script commands use that same canonical directory, fixed tail-biased output, `shell: false`, ignored stdin, piped stdout and stderr, and a bounded `node-v1` environment containing only the static environment plus `HOME`, `CI=true`, and the active Node binary directory at the front of PATH.

Command execution uses a fixed 30-second process timeout that is separate from the 120-second confirmation timeout.

Command policy is stored only at `getAgentDir()/bash-tools.json`.

A command policy identity combines its semantic ID with a SHA-256 definition fingerprint and is scoped by the canonical project path.

Global deny, project deny, globally safe global allow, project allow, and unknown are evaluated in that order.

Unknown commands are denied without a UI or outside TUI and RPC modes.

Interactive project-command prompts use exactly `Deny once`, `Deny for this project`, `Allow once`, and `Allow for this project`.
Project-command permissions are project-scoped, so global choices are not offered.
`Allow once` and `Deny once` apply only to the current command and never modify policy.

Command decisions migrate a version 1 environment document to a version 2 document containing the unchanged nested environment version 1 policy and a version 1 project command policy namespace.

The command executor never calls `pi.exec`, performs PATH lookup, invokes npx or Corepack downloads, runs a shell, or returns raw spawn errors.
Dependency installation, package script families outside lint, test, and format, aliases, watch modes, inline scripts, and arbitrary command execution are intentionally not in this catalog.

The corresponding Bash behavior is equivalent to the following examples, but the extension does not execute these command strings:

```bash
git --no-optional-locks -c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all -- <path>
git --no-optional-locks -c core.fsmonitor=false diff --no-ext-diff --no-textconv --binary [--cached] -- <path>...
git --no-optional-locks -c core.fsmonitor=false log --no-ext-diff --no-textconv --no-decorate --date=iso-strict --format='format:%H%x00%an%x00%aI%x00%s%x00' --max-count=<maxEntries> [<revision>] -- <path>
git --no-optional-locks -c core.fsmonitor=false show --no-ext-diff --no-textconv <revision> -- <path>
```

## Validation evidence and freshness

`verify` runs the format, lint, typecheck, and test phases in fixed order and returns an aggregate `verdict` of `passed`, `failed`, or `incomplete`.
An omitted phase is visible in `perStep` and makes the aggregate verdict `incomplete`, rather than successful.

A successful execution returns a bounded `vr_` evidence reference when repository state is readable and stable.
The same unchanged request can return a compact `reused: true` result with the same reference.
Set `fresh: true` to execute again without changing the content-addressed cache key.
A fresh execution reports `reused: false` and can retain the same reference when its evidence is identical.
`fresh` cannot be combined with `ref`.

`project_command` execution evidence uses distinct bounded `pc_` references.
Project-command evidence is non-replayable: looking up `{ "ref": "pc_example" }` returns stored evidence without executing a command and never acts as a result-cache hit.
Project-command script and Fallow commands retain `reusePolicy: "never"`.
Lookup accepts only `ref`, optional `flowId`, and opaque `covers` fields.
Unknown fields and execution options such as `publish` or `fresh` are rejected for lookup requests.
The same lookup-only rules apply to `verify` references.

Root-session evidence is process-local by default and is not durable across processes.
A lookup with `flowId` succeeds only when the caller has the same effective flow scope.
An executing request may explicitly request `publish: { "flowId": "flow-1" }` after authorization and compatible repository-state checks.
Publication is reported only after the destination write is confirmed.
Publishing to the caller's own effective flow is an accepted no-op that preserves the flow record.

Evidence includes `covers`, producer provenance, recorded repository state, and current repository state when it can be read.
`repositoryStateStatus` is `matches`, `mismatch`, or `unreadable`.
The recorded state includes `dirtyFilesDigest`, which fingerprints the Git-reported paths together with their content, mode, size, and status while excluding ignored paths.
`stateDrift: true` indicates that the repository moved between the start and completion observations of an execution.
`mutating` reports the conservative command-variant classification.
`node_format` and `node_lint:fix` are mutating, while `node_format:check`, `node_lint`, and `node_lint:check` are non-mutating.
Unknown variants in a family containing a writing form are treated as mutating because package-script bodies remain opaque.

Identical non-mutating evidence requests that overlap in one process use single-flight coordination.
A shared request reports `sharedExecution: true` and is distinct from an ordinary cache hit.
`concurrentExecutions` reports the observed overlapping execution count for the repository identity.
The consumer-owned repository write lock remains authoritative for coordination between writers and readers.

The project-command invocation recorder stores bounded `flowId`, `delegationId`, `role`, `ref`, verdict, mutability, publication, lookup outcome, coercion, concurrency, drift, and aggregate-verify metadata.
One aggregate invocation record is emitted per `verify` call rather than one record per phase.
Process status remains separate from the aggregate verify verdict.

Set `BASH_TOOLS_INVOCATIONS_PATH` to an absolute file path to enable the producer-owned JSONL invocation stream.
The child process inherits this environment variable from its parent.
The `BASH_TOOLS_INVOCATION_STREAM` and `BASH_TOOLS_TELEMETRY_PATH` names are accepted as lower-priority path aliases, but `BASH_TOOLS_INVOCATIONS_PATH` is canonical.
The selected path is read when each record is emitted.
Its parent directories are created as needed, and each bounded invocation record is appended as one newline-delimited JSON object using append mode.
The stream contains the same records sent to Pi custom entries, including execution decisions, refs, repository-state metadata, orchestration join fields, successful lookups, and failed lookups.
A failed or denied `verify` call still emits a record with `executed: false` when no phase ran, rather than being omitted from the stream.
A missing or unwritable configured path emits a process warning and does not change the tool result.

## Safety and contract behavior

Git is invoked through pi's argument-array `exec` API, never through shell interpolation or an arbitrary shell command.

Git tools use the current pi workspace (`ctx.cwd`) and first resolve its canonical Git repository root.
The environment tool instead uses `realpath(ctx.cwd)` as the project identity and does not require a Git repository.

Paths must be workspace-relative, must remain inside the repository, and must not contain absolute, drive-letter, UNC, traversal, control-character, backslash, symlink-escaping, Git pathspec magic, or wildcard forms.

A `--` argument separates revisions and options from path filters.

`git_diff` accepts omitted paths, the legacy single `path` field, or a new `paths` array, but never both path fields together.
Omit both fields to diff the whole repository.
For new calls, use `paths: ["file"]` for one path or `paths: ["first", "second"]` for multiple paths.
The legacy `path` field remains supported for compatibility.
Empty and duplicate `paths` arrays are rejected.

Revisions must be non-empty, non-option-like Git revision expressions without whitespace, path extraction colons, shell-like wildcard characters, or control characters.

`git_show` intentionally implements `git show <revision> -- <path>` path filtering.

It does not implement `REV:path` blob extraction.

Structured status and log results are limited to 2,000 records and 50 KiB of raw Git output.

Diff and show text are limited to the requested `maxBytes`, from 1 byte through 1 MiB.

Every bounded result contains `output.truncated`, `output.totalBytes`, and `output.totalLines` metadata.

Empty output is returned as an empty string or empty entry list with zero-sized metadata.

Binary output is returned as UTF-8 text, with Git's binary patch representation preserved where Git provides one.

Git failures, invalid revisions, non-repository workspaces, unsafe paths, and cancellation are reported as tool errors rather than being silently converted to successful results.

The tools pass fixed Git options that disable optional index locks and the configured fsmonitor for each invocation.
Diff, log, and show also disable external diff and textconv helpers where Git supports those options.
These measures suppress the helper and lock behaviors covered by this contract, but Git configuration can affect other behavior that is not eliminated by these flags.
The tools are read-only and do not reset, checkout, write, stage, commit, push, fetch, or intentionally execute repository content.

## Development

The package requires Node.js 24 or newer.

Install the package dependencies with the project's package manager.

Use the `verify` tool for final validation, omitting `typecheck` because this project has no standalone typecheck script and TypeScript checking is included in lint through the Oxlint TypeScript plugin.

Use `project_command` for focused format, lint, and test runs, and use its coverage test variant when coverage-sensitive changes are made.

## Loading into pi

The pi manifest points to `src/index.ts` as the extension entry point.

To load the local package for a single run, use:

```bash
pi -e .
```

To install it as a project-local pi package, use:

```bash
pi install -l .
```
