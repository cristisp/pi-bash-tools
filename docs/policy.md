# Policy document

Environment, project-command, and filesystem authorization share the user-owned policy file at `getAgentDir()/bash-tools.json`.

The extension does not read repository-local authorization files.

The policy path and every parent directory must be regular, non-symlink filesystem objects.

The extension supports macOS and Linux policy storage and fails closed on unsupported runtime platforms.

## Document shape

The current document version is `4`.

```json
{
  "version": 4,
  "environment": {
    "version": 1,
    "confirmationTimeoutMs": 120000,
    "global": {
      "allow": [],
      "deny": []
    },
    "projects": {
      "/canonical/project": {
        "allow": [],
        "deny": []
      }
    }
  },
  "projectCommands": {
    "version": 1,
    "global": {
      "allow": [],
      "deny": []
    },
    "projects": {
      "/canonical/project": {
        "allow": [
          {
            "commandId": "node_test",
            "fingerprint": "64 hexadecimal characters"
          }
        ],
        "deny": []
      }
    }
  },
  "filesystem": {
    "version": 2,
    "global": {
      "allowRead": [],
      "allowWrite": [],
      "denyRead": [],
      "denyWrite": [],
      "allowMove": [],
      "denyMove": [],
      "allowDelete": [],
      "denyDelete": []
    },
    "projects": {}
  }
}
```

A version 1 environment-only document is accepted and is migrated to version 2 when project-command decisions are saved.

A version 2 document is accepted and is migrated to version 4 when filesystem decisions are saved.

Environment project keys and filesystem paths are canonical absolute paths.

Environment names must be unique valid variable names.

`confirmationTimeoutMs` is an optional integer from 0 through 2,147,483,647 and defaults to 120,000 milliseconds.

Filesystem paths are canonical absolute paths, and each allow or deny list is unique.

Project-command entries contain exactly a semantic `commandId` and a SHA-256 definition fingerprint.

Unknown properties, malformed JSON, invalid types, duplicate entries, same-scope allow and deny conflicts, and invalid versions are rejected without exposing raw policy content.

## Precedence and persistence

The general precedence is global deny, project deny, global allow, project allow, and unknown.

Global command and environment allows are not offered for commands or variables that are not globally safe.

Project-command permissions are project-scoped and interactive project-command prompts offer `Deny once`, `Deny for this project`, `Allow once`, and `Allow for this project`.

Filesystem and environment prompts may offer global choices where their capability permits them.

The policy writer uses an adjacent exclusive lock for up to 5 seconds with 25 millisecond retries.

The lock file is `bash-tools.json.lock`.

Existing policy locks are never reclaimed automatically.

Policy writes use a temporary file with mode `0600` and an atomic rename.

If a process crashes while holding the lock, remove the lock manually only after confirming that no pi process owns it.

## Fail-closed rules

Unreadable policy data, unsafe policy paths, lock failures, invalid approval choices, save failures, and unsupported platform behavior deny the request.

Policy decisions never authorize arbitrary shell execution or dependency installation.

See [Environment](environment.md) and [Filesystem tools and policy](filesystem.md) for capability-specific behavior.
