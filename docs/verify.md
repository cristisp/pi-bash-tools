# Verification

The `verify` tool runs the format, lint, typecheck, and test phases in that fixed order.

Each phase resolves an exact package script from the project and uses the same bounded project-command execution rules described in [Project commands](project-command.md).

## Input

```json
{
  "paths": ["src/example.test.ts"],
  "omit": ["typecheck"],
  "scripts": {
    "format": "format:check",
    "lint": "lint",
    "test": "test:coverage"
  },
  "continueOnFailure": false,
  "fresh": false,
  "covers": ["AC-001"],
  "publish": { "flowId": "flow-1" }
}
```

`paths` is optional and may be a safe workspace-relative string array or a JSON string containing that array.

`omit` contains unique phase names from `format`, `lint`, `typecheck`, and `test`.

`omit` may contain at most four phases, and an omitted phase cannot also select a script in `scripts`.

`scripts` selects exact package script names for individual phases.

Script names use the bounded package-script grammar described in [Project commands](project-command.md).

`continueOnFailure` defaults to false and controls whether later phases run after a failure.

`fresh` forces a new execution without changing the content-addressed evidence key.

`fresh` cannot be combined with `ref`.

`covers` preserves at most 64 opaque acceptance-criteria strings.

`publish` requests publication to an authorized flow after execution.

A lookup request uses `ref` and may include `flowId` and `covers`, but it cannot include execution fields such as `fresh`, `publish`, `paths`, `omit`, or `scripts`.

Every optional field also accepts explicit `null`, treated as omitted (strict-decoder compatibility).

## Result

```json
{
  "status": "completed",
  "verdict": "passed",
  "ref": "vr_example",
  "projectPath": "/canonical/project",
  "reused": false,
  "covers": ["AC-001"],
  "perStep": [
    {
      "phase": "format",
      "status": "passed",
      "verdict": "passed",
      "command": "...",
      "exitCode": 0,
      "signal": null,
      "durationMs": 100,
      "executed": true,
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
      }
    }
  ],
  "repositoryStateStatus": "matches"
}
```

`perStep` always uses the phase order `format`, `lint`, `typecheck`, `test`.

A phase can be `passed`, `failed`, `omitted`, or `not-run`.

A failed or not-run phase makes the aggregate verdict `failed`.

An omitted phase makes the aggregate verdict `incomplete` when no phase failed.

Only a complete run with no failed or omitted phase has a `passed` verdict.

Failures may include a sanitized bounded `failureTail`.

The process status of an individual phase is separate from the aggregate verification verdict.

The default per-step verification guard is 2 minutes, and the default aggregate guard is 10 minutes.

These guards are separate from the 30-second project-command process timeout.

## Evidence and freshness

A successful execution can return a `vr_` evidence reference when repository state is readable and stable.

An unchanged request can return `status: "unchanged"`, `reused: true`, and the same reference with compact step output.

A fresh execution reports `reused: false` and may retain the same reference when its evidence is identical.

Evidence records contain the request key, reference, project path, resolved commands, all four step results, verdict, covers, repository state, provenance, publication, mutability, concurrency, drift, and shared-execution metadata when applicable.

`repositoryStateStatus` is `matches`, `mismatch`, or `unreadable` when recorded and current state are compared.

`stateDrift: true` indicates that the repository changed between the beginning and end observations of an execution.

Verification authorization is project-scoped and never globally safe because package scripts are project-controlled code.

Consent is bound to the selected phase scripts, the script bodies, `omit`, and `continueOnFailure`, so changed file contents or test paths do not invalidate a persisted project allow while an edited package script requires re-approval.

A persisted project allow or deny is honored in normal sessions and inside an authorized flow, and an edited package script body, a different phase selection, or a changed `omit` or `continueOnFailure` value prompts again.

See [Artifacts and observability](artifacts.md) for cache retention and [Policy document](policy.md) for authorization storage.
