# Bash Tools Plan

## Purpose

Build a pi extension that gives agents narrowly scoped, observable, and safe project tools instead of unrestricted shell access.

The extension must not expose an arbitrary shell command interface.

Every tool must define explicit input and output contracts, enforce workspace boundaries, cap output, support cancellation where execution is possible, and report errors without hiding them from the agent.

## Current status

The extension currently registers six tools: environment, git_status, git_diff, git_log, git_show, and project_command.

The project_command catalog currently supports sixteen extension-owned semantic commands: workspace_path, node_version, node_project_info, node_deps_list, node_test, node_build, node_lint, node_typecheck, node_format_check, node_format_write, fallow_dead_code, fallow_dupes, fallow_health, fallow_audit, fallow_list_entry_points, and fallow_list_boundaries.

The environment tool provides explicit-key access with fail-closed authorization, canonical project identity, restrictive policy storage, locking, atomic writes, cancellation, and timeout handling.

The Git tools provide validated, bounded, cancellable, read-only repository inspection with temporary-repository integration coverage.

The project_command tool supports fixed workspace and Node runtime observation commands, in-process Node project discovery, authorized Node project script commands, and authorized Fallow analysis commands.

project_command accepts a strict discriminated command schema and executes only catalog-defined operations.

It uses direct spawn with shell disabled for executable commands, canonical project working directories, restricted environment profiles, bounded output, cancellation, timeouts, process cleanup, and an in-process path for node_project_info.

Command authorization uses the user-owned policy at `getAgentDir()/bash-tools.json`, canonical project paths, command fingerprints, policy precedence, and interactive confirmation.

Command decisions migrate a version 1 environment document to a version 2 document containing the unchanged nested environment version 1 policy and a version 1 project command policy namespace.

Native macOS validation currently passes the 154-test suite, with V8 coverage remaining above the 75% lines, functions, statements, and branches thresholds, alongside TypeScript checks, warning-free lint, formatting, Fallow analysis, Fallow audit, and git diff checks.

Linux runtime validation remains deferred, and Windows and FreeBSD remain unsupported by design.

The simplification pass is complete: one policy store in `src/tools/policy/` serves both policy consumers, a shared authorize-or-prompt helper in `src/tools/authorization.ts` serves both interactive tools, and the executor uses direct process event handling without mock-driven fallback machinery.

The cleanup-failure execution status was removed from the tool contract because it was unreachable with real processes.

The catalog architecture, the Node command slice, the read-only dependency-list command, and the Fallow command slice are complete.

The next milestone is the separately reviewed dependency-install command for node_deps_install, which remains deferred because it contacts registries, mutates project state, and executes dependency lifecycle code.

## Existing pi capabilities

Pi already provides the built-in `read`, `write`, `edit`, `grep`, `find`, `ls`, and `bash` tools.

Pi's default coding tool set contains `read`, `bash`, `edit`, and `write`.

Pi's read-only tool set contains `read`, `grep`, `find`, and `ls`.

All seven tools are real pi-provided capabilities, even when they are not active in the default tool set.

This extension must not duplicate those tools or register replacements for them by default.

The built-in `bash` tool remains intentionally outside this extension's safe-tool surface and serves as the user-governed fallback for anything the catalog does not cover.

The extension should use `ctx.cwd` and existing pi path handling instead of adding a redundant working-directory tool.

## Current extension tool catalog

Each extension tool has a dedicated source folder under `src/tools/`.

| Tool            | Implementation                              | Current safety boundary                                                           |
| --------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| Environment     | `src/tools/environment/environment-tool.ts` | Return only explicitly requested and authorized environment variables.            |
| Git status      | `src/tools/git/status/tool.ts`              | Inspect repository status without changing the working tree.                      |
| Git diff        | `src/tools/git/diff/tool.ts`                | Read bounded diffs for approved paths without changing the repository.            |
| Git log         | `src/tools/git/log/tool.ts`                 | Read bounded commit history with validated revision and path inputs.              |
| Git show        | `src/tools/git/show/tool.ts`                | Read a bounded object or file revision without executing repository content.      |
| Project command | `src/tools/project-command/tool.ts`         | Run only catalog-defined semantic commands after user-owned policy authorization. |

