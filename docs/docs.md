# Bash Tools documentation

Bash Tools is a pi extension that exposes narrow Git, environment, filesystem, project-command, and verification capabilities without adding an arbitrary shell interface.

## Start here

- [Overview](overview.md) - extension registration, native pi tool interception, and shared safety rules.
- [Tool catalog](tools.md) - complete custom tool surface and native-tool additions.
- [Git tools](git.md) - bounded status, diff, log, and show operations.
- [Filesystem tools and policy](filesystem.md) - `read_batch`, `move`, `delete`, and authorization for native filesystem tools.
- [Environment](environment.md) - explicitly requested variables and user-owned authorization.
- [Project commands](project-command.md) - fixed Node observations, package scripts, dependency listing, and Fallow analyses.
- [Verification](verify.md) - fixed-order format, lint, typecheck, and test execution with evidence.
- [Policy document](policy.md) - policy file schema, precedence, prompts, persistence, and fail-closed behavior.
- [Artifacts and observability](artifacts.md) - caches, evidence, pi session entries, and the optional invocation stream.

## Reading the documentation

Inputs use the exact JSON field names accepted by the tools.

Outputs describe the useful `details` object returned with the tool result, while the model-facing text may be a compact projection.

Limits and authorization behavior are part of the public contract, so the linked pages document them alongside the schemas.
