# Project commands

`project_command` accepts only the fixed catalog below.

It never accepts an arbitrary executable, shell command, alias, watch mode, inline script, dependency installation request, Git request, file request, or environment request.

The project command policy authorizes the semantic command ID together with its SHA-256 definition fingerprint and canonical project path.

## Input forms

Every execution request has a `commandId` and may include `force`, `covers`, and `publish`.

`force` is a boolean or the compatibility literal `"true"` or `"false"`, and bypasses a result-cache reuse without changing the cache key.

`covers` contains at most 64 opaque strings, each 1 through 512 characters, that are preserved in evidence.

`publish` is `{ "flowId": "bounded-flow-id" }` and explicitly publishes compatible evidence after authorization.

A lookup request is a separate shape containing only `ref`, optional `flowId`, and optional `covers`.

Lookup requests never execute a command and cannot include `force`, `publish`, or command execution fields.

Every optional field also accepts explicit `null`, treated as omitted (strict-decoder compatibility).

### Path and variant parameters

`node_test` optionally accepts `paths` as a safe workspace-relative string array or a JSON string containing that array.

It accepts at most 64 paths, each at most 4,096 characters, and forwards them after the package-manager separator.

The total forwarded argument budget is capped at 64 KiB.

`node_test` optionally accepts `variant` to select an existing `test:<variant>` script.

`node_lint` optionally accepts `variant` to select an existing `lint:<variant>` script.

`node_format` optionally accepts `variant` to select an existing `format:<variant>` script.

Variants are at most 128 characters and match `^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)*$`.

`fallow_audit` requires a `base` revision that matches the safe revision grammar and is passed only to the fixed Fallow audit form.

Legacy variant aliases such as `node_lint:fix` remain accepted, but new calls should use `commandId: "node_lint", variant: "fix"`.

## Command catalog

| Command ID                 | Operation                                                             | Policy and execution notes                                                                                     |
| -------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `workspace_path`           | Spawn `/bin/pwd` with no arguments.                                   | Global-safe static observation with head-biased output.                                                        |
| `node_version`             | Spawn the active Node executable with `--version`.                    | Global-safe static observation with head-biased output.                                                        |
| `node_project_info`        | Read `package.json` and supported lockfiles in process.               | Reports Node version, manifest presence, detected package manager, sorted scripts, and applicable command IDs. |
| `node_deps_list`           | Run a fixed top-level dependency listing.                             | Uses npm, pnpm, bun, or supported Yarn Classic 1.x forms and accepts exit code 1.                              |
| `node_test`                | Run the exact `test` or selected `test:<variant>` package script.     | Optional workspace-relative test paths are forwarded as fixed arguments.                                       |
| `node_build`               | Run the exact `build` package script.                                 | Project-controlled code and never globally safe.                                                               |
| `node_lint`                | Run the exact `lint` or selected `lint:<variant>` package script.     | Project-controlled code and never globally safe.                                                               |
| `node_typecheck`           | Run the exact `typecheck` package script.                             | Project-controlled code and never globally safe.                                                               |
| `node_format`              | Run the exact `format` or selected `format:<variant>` package script. | Project-controlled code and may mutate the workspace.                                                          |
| `fallow_dead_code`         | Run the project-local Fallow dead-code analysis.                      | Fixed JSON and quiet arguments.                                                                                |
| `fallow_dupes`             | Run the project-local Fallow duplicate-code analysis.                 | Fixed JSON and quiet arguments.                                                                                |
| `fallow_health`            | Run the project-local Fallow health analysis.                         | Fixed JSON and quiet arguments.                                                                                |
| `fallow_audit`             | Run the project-local Fallow audit with `--base`.                     | Requires `base` and uses a validated revision.                                                                 |
| `fallow_list_entry_points` | Run Fallow entry-point listing.                                       | Fixed JSON and quiet arguments.                                                                                |
| `fallow_list_boundaries`   | Run Fallow boundary listing.                                          | Fixed JSON and quiet arguments.                                                                                |

The exact package script must exist in `package.json` before the command is resolved.

The extension detects npm, pnpm, bun, or Yarn from supported project metadata and lockfiles.

Yarn lockfile-only projects and explicit Yarn versions other than Classic 1.x are rejected for dependency listing.

Fallow commands require a safe project-local `node_modules/.bin/fallow` target and invoke it through the active Node executable.

Missing manifests, malformed manifests, ambiguous package managers, missing scripts, unavailable fixed executables, and escaping binaries fail closed.

The fixed dependency-list arguments are `npm ls --depth=0`, `pnpm list --depth=0`, `bun pm ls`, and Yarn Classic `list --depth=0`.

The fixed Fallow argument forms are `dead-code --format json --quiet`, `dupes --format json --quiet`, `health --format json --quiet`, `audit --format json --quiet --base <base>`, `list --entry-points --format json --quiet`, and `list --boundaries --format json --quiet`.