## Target command architecture

### Catalog

The command catalog is extension-owned code and never reads repository configuration to define commands.

Definitions are data: id, description, applicability probe, risk class, globalSafe flag, bindsRepoContent flag, environment profile, timeout, output limit, truncation direction, parameter declarations, and a resolve function.

The v1 catalog covers global observation, Node project commands, and Fallow analysis commands on the macOS runtime.

.NET and PHP ecosystem modules are kept in mind through the module shape but are not part of v1.

The single `project_command` tool derives its input schema from the catalog as a discriminated union on commandId at load time.

Applicability is enforced at execution time, and unknown or inapplicable commands fail with an error listing the commands applicable to the current project.

The initial Node slice implements this behavior for node_project_info, node_test, node_build, node_lint, and node_typecheck.

The Fallow slice implements fixed project-local analysis commands with the same applicability, authorization, bounded-output, and resolution guarantees.

### Resolution

Resolution is a first-class stage between catalog lookup and authorization.

Resolution stages are applicability probe, toolchain detection, fail-closed binary resolution, and repository-content hashing.

Node package manager detection reads the packageManager field first, then lockfiles, then defaults to npm.

Lockfile-only detection works for npm, pnpm, and bun; yarn requires the packageManager field because Yarn Classic and Yarn Berry diverge on the exact flags this catalog uses.

A detected package manager that is not installed fails with a clear error and never downgrades to npm.

When resolution would need to guess, it fails closed with an actionable error instead.

node_modules/.bin binaries resolve through realpath and spawn through process.execPath without PATH lookup or npx.

### Risk classes

`observe` commands never execute repository-defined content and only read local state; they are eligible for global allow.

`project-code` commands execute repository scripts or dependency binaries; they allow per project only and are never globalSafe.

`project-code-network` commands are project-code commands that also contact registries or other network services, such as dependency installation.

`external-state` commands mutate state outside the project directory, such as databases or shared caches; they are deferred until stronger policy treatment exists.

### Parameters

Commands are an open set of definitions composed from a closed set of audited validator kinds.

Validator kinds are workspace-paths, revision, enum, bounded-pattern, and integer-range.

Argv mappings are positional after `--`, `--flag=value`, `--flag value` with leading-dash rejection, and repeated per item.

Parameters select what to run and never change how the command behaves.

The risk class of a definition must be the worst case over all accepted parameter values.

Behavior-changing flags become separate command ids, not parameters.

Parameter schemas are part of the definition fingerprint; parameter values are runtime input and are not individually authorized.

Adding a validator kind is a security-reviewed change; adding a command over existing kinds is catalog data.

### Policy identity and repository-content binding

A policy identity combines the semantic command id with a SHA-256 fingerprint over the definition, including its parameter schema, environment profile, and limits.

Script-mediated definitions marked bindsRepoContent additionally hash the canonicalized scripts section of the package manifest.

Canonicalization parses the scripts section, sorts keys, and serializes deterministically, so whitespace-only edits do not invalidate approvals.

Resolution happens before authorization, so prompts and identities reflect the resolved command.

Prompts display the resolved command line and, for script-mediated commands, the script text being authorized.

The node_deps_install prompt warns that install scripts execute dependency code and that the command contacts the registry.

Policy documents validate command id shape, not catalog membership, so removed commands leave inert stale entries.

### Environment profiles

`minimal-static-v1` provides PATH=/usr/bin:/bin with LANG and LC_ALL and serves global commands.

`node-v1` adds HOME, prepends the node binary directory to PATH, and sets CI=true for non-interactive tool behavior.

Per-ecosystem profiles such as dotnet-v1 and php-v1 join when those catalogs land.

### Output and truncation

stdout and stderr stay bounded per definition.

project-code commands default to tail-biased truncation because failure summaries live at the end of test and build output.

observe commands keep head-biased truncation.

Structured details include the resolved display command and the effective parameter values.

### Error taxonomy

Stage failures are first-class and reported by stage: probe, detection, binary resolution, spawn, timeout, and policy.

Extension failures are distinct from command failures; a nonzero exit is data for the agent, not an extension error.

Errors state what was expected and where resolution looked without exposing secrets.

Diagnostics remain telemetry-free.

