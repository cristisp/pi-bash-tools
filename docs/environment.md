# Environment

The `environment` tool reads only explicitly requested variables after authorization.

It reads the current process environment and never reads a repository `.env` file or another environment file.

## Input

```json
{
  "keys": ["PUBLIC_API_URL", "CI"]
}
```

`keys` is required, non-empty, unique, and each name must match `^[A-Za-z_][A-Za-z0-9_]*$`.

Unknown fields and wildcard names are rejected.

## Result

```json
{
  "values": {
    "PUBLIC_API_URL": "https://example.test",
    "CI": null
  }
}
```

Missing variables are returned as `null`.

Values are returned only after every requested key is authorized.

`environment` declares an `outputSchema` and returns the same payload as `structuredContent` for successful results.
Failures throw as before and carry no structured content.

## Authorization

The policy file is user-owned and located at `getAgentDir()/bash-tools.json`, which normally resolves to `~/.pi/agent/bash-tools.json`.

Global deny, project deny, global allow, project allow, and unknown are evaluated in that order.

A global deny cannot be overridden by a project rule.

Unknown keys are prompted only in TUI or RPC mode when pi reports `hasUI`.

Non-interactive modes deny unknown keys without changing the policy.

Interactive choices are `Deny once`, `Deny globally`, `Deny for this project`, `Allow once`, `Allow globally`, and `Allow for this project`.

A one-time choice applies only to the current request.

A cancellation before policy commit changes nothing, while a cancellation after commit returns no values and retains the committed decision.

A confirmation timeout records a project-level deny and returns no values.

When an orchestrated subagent reaches a manual policy approval prompt, the extension emits a warning notification through Pi before opening the prompt.
In TUI and RPC modes it also emits a terminal-native notification through OSC 777, Kitty OSC 99, or a Windows toast when the terminal supports it.
Notification failures are ignored and never change the authorization result.

See [Policy document](policy.md) for the complete policy schema and storage rules.
