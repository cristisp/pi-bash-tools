# Development and maintenance

## Runtime architecture

`index.ts` is the entry point.
It guards registration to herdr, reconciles the registry, prunes old flows, registers commands, and installs child budget enforcement.

The main runtime is split into these concerns:

- `src/execute.ts` validates parameters, discovers agents, evaluates composition, and dispatches single, parallel, chain, or reuse modes.
- `src/spawn-boundary.ts` canonicalizes the root session folder and requested cwd values (through `realpath`, tolerating not-yet-existing targets) and reports the delegations whose cwd resolves outside the root; `executeSubagent` refuses those before any child is launched, and `ensurePaneExists` in `src/run.ts` refuses to recreate a vanished reuse pane outside the root.
- `src/run.ts` creates tabs, launches or prompts Pi, polls settlement, records outcomes, writes reports, and emits telemetry.
- `src/ui-prompt-marker.ts` writes and parses the session-tail UI prompt markers the poller uses to detect and settle-suppress approval waiting, and emits `herdr:blocked` events for the daemon.
- `src/delegation.ts` derives flow and delegation identity, sanitizes scope, and exports child environment variables.
- `src/flow.ts`, `src/ledger.ts`, `src/manifest.ts`, and `src/scope.ts` own durable flow artifacts.
- `src/registry.ts` and `src/registry-store.ts` own workspace-scoped session state and locking.
- `src/budget.ts` enforces child budgets, role permissions, and repository write exclusion.
- `src/structured-result.ts` owns the bounded structured-output projection and `outputSchema` for the subagent tools.
- `src/report.ts`, `src/format.ts`, and `src/metrics.ts` reduce child output and collect run summaries.
- `src/telemetry.ts` writes delegation and composition records for analysis.
- `src/commands.ts`, `src/presets.ts`, and `src/templates.ts` provide setup, model selection, and standard role contracts.

## Pi 1.0.3 features (S13)

The repository installs and typechecks against pi 1.0.3.
The `*` peer dependencies only promise that any installed version is accepted; the exact version comes from `package-lock.json`, so bumping it means installing the package explicitly (for example `npm install @earendil-works/pi-coding-agent@latest`), while a plain `npm install` or `npm ci` keeps the locked version.

- `src/structured-result.ts` owns the bounded structured-output projection and the `outputSchema` declared on `subagent` and `subagent_override`.
  The projection and the schema share the same field and array limit constants, so they cannot
drift; tests validate projected output against the schema with `typebox/value` and pin field
coverage, so there is no manual sync rule to maintain.
  A refused call is an `isError: true` result whose model-facing text is unchanged and whose bounded `refusal` (`kind` plus capped message) is part of the projection, so codemode callers can tell a refusal apart from an empty success; informational responses such as agent and session listings stay normal results and stay text-only, reported as empty results in the projection rather than as a new listing surface.
  Every projected string is capped, including the agent name; the model-facing text is never derived from the projection, and transcripts, stderr, read manifests, dirty paths, and internal metrics are never part of it.

S13-005 audit outcome (no code change needed):

- The Windows `powershell` tool receives exactly the same budget treatment as `bash`: an ordinary tool call that is never discovery, implementation, or validation, and neither shell takes the repository write guard.
  Shell write classification stays name-shaped and best-effort for both shells; do not special-case one shell without changing both.
- The pi 1.0.3 provider rename (`azure-openai-responses` to `azure`) does not affect this extension: model presets store opaque `provider/model[:level]` specs and never interpret provider names, so both tokens are valid specs.

S13-002 decisions (tool metadata, no runtime behavior change):

- All four tools declare `exposure: "direct"` explicitly, so they stay model-declared and callable through `ctx.executeTool()` and codemode scripts while they are active; a session that excludes a tool through `--tools` or settings excludes it from programmatic callers too.
  `codemode` and `deferred` would keep spawning reachable even when the model does not have the tool, and `model-only` would remove the programmatic path the structured result exists for.
- `annotations` are advisory, MCP-style hints for permission extensions and are never enforcement: `subagent` and `subagent_override` declare `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`; `subagent_stats` declares `readOnlyHint: true`, `idempotentHint: true`; `subagent_close` declares `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`; `openWorldHint` stays unset.
  No code path in this extension reads annotations.
- No tool declares a `namespace`, and `defaultActive` stays at its default: the four tools stay ungrouped and keep the current model-facing toolset.