## Distribution and operations

The package distributes through pi's npm or git package sources; git distribution keeps internal releases at push-tag plus `pi update --extensions`.

Definition fixes ship a new release, and changed fingerprints invalidate stale approvals automatically.

Users can deny-global a broken command immediately as a circuit breaker without waiting for a release.

Removing a command id from the catalog is safe because stale policy entries stay inert.

Integration tests run real toolchains against fixture projects, and scheduled runs against latest toolchains catch ecosystem drift.

## Explicit exclusions

No arbitrary `npm run <name>`, `npx`, `node -e`, or agent-supplied argv arrays.

No dependency add, remove, or update commands, because dependency changes are a semantic user decision.

No publish, audit-fix, config-set, or cache-mutation commands.

No repository-defined commands through repository-local configuration.

No watch-mode or interactive commands; definitions must be non-interactive by default.

No Magento or Symfony application-level commands until the external-state risk class exists.

## Target v1 command catalog

| id                       | Resolution                                                                | Risk                 | Parameters                |
| ------------------------ | ------------------------------------------------------------------------- | -------------------- | ------------------------- |
| workspace_path           | `/bin/pwd` (existing)                                                     | observe              | none                      |
| node_version             | `node --version` (existing)                                               | observe              | none                      |
| node_project_info        | in-process: PM detection, script names, applicable commands, node version | observe              | none                      |
| node_deps_list           | manager-specific top-level dependency listing                             | observe              | none                      |
| node_test                | `<pm> run test -- ...`                                                    | project-code         | paths (workspace-paths)   |
| node_build               | `<pm> run build`                                                          | project-code         | none                      |
| node_lint                | `<pm> run lint`                                                           | project-code         | none                      |
| node_typecheck           | `<pm> run typecheck` (exact script name)                                  | project-code         | none                      |
| node_format_check        | `<pm> run format:check` (exact script name)                               | project-code         | none                      |
| node_format_write        | `<pm> run format` (exact script name)                                     | project-code         | none                      |
| node_deps_install        | `npm ci` / per-PM frozen-lockfile equivalent                              | project-code-network | none                      |
| fallow_dead_code         | `node_modules/.bin/fallow dead-code --format json --quiet`                | project-code         | none                      |
| fallow_dupes             | `fallow dupes --format json --quiet`                                      | project-code         | none                      |
| fallow_health            | `fallow health --format json --quiet`                                     | project-code         | none                      |
| fallow_audit             | `fallow audit --format json --quiet --base <ref>`                         | project-code         | base (revision, required) |
| fallow_list_entry_points | `fallow list --entry-points --format json --quiet`                        | project-code         | none                      |
| fallow_list_boundaries   | `fallow list --boundaries --format json --quiet`                          | project-code         | none                      |

node_project_info is the discovery command: agents run it first to learn the detected package manager, available script names, and which catalog commands apply to the current project.

The tool description and inapplicable-command errors steer agents toward node_project_info.

The v1 pattern parameter for node_test remains deferred because the script hides the test runner and name-filter flags differ per runner; path selection covers the dominant case.

The dependency-install command remains deferred until manager-specific frozen-lockfile behavior and network/install-script risk receive a separate security review.

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
- Require explicit policy decisions for operations that can expose sensitive history, content, or values.
- Add telemetry-free diagnostics sufficient to explain why a request was rejected or failed at a given stage.

## Implementation tasks

### Simplification pass

- [x] Extract the shared policy document model from `src/tools/environment/policy/` into `src/tools/policy/` consumed by both tools.
- [x] Remove the `policy-format.ts` pass-through and let the store answer decisions directly from the loaded policy.
- [x] Rewrite the project command executor without mock-driven machinery, using direct EventEmitter attachment and realistic test fakes.
- [x] Merge the duplicated authorize-or-prompt flows of the environment and project command tools into one helper.
- [x] Shorten redundant `ProjectCommand` symbol prefixes inside the module.
- [x] Reduce input validation to the catalog lookup and plain shape checks.

### Catalog machinery

