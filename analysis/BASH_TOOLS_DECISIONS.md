# Current consumer decisions and discoveries

This file is intentionally short.
Completed producer design debates and historical measurement arguments are no longer kept here.

## F7 coordination boundary

The released `@ztc/bash-tools` 1.0.2 producer performs single-flight coordination within one producer process.
Its module-level in-flight registry is not shared by separate Pi or child-session processes.

Flow publication is a completed-evidence transport mechanism.
It does not provide an active cross-process execution lock or single-flight lease.

The consumer therefore does not interpret identical refs as proof of shared execution.
The producer's `concurrentExecutions` value is process-local, and a flow containing four separate producer processes may legitimately record four misses and four executions for one digest.

Cross-process single-flight is not part of the current release.
If required later, it needs a separate durable coordination design with an atomic claim, owner recovery, expiry, and crash handling.

## Repository safety decision

Keep the consumer-owned repository write lock.
Process-local single-flight does not serialize mutating commands across processes, and flow publication does not protect a shared working tree from concurrent writers.

## Digest boundary

The producer-state digest covers paths reported by Git and includes content, mode, size, and status.
Ignored paths are excluded.

The F8 probe initially treated ignored `PLAN.md` as a tracked dirty file and raised a false defect.
A tracked modified `README.md` changed the digest, including for a same-size edit, and restoring its bytes restored the previous digest.
The surviving discovery is the `.gitignore` boundary, not content insensitivity.

## Current consumer decisions

No consumer code should add cross-process single-flight based on the final probe.
The consumer metrics correctly preserve producer execution counts, flow provenance, cache decisions, drift, and concurrency fields.

S4 remains in `warn` mode.
The initial live probe produced four typed warnings, one for each R1-R4 rule, and zero policy refusals, but every event used an explicit per-call `warn` override.
A later clean window, flow `fcb7b5447b11b875a` with cutoff `1788908340848`, recorded four delegations, two default-policy warnings (R1 and R4), zero refusals, and no per-call overrides.
R3 was exercised compliantly with session evidence, and R2 was intentionally omitted because its overlap safety boundary is already confirmed.
The clean window resolves the default-policy provenance gap but is too small and incomplete to justify `enforce`.
The four quality guardrails remain unmeasured: unresolved or abandoned tasks, post-PASS regressions, escalation by tier, and Tier 1 worker discovery failures.