Dependency listing and Fallow analyses accept exit code 1 as a meaningful nonzero result rather than a spawn failure.

## Execution environment and limits

All commands use the canonical project directory as `cwd`.

Observation commands use a minimal static environment, while Node, package-manager, and Fallow commands use a bounded `node-v1` environment containing static values, `HOME`, `CI=true`, and the active Node binary directory at the front of `PATH`.

No shell is used, and stdin is ignored.

Each process has a fixed 30-second timeout and output is capped at 50 KiB per stream.

Observation output is head-biased, while script and Fallow output is tail-biased.

The model-facing projection sanitizes and compacts each output stream to at most 1,200 characters while retaining bounded head and tail context.

Execution statuses are `success`, `nonzero`, `timeout`, `spawn-failure`, and `cancelled`.

Result categories include `PASS`, `INVALID_REQUEST`, `IMPLEMENTATION_FAILURE`, `TEST_FAILURE`, `FORMAT_FAILURE`, `LINT_FAILURE`, `TYPE_CHECK_FAILURE`, `RESOLUTION_FAILURE`, `POLICY_FAILURE`, `ENVIRONMENT_FAILURE`, `TIMEOUT`, `SPAWN_FAILURE`, `CANCELLED`, and `BLOCKED`.

## Rejected requests and retry classification

Rejected and preflight requests preserve structured metadata in `tool_result.details`, even when the host had to synthesize the error result after the tool threw.

The metadata includes `resultCategory`, `executed`, `retryable`, the stable `error.code`, and bounded diagnostics.

Invalid requests use `INVALID_REQUEST` with `executed: false` and `retryable: false`.

Policy denials use `BLOCKED` or `POLICY_FAILURE` with `executed: false` and a stable policy code.

Resolution failures, including a test path outside the canonical workspace, use `RESOLUTION_FAILURE`, `executed: false`, and a stable resolution code such as `test-path-outside-workspace`.

A command that actually ran and returned a failing status remains an executed failure.

For example, a formatting failure uses `FORMAT_FAILURE`, `executed: true`, and its command diagnostics rather than a preflight classification.

Repeated records with the same command identity, `resultCategory`, and `executed` value can therefore be recognized as orchestration churn instead of being counted as a new producer defect.

`retryable` indicates whether a retry may help after the agent addresses the reported cause; it does not mean that the command did not execute.

## Result shape

A successful or failed execution returns a details object with the following principal fields.

```json
{
  "commandId": "node_test",
  "projectPath": "/canonical/project",
  "status": "success",
  "category": "PASS",
  "executed": true,
  "resolvedCommand": "...",
  "parameters": { "commandId": "node_test" },
  "exit": { "code": 0, "signal": null },
  "timedOut": false,
  "cancelled": false,
  "stdout": {
    "text": "...",
    "truncated": false,
    "totalBytes": 10,
    "totalLines": 1
  },
  "stderr": {
    "text": "",
    "truncated": false,
    "totalBytes": 0,
    "totalLines": 0
  },
  "reused": false,
  "forced": false,
  "cacheDecision": "ineligible",
  "ref": "pc_example"
}
```

The details may also include project information, `diagnostic`, `suggestedAction`, fingerprints, relevant inputs, repository state, mutability, concurrency, drift, provenance, publication, and producer fields.

Model-facing content carries the bounded evidence `ref` when a completed execution stored evidence, the `publication` outcome when the request asked to publish, and the bounded coercion tokens when the request carried nullable placeholders that were treated as absent; each key is omitted entirely when it is undefined, and the remaining evidence metadata stays in details.
Failing and cancelled executions report the stored `pc_` reference in the failure or cancellation message and keep `ref` and `publication` in their error details and invocation records.
Only the reference enters the message; the realized publication outcome stays in error details.

`node_project_info` also exposes `nodeVersion`, `manifestPresent`, `packageManager`, `scripts`, and `applicableCommands` when available.

## Caching and evidence

Static observations can use static reuse, while project metadata can use metadata-sensitive reuse.

Package scripts, Fallow analyses, and other commands with uncontrolled external state use `reusePolicy: "never"`.

Non-mutating identical requests can use single-flight coordination, which is reported separately as `sharedExecution: true`.

Repository state includes the canonical repository identity, `HEAD`, and a dirty-files digest that includes Git-reported paths, content, mode, size, and status.

A completed execution that stored evidence returns the bounded `pc_` reference in model-facing content, and a request that asked to publish reports the realized publication outcome there.
A failing or cancelled execution that stored evidence reports the `pc_` reference in the failure or cancellation message, and the realized publication outcome remains in error details.

See [Artifacts and observability](artifacts.md) for cache paths, evidence scope, and invocation records.