S13-003 decisions (nested tool-call accounting):

- Calls a tool makes while it runs through `ctx.executeTool()` (ids shaped `<parent id>/<n>`, carrying `parentToolCallId`) consume the same per-role budgets as model-issued calls.
  Pi 1.0.3 routes them through the same `tool_call` and `tool_result` hooks, so enforcement stays in one surface and a codemode loop cannot bypass a budget; a refused nested call returns to the caller as an `isError: true` outcome and never spawns anything.
- Transcript-derived metrics (`ExecutionMetrics.nestedToolCalls`, shown as `nested:N` in run summaries and `subagent_stats`) count the bounded `nestedCalls` record each parent tool result carries.
  Each nested call is flattened into exactly one record (its top-level caller's), so the count never double counts, and a record with `complete: false` is treated as the lower bound it attests to.
  Nested usage needs no separate accounting: pi already folds it into the parent result message's `usage`.
- Transcript parsing never double counts nested calls as model-issued `toolCalls`, because nested calls produce no transcript tool-call entries.
- The transcript-derived count from the bounded `nestedCalls` records is the single nested-call surface: there is no hook-side registry nested counter, so the registry run summary and `nested:N` both derive their nested count from that one metric, and `BudgetUsage` keeps no separate nested counter, so there is no second number for a test to pin equal.

S13-004 decisions (agent finalization boundaries):

- Adopted on `turn_end`: once a run's turn ends without tool calls (the report turn), later wall-time breaches are recorded for telemetry but no longer steer or abort.
  Before this, a wall-time breach firing during or after the report turn queued a steer that bought a second, shorter report or relaunched a settled session; the report-turn handling in `turn_end` already knew this, but the wall timer did not.
  The gate is a per-run flag reset in `before_agent_start`, so it is bounded and cannot loop.
- `agent_before_settle` is deferred, verified against the pi 1.0.3 runtime: the settle boundary never runs after an abort (`_agentRunAbortRequested` breaks the loop before it), so it cannot improve the abort finalization path; completed runs always end on the report turn, so there is nothing to salvage; and error outcomes are already bounded by pi's auto-retry, so a continuation there would mostly buy a duplicate failure while delaying settlement.

## Codemode and tool_search policy (pi built-in extensions)

Pi 1.0.x ships two inactive-by-default built-in extensions: `codemode` (run JavaScript calling other tools in a QuickJS sandbox) and `tool_search` (rank undeclared tools and declare the matches for the next call).
Neither is part of any role's default allowlist unless the template names it.

- The worker template names `codemode`.
  A worker can use it to batch independent calls with `Promise.allSettled` and filter large output before it costs model context.
  S13-003 removed the old observability objection: calls a script makes route through the same tool hooks, consume the same role budgets, are refused at the limit like model-issued calls, and surface as `nested:N`.
  The body guidance in the template pins that discipline (`## Codemode discipline`).
- `codemode` stays out of the read-only roles (planner, scout, reviewer, validator): their evidence trail should stay individually visible and attributable in the transcript, not aggregated inside a script's return value.
- `tool_search` is deliberately excluded from every role allowlist.
  Each role's `tools:` frontmatter is an allowlist handed to the child through `--tools` (`buildLaunchCommand`), and self-activating undeclared tools would undermine exactly that; child sessions also have no deferred/codemode-exposure servers by default, so there is no payoff.
  If a future use case appears, adopt it deliberately for the minimal role set, not by default.

## Tests and checks

Install dependencies with `npm install`.
Run the normal quality gates with:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
```

`npm run format` formats the source, tests, and analysis TypeScript files.
It does not format this documentation folder.
Run focused Vitest files when iterating, then run the full suite before release.

`npm run test:analyze` reads the live agent stores and rewrites the generated `analysis/MEASUREMENT.md` report.
Do not edit that report manually.



## Packaging

The Pi manifest in `package.json` loads `./index.ts` as the extension.
The published package includes `index.ts`, `src/`, `README.md`, and this `docs/` folder.
The package expects a herdr-managed Pi session and the peer Pi packages supplied by the host.

When changing behavior, keep the generated agent templates and runtime enforcement aligned.
Rerun `/setup-subagents` after changing the role budgets or role guidance so installed agent files receive the current contract.
Do not manually maintain a second copy of the generated orchestration guide.
