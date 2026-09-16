# Development and maintenance

## Runtime architecture

`index.ts` is the entry point.
It guards registration to herdr, reconciles the registry, prunes old flows, registers commands, and installs child budget enforcement.

The main runtime is split into these concerns:

- `src/execute.ts` validates parameters, discovers agents, evaluates composition, and dispatches single, parallel, chain, or reuse modes.
- `src/run.ts` creates tabs, launches or prompts Pi, polls settlement, records outcomes, writes reports, and emits telemetry.
- `src/ui-prompt-marker.ts` writes and parses the session-tail UI prompt markers the poller uses to detect and settle-suppress approval waiting, and emits `herdr:blocked` events for the daemon.
- `src/delegation.ts` derives flow and delegation identity, sanitizes scope, and exports child environment variables.
- `src/flow.ts`, `src/ledger.ts`, `src/manifest.ts`, and `src/scope.ts` own durable flow artifacts.
- `src/registry.ts` and `src/registry-store.ts` own workspace-scoped session state and locking.
- `src/budget.ts` enforces child budgets, role permissions, and repository write exclusion.
- `src/report.ts`, `src/format.ts`, and `src/metrics.ts` reduce child output and collect run summaries.
- `src/telemetry.ts` writes delegation, composition, and S4 records for analysis.
- `src/commands.ts`, `src/presets.ts`, and `src/templates.ts` provide setup, model selection, and standard role contracts.

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

`npm run s4:gate -- <agent-dir> [options]` evaluates the composition evidence gate.
It produces a decision artifact and exits successfully only for `ENFORCE_CANDIDATE`.
The decision does not change the configured composition policy.

## Packaging

The Pi manifest in `package.json` loads `./index.ts` as the extension.
The published package includes `index.ts`, `src/`, `README.md`, and this `docs/` folder.
The package expects a herdr-managed Pi session and the peer Pi packages supplied by the host.

When changing behavior, keep the generated agent templates and runtime enforcement aligned.
Rerun `/setup-subagents` after changing the role budgets or role guidance so installed agent files receive the current contract.
Do not manually maintain a second copy of the generated orchestration guide.
