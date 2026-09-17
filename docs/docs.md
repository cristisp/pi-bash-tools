# subagent-herdr documentation

This folder describes the current workflow implemented by the extension.
It covers setup, delegation, handoffs, persistent artifacts, validation evidence, and operations.

## Start here

- [Workflow](workflow.md) explains setup, tool modes, composition checks, launch, and completion.
- [Roles and handoffs](roles.md) explains tiers, role boundaries, the ledger contract, and remediation.
- [Artifacts](artifacts.md) explains what the extension creates, where it lives, and who consumes it.
- [Validation and evidence](evidence.md) explains `verify` references, ownership, freshness, and repository locking.
- [Operations](operations.md) explains reuse, steering, blocked sessions, model presets, budgets, and closing sessions.
- [Development](development.md) explains the extension lifecycle, telemetry, tests, and packaging.

## Workflow in one page

1. Run Pi inside a herdr pane.
2. Install or update the standard agent files with `/setup-subagents`, or provide compatible agent files in the configured agent directories.
3. Classify the work and choose the smallest safe workflow tier.
4. Discover an exact agent name with `subagent({"agents": true})` when needed.
5. Delegate with `subagent` using exactly one mode: single, parallel, chain, reuse, list, or agents.
6. Let the extension preflight composition rules, create the flow artifacts, and launch a child Pi session in a herdr tab.
7. The child receives a compact current handoff with ledger and read-manifest pointers, performs only its assigned work, and returns a structured report.
   Ordinary discovery does not preload the historical ledger or manifest; a named stale, rejected, ambiguous, or otherwise required evidence gap permits one bounded recovery attempt.
8. The parent receives a bounded digest and paths to durable artifacts, while the full report remains in the flow store and metrics remain in the registry and telemetry log.
9. The next role consumes the refreshed handoff together with the ledger, reports, review surface, and validation references instead of rebuilding context or repeating covered checks.
10. Reuse or remediate only when the workflow calls for it, then close the linked tabs when the user asks.

A documentation-only task is Tier 0 and does not require a subagent.

## Artifact flow

| Artifact | Created by | Consumed by |
| --- | --- | --- |
| Session JSONL | A fresh child launch | Reuse, stats, and the child Pi session |
| Registry | Every allocation, state change, and completed run | Listing, reuse, close, reconciliation, and diagnostics |
| Flow manifest | The first delegation in a flow | Flow liveness, participant tracking, and ledger revision numbering |
| Review surface | A scoped fan-out or delegation that needs a snapshot | Children through the read manifest |
| Read manifest | Each fresh launch or scoped reuse turn | The child, then the parent and diagnostics |
| Ledger | Every dispatch and result boundary | Later children, validators, reviewers, and telemetry correlation |
| Role report | A settled child with a flow id | The parent digest, later roles, and reviewers |
| Validation reference | The validation producer after a check | Sibling consumers and reviewers through lookup |
| Telemetry JSONL | Composition and delegation boundaries | Measurement and the S4 gate |

See [Artifacts](artifacts.md) for exact paths and read/write rules.

## Scope and source of truth

The extension is herdr-only and does nothing when the required herdr environment is absent.
The generated guide at `~/.pi/agent/agents/subagent_orchestration.md` is the workflow contract supplied to standard agents.
This repository documentation explains the contract but does not replace the generated guide or the runtime checks.
The README remains the concise installation and feature reference.
