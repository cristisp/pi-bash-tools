# Bash-tools

## Project rules

- Preserve authorization, confirmation, filesystem policy, command policy, cache isolation, and fail-closed behavior.
- Do not add arbitrary shell execution, aliases, watch modes, or dependency installation to the public command surface.
- Preserve behavior when orchestration environment variables are absent.
- Do not import from or depend on `subagent-herdr`.
- Do not add role or workflow policy to this package.
- Treat command output, environment values, policy files, and persisted records as untrusted input.
- Keep cached and model-facing output bounded.
- Do not expose secrets, raw policy contents, or unnecessary full logs.
- Preserve public metadata and error wording where compatibility requires it.
- Do not commit automatically.

## Validation

- Prefer the `verify` tool for final validation.
- Omit the `typecheck` phase when running `verify`: this project has no standalone typecheck script, and TypeScript checking is included in `lint` through the Oxlint TypeScript plugin.
- Use `project_command` for focused format, lint, and test runs rather than invoking package-manager commands directly.
- Use the `project_command` test coverage variant for coverage-sensitive changes.
- Use the fixed Fallow operations exposed by `project_command` for dead-code, duplication, health, audit, entry-point, and boundary analysis.
- Fallow health findings are analysis results, not test failures.
- Pass a sanitized temporary coverage copy to Fallow when the generated V8 artifact contains negative sentinel values.