- [x] Define the data-driven command definition shape and migrate workspace_path and node_version onto it.
- [x] Derive the tool input schema from the catalog as a discriminated union on commandId.
- [x] Implement the resolution pipeline with stage-tagged errors.
- [x] Implement applicability probes and applicable-command error listings for the initial Node command slice.
- [x] Report required package.json scripts and fixed package-manager commands when Node script commands are inapplicable.
- [x] Implement node package manager detection and fail-closed binary resolution.
- [x] Implement manager-specific read-only dependency listing and Yarn Classic version gating.
- [x] Implement the observe and project-code risk classes and their policy consequences for the initial Node slice.
- [x] Implement the initial closed parameter model with workspace-path validation and argv mapping for node_test.
- [x] Include parameter schemas in definition fingerprints.
- [x] Implement repository-content binding through canonicalized scripts hashing.
- [x] Implement the node-v1 environment profile.
- [x] Implement tail-biased truncation for project-code commands.
- [x] Show resolved command lines and script text in confirmation prompts.
- [ ] Implement project-code-network risk handling for dependency commands.
- [ ] Add the remaining audited parameter validator kinds as additional catalog commands require them.

### Node commands

- [x] Implement node_project_info as an in-process command.
- [x] Implement node_test with the paths parameter.
- [x] Implement node_build, node_lint, and node_typecheck.
- [x] Implement node_format_check and node_format_write with exact package-script resolution.
- [x] Implement node_deps_list with manager-specific read-only forms.
- [ ] Implement node_deps_install with per-package-manager frozen-lockfile forms.
- [x] Implement the Fallow command family including the audit base revision parameter.

### Controlled execution

- [x] Implement allowlisted project-command execution with fixed argument arrays instead of shell strings.
- [x] Add timeout, cancellation, process cleanup, and output truncation behavior.
- [x] Keep timeout, cancellation, cleanup, and truncation behavior green through the executor rewrite.

### Pi integration

- [x] Add TypeBox schemas that match the TypeScript contracts.
- [x] Register tool descriptions and prompt metadata that clearly communicate limits and command selection.
- [x] Use Pi's default tool rendering where custom rendering is not necessary.
- [x] Add session-safe details for structured tool results.
- [x] Add a migration path for policy and contract changes.

### Testing and quality

- [x] Add unit tests for workspace policy, allowlists, validation, truncation, and error mapping.
- [x] Add contract tests for every extension tool input and output shape.
- [x] Add mocked execution tests for project commands and Git operations.
- [x] Add integration tests covering tool registration and tool-call dispatch.
- [x] Add rejection tests for path traversal, shell metacharacters, unallowlisted commands, oversized output, invalid revisions, and sensitive operations.
- [x] Add cancellation and timeout tests for every executable tool.
- [x] Add byte-exact serializer fixtures pinning the version 1 and version 2 policy document formats.
- [x] Add dismissal and cancellation-race regression tests for the shared authorization flow.
- [x] Add broad cross-tool tests under `test/` for policy composition and command execution behavior.
- [x] Add initial fixture-project integration coverage for Node project discovery and authorized script execution.
- [x] Add fixture-project integration coverage for Fallow binary resolution, fixed argv, and audit exit-code behavior.
- [x] Add fixture-project integration tests for all practical implemented catalog commands using real package manager, Node runner, and Fallow binaries.
- [x] Add Vitest coverage reporting with `@vitest/coverage-v8`.
- [x] Add a coverage script and enforce at least 75% lines, functions, statements, and branches.
- [x] Keep the available test, type, lint, format, and Fallow checks passing before committing.
- [x] Run the Fallow audit and targeted checks before committing AI-generated changes.

### Deferred

- Linux runtime validation.
- Windows and FreeBSD support.
- .NET ecosystem module and catalog.
- PHP ecosystem module and catalog for Symfony and Magento projects.
- external-state risk class and application-level commands.
- User-owned customCommands namespace as a measured escape hatch.
- Git mutation commands such as commit and stage behind confirmation.
- Test-name pattern filtering for node_test, pending runner detection.
- node_deps_install, pending manager-specific frozen-lockfile and dependency-install risk review.
- Interactive, print, JSON, and RPC mode verification, deferred in favor of manual monitoring.
- Scheduled latest-toolchain fixture-suite runs, skipped for now.
- Long-running development servers and smoke checks, deferred because they should remain manually controlled for now.
