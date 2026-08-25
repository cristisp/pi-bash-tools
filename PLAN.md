# Bash Tools Plan

## Purpose

Build a pi extension that gives agents narrowly scoped, observable, and safe project tools instead of unrestricted shell access.

The extension must not expose an arbitrary shell command interface.

Every tool must define explicit input and output contracts, enforce workspace boundaries, cap output, support cancellation where execution is possible, and report errors without hiding them from the agent.

The extension reduces the agent's direct command surface, but it is not an operating-system sandbox.
Authorized project-code commands execute mutable repository code with the current user's filesystem, process, and network privileges.
Filesystem policy rules govern intercepted pi tools and the move and delete tools; they do not constrain subprocesses or the read-only Git tools.

## Current state

The extension registers eight custom tools: `environment`, `git_status`, `git_diff`, `git_log`, `git_show`, `project_command`, `move`, and `delete`.
It protects pi's built-in `read`, `write`, `edit`, `ls`, `find`, and `grep` tools with the filesystem access-policy interceptor.

The `project_command` catalog currently supports nineteen extension-owned semantic commands: `workspace_path`, `node_version`, `node_project_info`, `node_deps_list`, `node_test`, `node_test_coverage`, `node_e2e`, `node_build`, `node_lint`, `node_lint_fix`, `node_typecheck`, `node_format_check`, `node_format_write`, `fallow_dead_code`, `fallow_dupes`, `fallow_health`, `fallow_audit`, `fallow_list_entry_points`, and `fallow_list_boundaries`.
It runs only catalog-defined operations after policy authorization, with fixed argument arrays, canonical project directories, restricted environments, bounded output, cancellation, and timeouts.

The environment, project-command, and filesystem policies share the user-owned policy file at `getAgentDir()/bash-tools.json`.
Filesystem access uses separate read, write, move, and delete decisions, while read-only Git inspection remains outside the filesystem policy namespace.

The Node script slice includes exact `test:coverage` and `test:e2e` package-script commands.
`node_e2e` forwards only validated structured options for workspace-relative paths, test filtering, projects, workers, retries, headed execution, and test listing after the package-manager separator.
E2E collections, text and path lengths, and the total UTF-8 forwarded-argument size are bounded, and runtime validation matches the generated schema for control characters including U+2028 and U+2029.
The E2E command remains runner-independent and does not detect or directly invoke a specific test runner.

Native macOS validation currently passes the 195-test suite, alongside warning-free lint, formatting, Fallow analysis, Fallow audit, and git diff checks.
Linux runtime validation remains deferred, and Windows and FreeBSD remain unsupported by design.

## Roadmap

### Security hardening

- [ ] Sanitize and length-bound repository-controlled project-command prompt text, including ANSI controls and bidirectional Unicode controls.
- [ ] Add an explicit warning to every project-code approval that mutable repository code runs unsandboxed with the current user's privileges.
- [ ] Bind Fallow command identities to a SHA-256 digest of the resolved project-local executable and verify the digest again immediately before spawn.
- [ ] Add regression coverage proving that replacing a project-local executable invalidates or blocks a persisted approval.
- [ ] Verify ownership and safe permissions for the policy file and its existing parent directories on macOS.
- [ ] Reject extension activation on unsupported runtime platforms before registering partially functional tools.
- [ ] Document `package.json` `denyWrite` as protection against package-script mutation, not as containment of the source code executed by an approved script.
- [ ] Decide whether project-code allows remain persistent, become session-scoped, or require approval per invocation, defaulting to the narrower lifetime unless a sandbox is added.
- [ ] Add tests showing that Git reads intentionally remain available when the same path has a filesystem `denyRead` rule.
- [ ] Add macOS integration coverage for process-group cleanup on timeout and cancellation.

### Additional commands

These additions remain demand-driven and require a separate threat-model review before implementation.

- [ ] Define `project-code-network` risk handling for commands that contact registries or other network services.
- [ ] Implement `node_deps_install` with per-package-manager frozen-lockfile forms and explicit dependency-install risk treatment.
- [ ] Add the remaining audited parameter validator kinds as additional catalog commands require them.
- [ ] Consider Git mutation commands such as commit and stage behind confirmation.
- [ ] Consider a user-owned `customCommands` namespace only as a measured escape hatch.
- [ ] Consider test-name pattern filtering for `node_test` after runner detection is available.
- [ ] Consider .NET ecosystem support.
- [ ] Consider PHP ecosystem support for Symfony and Magento projects after the external-state risk class exists.
- [ ] Define an external-state risk class for application-level commands that mutate databases or shared caches.

### Validation and operations

- [ ] Validate Linux runtime behavior.
- [ ] Verify interactive, print, JSON, and RPC modes through manual monitoring.
- [ ] Add scheduled latest-toolchain fixture-suite runs when maintenance value justifies them.
- [ ] Keep long-running development servers and smoke checks manually controlled.

## Design constraints

- Keep production source under `src/`.
- Keep source-specific tests next to their source file using the `*.test.ts` suffix.
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
- Require explicit policy decisions for environment values, external filesystem access through intercepted tools, filesystem mutation, and project-code execution.
- Treat read-only Git inspection as an intentional workspace capability outside the filesystem policy namespace.
- Add telemetry-free diagnostics sufficient to explain why a request was rejected or failed at a given stage.

## Deferred scope

The following items are intentionally outside the current scope until the relevant design or security review is complete:

- Linux support beyond runtime validation.
- Windows and FreeBSD support.
- Publish, audit-fix, config-set, and cache-mutation commands.
- Arbitrary `npm run <name>`, `npx`, `node -e`, or agent-supplied argv arrays.
- Repository-defined commands through repository-local configuration.
- Watch-mode or interactive commands.
- Git fetch, push, or other operations that contact remote repositories.
