# Subagent orchestration plan (v2): enforce, do not instruct

## Purpose

This plan defines the next phase of the `subagent-herdr` orchestration pipeline.

Plan v1 proposed instruction and workflow changes to reduce over-delegation, repeated context acquisition, duplicated validation, oversized handoffs, and remediation loops. Those changes shipped into `~/.pi/agent/SUBAGENTS_GUIDE.md`, the five agent definitions generated from `src/templates.ts`, and the `subagent` tool descriptions.

Plan v2 exists because a 334-session measurement window showed that the instruction layer did not change agent behavior where it mattered. Cost is now dominated by context re-feeding, and the mandates that were written as prose are the mandates that were ignored.

The thesis of v2: move enforcement out of prose and into tools, and stop paying per-agent for repository state.

## Provenance

Source data: `~/work/git/log-analysis/analysis-0903-full.md` (companion to `analysis-0903.md` and `analysis-0903.json`).

Window: 2026-08-26 to 2026-09-02, 334 sessions (38 roots, 296 children), 10,064 model steps, 14,139 tool calls, 1,393 tool errors, $44.92 computed cost.

Plan v1 stated that extension work should begin only after the instruction-only workflow had been dogfooded and its missing automation understood. That condition is now met: the window above is the dogfood readout, and it identifies which mandates need an enforcement point.

## Baseline measurements that drive this plan

| Signal | Measured | Target workstream |
| --- | --- | --- |
| Tool-result tokens per model step | 68,134 cache-read tokens re-read per step; 27.9M fresh input tokens for the entire window | All |
| `git_diff` output volume | 4,279,168 tokens from 547 calls, avg 7,823; p95 49,847; max 99,330; 22.6% of all tool-result text from 3.9% of calls | W5 |
| Sibling diff storm | One root (`pi-01a048f0`) fanned out ~20 children, each re-pulling the same working diff at 52K-99K tokens; ~1.42M tokens | W5 |
| Validation churn | `project_command` 2,163 calls, 1,075 exact-duplicate excess (49.7% of its calls, 69.1% of all duplicates); single sessions ran 34 identical lint and 25 test calls; `force:true` used to defeat the result cache | W4, W7 |
| Delegation result size | `subagent` results avg 1,821 tokens, p99 6,099, re-read by every later root step | W2, W3 |
| Root vs child cost | 38 roots carry $27.85 ($0.733 each); 296 children carry $17.07 ($0.058 each); children are 64.2% of steps but 38.0% of cost | W2, W3 |
| Role mix | worker 84, reviewer 71, validator 70, planner 39, scout 24; 49.0% of assignments produce no code change | W7 |
| Budget compliance | Documented limits are 24 worker calls and 12 reviewer inspections; observed child sessions ran 240, 260 and 204 tool calls | W4 |
| Per-child context reconstruction | 1,279 intra-session excess reads (26% of reads); `PLAN.md` read 94 times across 29 sessions | W6 |
| Mandatory guide read | `SUBAGENTS_GUIDE.md` ~5,415 tokens per read, 28 reads across only 7 sessions | W8 |
| Serial tool loops | 1.41 calls per model step; 1.62 results per tool-producing step | W6, W8 |
| Mechanical dead ends | ~898 of 1,393 errors (6.4% of all calls) are tool-interface friction, not real failures | Out of scope (W7 dependency) |

How to read these numbers: dollar attribution in the window is not reliable enough to rank work by itself (2.3x computed-vs-reported divergence, 7.1% of steps with no computed cost, partially populated fresh-input column). Rank by steps and tokens; treat cost as a tiebreaker.

## Disposition of plan v1

Everything below v1's "Follow-up implementation batch" was shipped into the guide, the agent templates, or both. It is listed here so it is not re-litigated.

| Plan v1 item | Outcome | Where it lives now |
| --- | --- | --- |
| WS1 risk rubric, Tier 0-4, escalation triggers | Done | `SUBAGENTS_GUIDE.md`: Workflow classification, Behavior risk / Architecture uncertainty / Validation complexity, Workflow tiers, Escalation triggers |
| WS2 canonical ledger + independent state vocabulary | Done as prose, not persisted | Guide: Canonical orchestration ledger; `src/templates.ts` ledger block with `workflow_version`, `attempt`, `budget`, verdict states |
| WS3 scout contract (evidence refs, hashes, reread guidance, stop rule) | Done | `src/templates.ts`: path/range/symbol/hash listing, "Do not copy complete functions", "Files that do not need rereading unless changed", `SCOUT_BUDGET` |
| WS4 gap-driven planner | Done | `src/templates.ts`: "Record each additional read or query with the evidence gap it resolves", `PLANNER_BUDGET` |
| WS5 worker vs validator validation ownership | Partially done; no enforcement, no shared evidence store | Guide: "Leave authoritative final validation to the validator"; `WORKER_BUDGET` two full validation passes |
| WS6 validator status vocabulary | Done | Guide and `src/templates.ts`: `PASS`, `FAIL`, `BLOCKED`, `BASELINE_FAILURE`, `NOT_RUN`; `SKIPPED` removed |
| WS7 stable reviewer finding IDs | Done | Guide: reviewers assign `F-###` at creation; finding record template |
| WS8 evidence-driven remediation and stop conditions | Done | Guide: Remediation workflow; `REMEDIATION_DISCIPLINE` in `src/templates.ts` |
| WS9 per-role budgets and compaction transition | Done as prose only; exceeded 10x-20x | Guide: Role budgets and compaction; five `*_BUDGET` blocks in `src/templates.ts`; re-raised as W4 |
| WS10 remove duplicated global policy from agent files | Done | `src/templates.ts` composes shared blocks (`*_BUDGET`, `REMEDIATION_DISCIPLINE`, `TEST_REVIEW_GUIDANCE`, ledger) |
| WS11 instrumentation and evaluation | Not done; metrics are in-memory only | `ExecutionMetrics` computed at delivery in `src/run.ts`, never persisted; re-raised as W1 |
| Proposed first implementation batch (instructions only) | Shipped | - |
| Recommended implementation sequence 1-12 | Steps 1-10 done, 11 partially, 12 is this plan | - |

### Carried forward from v1, unchanged

These survive because the cost analysis cannot speak to them. The window measured spend, not correctness, so they are the only guardrail against this plan being implemented as a pure cost cut.

1. **The over-restriction watchlist.** After reducing role count and handoff size, actively watch for: more unresolved tasks, workers missing architecture risk without a scout, reviewers lacking independent evidence, and excessive escalation into Tier 3.
2. **Quality metrics, not just cost metrics.** Successful completion rate, time to final approval, findings by primary vs focused reviewers, remediation attempts per finding family, escalations for clarification, and regressions discovered after approval.
3. **Lower delegation count is never by itself success.** Any W that reduces delegation must be evaluated against 1 and 2 before it is considered done.
4. **Design principles still load-bearing:** use the smallest workflow that preserves required independence and safety; pass references and hashes instead of copying content; inspect only gaps; stop loops when evidence stops improving; keep delegation status, validation verdict and review verdict independent.

Principles from v1 not repeated here are not abandoned; they are implemented, so they no longer belong in a plan.

## Ownership boundary

The analysis spans three codebases. This plan only commits work in this repository, and says explicitly where it waits on another.

| Analysis recommendation | Owner | This repo's role |
| --- | --- | --- |
| `git_diff` default cap, `--stat` first, per-file hunk fetch, shared diff snapshot | `bash-tools` (`src/tools/project-command/`) | W5 consumes whatever cap exists; pre-digest works without it |
| `verify` composite with fingerprint cache, boolean coercion, colon identifiers, enum echo | `bash-tools` | W7 wires roles to it and removes duplicate validator delegation |
| `read_batch`, read ETag semantics, `edit` failure payload, resolution and policy error payloads, `git_log`/`git_status` contracts, read-only probe tool | `bash-tools` | None; W6 and W8 reduce the need for some of it |
| Budget enforcement, capped reports, ledger state, disjoint scopes, read manifests, delegation identity, telemetry | **this repo** | All of W1-W6, W8 |
| Path normalization, cache-write and compaction fields, retry-chain detection, per-role rates, stable delegation id join | `log-analysis` | W1 produces the join key and the per-role record it needs |

## Flow store and identity contract

The measured diff storm and the validation churn are structural, not behavioral. `bash-tools` keeps its command result cache in a process-local `Map` keyed by Pi session id, documented in its own source as "deliberately process-local, session-scoped ... no restore or persistence path" (`bash-tools/src/tools/project-command/cache.ts`). N fan-out children are N Pi processes with N caches, so a byte-identical working tree is re-diffed and re-linted per child no matter what the instructions say.

Boundary decision, deliberate: this extension owns orchestration identity, flow lifecycle and garbage collection of orchestration artifacts; each producer owns its own store root, its namespace, and its invalidation semantics. This extension does not own a shared tool-result cache, and producers do not write into our directory.

Why not one orchestration-owned cache:

- Dependency direction. `bash-tools` serves `read`, `edit`, `git_diff` and `project_command` everywhere; this extension registers nothing outside a herdr-managed session (`index.ts` env guard). A general toolset cannot depend on an orchestration extension that may not be loaded.
- Invalidation knowledge belongs to the producer. `bash-tools` computes before and after state snapshots, result fingerprints, and staleness-driven invalidation; relocating storage would either move that correctness-critical logic or leak correctness across the boundary.
- A transparently shared cache erases role independence, the property the whole protocol rests on. The guide states a matching fingerprint is evidence reuse, not approval. Scope is therefore set by the spawner through the environment (D4), so a validator child physically cannot inherit a worker result unless its tier grants it.
- Per-parent-session is the wrong key. A lint result is shareable whenever repo identity, HEAD, dirty digest and the logical request match, sometimes across sessions; entries are content-addressed and visibility scope is layered on top.

Identity export (our side of the contract), added to `buildLaunchCommand` (`src/run.ts:56`), set only in child processes we spawn and never in the main session:

| Variable | Meaning |
| --- | --- |
| `PI_ORCHESTRATION_FLOW` | Flow id, shared by every child of one root session, stable across its delegations and remediation attempts |
| `PI_DELEGATION_ID` | One uuid per delegation, carried across reuse turns of the same session |
| `PI_ORCHESTRATION_ROLE` | Agent name, for telemetry attribution only |
| `PI_ORCHESTRATION_EVIDENCE_SCOPE` | `session` or `flow`, per D4: the widest evidence scope this child may use; a call parameter may narrow it, never widen it |
| `PI_ORCHESTRATION_TIER` / `PI_ORCHESTRATION_MODE` | Workflow tier and `initial` / `remediation`, informational |
| `PI_ORCHESTRATION_REVIEW_MODE` | `primary` / `security` / `validation` / `remediation`, informational |
| `PI_ORCHESTRATION_CRITERIA` | Acceptance-criterion ids the delegation must satisfy, comma-separated |

Absence of these variables means "no flow", and consumers must behave exactly as they do today.

The environment is fixed at child-process launch. A reuse turn that prompts a still-live session cannot mutate that child's env, so `tier` and `workflowMode` changes on a reuse turn are recorded in the registry and telemetry only. Consumers keying caches on these values must treat the launch-time identity as immutable for the life of the child.

Flow artifact layout, one directory per flow, garbage-collected with registry reconciliation. Only orchestration artifacts live here:

```text
~/.pi/agent/subagent-herdr/flows/<flowId>/
  flow.json                 manifest: root session, participants, created/last-used, retention
  ledger.md                 W3 canonical ledger, parent-written only
  reports/<label>-<seq>.md  W2 full role reports, the only child-writable artifact
  predigest/                W5 diff and scope snapshots
```

Consumers keep their own store roots (D3) and use `PI_ORCHESTRATION_FLOW` as a scope key only. `flow.json` is offered as an optional liveness signal and must never be a required input, because retention needs differ: orchestration artifacts die with the flow, caches age out by TTL and size.

What we provide for reuse rather than reimplementing: the path convention, the lock pattern with stale-lock stealing (`src/registry-store.ts` as the reference implementation), and corruption-tolerant reads. Producer entries carry provenance (producing session, role, invocation id, snapshot digest) because cached command output is untrusted text that another role will later read.

Requirements for consumers, written for handoff outside this repo: `docs/handoffs/bash-tools-flow-cache-requirements.md`. `bash-tools` work is tracked there, not as a workstream in this plan.

## Sequencing rule: schema before prose

Do not rewrite the guide or the agent templates to reference a parameter, tool, or field that does not exist yet.

That is the exact failure mode the window measured: mandates with no enforcement point were exceeded by an order of magnitude, and 130 `project_command` calls were schema tax against instructions the agents were already trying to follow.

For every workstream: land the schema and the registry/telemetry field, verify it in a real delegation, then update `src/orchestration-guide.md` and `src/templates.ts` in the same change, and regenerate the installed agent files and the guide with `/setup-subagents`. Guide text and agent prompts are both repo-owned now, so a guidance change is an ordinary reviewed commit instead of an edit to machine-global config.

## Workstream 1: delegation identity and telemetry spine

Evidence: 296 children against 285 successful delegation links, so child cost is not attributable to a parent call. `ExecutionMetrics` (`src/types.ts`) already computes `toolCalls`, `failedToolCalls`, `repeatedReads`, `messageCount`, and `maxContextTokens` at delivery time in `recordExecutionMetrics` (`src/run.ts`), then throws them away except for the TUI line in `src/format.ts`.

Changes:

- [x] Allocate a stable `delegationId` (uuid) per spawn in `createFreshSubagentTab` (`src/run.ts`), carried on reuse turns of the same session, stored on `RegistryEntry` (`src/types.ts`) and echoed on `SingleResult`. (`SubagentDetails` carries it only through `results[]`.)
- [x] Export the flow identity into the child environment in `buildLaunchCommand` (`src/run.ts`), and record `flowId` on the registry entry. This slice ships first and on its own, because `bash-tools` work is planned against it.
- [~] Record the delegating context on the entry: workflow tier, workflow mode, review mode, and acceptance criteria are recorded when supplied; `parentSession` already existed. Still missing: parent pane and the explicit root session file (the flow manifest holds the root session today).
- [x] Append a per-delegation telemetry record at delivery to a JSONL store next to the registry: delegation id, flow id, label, workspace, agent, role, model, tier, mode, evidence scope, reuse count, outcome (`settled` / `failed` / `aborted`), exit code, stop reason, usage totals, and the full `ExecutionMetrics` including turns and blocked spans. The fields held back for later workstreams all landed since: `steered`, the budget outcome, `reportTokens` with the report path, and the `metrics.validationRefs` refs from W7.
- [x] Add the recorded telemetry to `subagent_stats` (and the verbose listing) through `lastRun` on the registry entry, so reuse decisions see spend, not only context size.
- [x] Show `delegationId` and tier in the call and result renderers (`src/render.ts`) so a human can tie a tab to a ledger entry.
       -> the result header carries `delegation:` and `tier:`; the call line carries `tier:`, `task:`, and `mode:`.
- [x] Document the store format for the analyzer: `analysis/TELEMETRY_SCHEMA.md` states the record shape, the flow layout, and the queries; the README documents the env contract.
- [x] Make registry writes immune to concurrent sessions: each write goes through its own uniquely named temp file, so two sessions settling at the same moment can no longer lose a row through a shared `.tmp`. Found from a reviewer row that finalized without `lastRun`.

Implementation notes against the text above, so the next reader does not trust it blindly:

- Paths live in `src/flow.ts` and `src/telemetry.ts`; `src/registry-store.ts` exports the generic `withFileLock` the two reuse, and the telemetry log takes its own lock file rather than the registry lock.
- Telemetry is written in the `finally` of `runSingleAgent` / `runReusedAgent`, after `recordExecutionMetrics`, so failures and aborts are recorded too. It never throws.
- Blocked spans are now measured, not only detected: `clearBlockedState` (`src/poll.ts`) accumulates `approvalMs` and `steerMs` into the result, which `recordExecutionMetrics` copies into `ExecutionMetrics` and the renderer and stats surfaces use.
- `evidenceScopeByRole` defaults `validator` to `session` scope, which is the enforcement side of D4 and keeps a validator from reusing the evidence it is meant to audit independently.

### Live verification against the released 1.5.0

Verified in a real delegation from a root session, not with fakes:

- The root session carried none of the variables (own `environment` read returned null for all four probed names), while a `worker` child saw all eight with correct values, plus the unchanged `PI_SUBAGENT_NESTED=1`.
- D4 held in production: a `validator` delegation spawned with `evidenceScope: "flow"` recorded `evidenceScope: "session"`, so the widening attempt against the role policy was refused.
- `flow.json` held the root session path, both participants, and a `lastUsedAt` within 2 ms of the matching telemetry `at`. Telemetry emitted one record per delegation turn, including the reuse turn, with `outcome`, usage, cost, `metrics.turns`, and block spans.
- Reuse works end to end: a second turn in the same child session produced its own record with `reused: true`.

Two defects this run caught, both fixed:

- `reuseCount` was emitted pre-increment, so a first reuse turn logged `reused: true` with `reuseCount: 0`. It now reads the registry value after accounting, and a test pins telemetry to the registry.
- The `acceptanceCriteria` description used `["F-001","F-002"]` as its example, teaching callers to pass finding ids where the ledger contract wants `AC-###`. The live env dump showed exactly that mistake being made. Example corrected to `["AC-001","AC-002"]`.

Second observation for W3: a reuse turn cannot change the child's environment, so a child prompted with a new `tier` or `workflowMode` never learns it. Per-turn orchestration context must arrive through the ledger (W3), not through the environment.

### Re-verification after the two fixes

With the extension linked to the workspace, the same telemetry file holds both sides of the fix. Records from the pre-fix run logged `reused: true` with `reuseCount: 0`; the post-fix run logged `reused: false, reuseCount: 0` for the fresh turn and `reused: true, reuseCount: 1` for the first reuse of the same session, so the invariant holds. During a later reuse turn the registry read `reuseCount: 2` while the newest *completed* record still said `1`; that is timing, not drift - `recordTask` accounts the in-flight turn before the child can observe the registry, and telemetry is written at turn end. `PI_ORCHESTRATION_CRITERIA` round-tripped as `AC-001,AC-002` in both the child environment and the record.

The flow id survived a reload (`f85f194e1b61c28e3`) because the root session file did not change, which is the intended semantics: a flow is scoped to the root session, not to a process. Label counters persisted while dead tabs were reconciled away, so a resumed session continues allocating new labels rather than reusing recycled ones.

Acceptance:

- [x] Every child session joins to exactly one delegation id. The record side is verified live (`delegationId` + `sessionFile` + `parentSession` on every telemetry record); closing the 296 vs 285 gap itself is `log-analysis` work.
- [x] `subagent` cost by role and tier is answerable from the JSONL without parsing transcripts (`role`, `tier`, `usage.cost`, `metrics` on each record).
- [x] Telemetry write failure never fails a delegation (covered by tests).

Dependencies: none. This is the first thing to land because every later workstream is judged by it.

## Workstream 2: bounded structured child reports `code landed, live-verified`

Evidence: `subagent` results average 1,821 tokens with a p99 of 6,099, and each one is re-fed on every later root step. Roots carry $27.85 of $44.92 for exactly this reason.

Changes:

- [x] Define a child report contract with a hard token budget (start at 800 tokens): `delegation_status`, `validation_verdict`, `review_verdict`, per-`AC-###` status, changed files, `V-###` references, `F-###` findings with severity and blocking flag, risks, escalation request, and compact budget usage.
      -> the ledger shape already existed in the shared preamble of `src/templates.ts`; W2 builds on
         it instead of inventing a second contract. Digest budget is `reportDigestTokens`, default
         600, not 800: the ledger block plus its status lines is the payload, and 600 leaves room
         for a short summary
- [x] Write the full role report to disk per delegation and return the digest plus the absolute
      report path; the root never receives prose it will re-read.
      -> `src/report.ts`: `writeRoleReport()` stores the full text under the flow's `reports/`,
         `buildReportDigest()` builds what the parent receives. Files are `<label>-<timestamp>.md`
         because one session produces several reports across reuse turns
- [x] Generalize `perTaskOutputCap` (`src/config.ts`) from a parallel-only byte clamp into a cap
      applied to single, parallel, chain, and reuse paths, and make truncation explicit rather than
      silent byte slicing.
      -> `applyOutputByteCap()` in `src/format.ts` now runs on every delivery path, and
         `buildReportDigest` ends with a `Digest truncated: <kept> of <total> tokens ... Read the
         full report: <path>` marker instead of cutting silently. The config key keeps its name to
         avoid breaking existing configs; it is a byte backstop, the token budget is separate
- [x] Add the cap and the report path to `subagent_stats` and the run summary so an over-budget
      report is visible at delivery time. `lastRun` carries `reportTokens` and the `ReportSummary`,
         `subagent_stats` prints `report:<digest>/<full>[:no-ledger]`, and the delivered text itself
         carries `[full report: <path>]` so the TUI shows it without renderer changes
- [x] Detect and surface a missing ledger block. `reportContractPolicy` (`flag` default, `reject`)
      controls whether the parent is told this is a contract failure to act on or merely a note;
      a non-parsing report never fails the delegation itself

Measurement note: token counts use the `chars / 4` estimate throughout, because the harness reports
no per-message token totals. Estimates are comparable across delegations but are not billing
numbers, so the baseline comparison below must be measured with the same estimator.

Acceptance:

- [x] Median `subagent` result tokens drops below 900 while `subagent_stats` shows the full report
      still retrievable on disk. The current post-cutoff sample is 15 results with a 472-token p50,
      and the post-reload live sample persisted its full report path.
- [x] No role can signal approval by prose; verdicts come from the ledger fields, and a report
      without them is flagged at delivery
- [x] Existing steering, blocked detection, and abort semantics are unchanged - 432 tests pass,
      including all pre-existing poll, render and execute suites

Live verification (2026-09-03, pre-D7 cap baseline, two real delegations in one flow):

| Child | Full report | Digest delivered | Ledger | Reduction |
|---|---|---|---|---|
| `worker-4` (ledger emitted) | ~3,939 tokens | ~551 | parsed | 86% |
| `worker-3` (prose only, deliberate) | ~3,016 tokens | ~551 | **not** parsed | 82% |

Both full texts are on disk under `reports/` with identity headers (flow, delegation, role,
evidence scope, tier, mode, criteria, `completedAt`, estimated tokens). Telemetry carried
`report.{tokens,digestTokens,truncated,ledgerParsed,path}` for both, and the delivered text ended
with `[full report: <absolute path>]`. The deliberate no-ledger child produced
`[Report contract: no ledger block parsed from ~3016 tokens of report.]` instead of a silent pass.

Two defects the live run caught and unit tests had missed:

1. `lastRun.report` in the registry carried the **digest text**, because `RoleReport extends
   ReportSummary` and structural typing let the extra field through. The registry is read on every
   delegation, so W2 would have moved the cost rather than removed it. `buildRunSummary` now
   reconstructs a counts-and-path summary; covered by a `buildRunSummary` test that asserts the
   stored shape with `toEqual`.
2. The contract note fired on a two-word reuse-turn acknowledgement, costing a line per short turn.
   Reports under 64 estimated tokens are treated as acknowledgements; `ledgerParsed: false` is still
   recorded in telemetry, so measurement keeps the full picture.
3. `lastResult` stored the child's **entire** final message in the registry - a 2,625-token report
   for a field two consumers display as 120 and 4,000 characters. Same defect class as (1), older
   than W2, and larger: the registry is rewritten and re-read by every delegation in every
   workspace. Bounding it to 1,000 characters was the wrong fix - the right one was to delete the
   field, since for a settled turn it is strictly a worse copy of the report file. `lastResult` is
   now `lastError`, written only for failed turns (bounded to 500 characters), because that is the
   one diagnosis with no file behind it: `attachRoleReport` skips failures, so a child that died
   before its first message leaves nothing on disk. Verbose listing prints `error: <msg>` or
   `report: <path>`; `subagent_stats` prints `last error:` or `last report: <path>`. Stale
   `lastResult` keys on existing entries are unread and vanish as entries close. A field whose only
   unique content is "less than the file it points at" should not exist.

All three were found by reading the stores after a real run, not by tests. That is the argument for
W1 existing: the stores are now inspectable, so the difference between "shipped" and "working" is
one `read` away.

The pre-shrink D7 observation was that both digests landed at ~551 of the 600-token budget, i.e. the
budget was the binding constraint, not the size of the signal.
W3 now moves flow state into a ledger pointer and Slice D has completed the separate read measurement
and cap decision.
The latest post-reload smoke digest is 364 tokens for a 944-token full report, with the ledger parsed
and the full report path persisted.

Compliance data point, second reload. A `worker` was asked for a note explaining what the registry
persists and why report prose does not belong in it, ending with a ledger block. It produced 1,184
tokens that correctly restate the contract, including the five reasons for keeping prose out of the
registry, and omitted the ledger block: `ledgerParsed: false`, contract note delivered, full prose on
disk. Third omission in three attempts, second where the role file and the task both stated it. The
model can recite the rule and still skip the artifact, which is the cleanest argument in this whole
exercise that W4's enforcement point matters more than any further prose in `src/templates.ts`. The
default stays `flag`; `reject` becomes the default only when the template text and the parser share
one source (W8), so the mandate cannot be phrased differently from what is checked.

Verified live on the same run: a fresh entry carries no `lastResult`, no `lastError`, and
`lastRun.report` holds only counts plus the path; the verbose listing prints
`report: <absolute path>` for sessions with a report and `report: none` for a session whose last turn
predates W2. The failure path (`error: <msg>`) is covered only by unit tests - a child that fails is
not cheaply reproducible on demand.

Dependencies: none. Independent of W1 but shares the telemetry fields.

## Workstream 3: ledger as tool state with reference handoffs `slices A-D landed, live-verified`

Evidence: the guide requires the main session to pass the full ledger plus all prior role reports at
every handoff, so root context grows monotonically with the tier depth. Tier 3 pushes scout, planner,
worker, and validator reports through the root. The harness adds the size of the prize: 4,240,977
carry token-times per delegating root, and delivered text is re-read roughly 157 times before the
owning session ends, so anything the parent pastes is charged ~157 times, not once.

Decided shape: **no new tool and no child write path.** D5 covers handoff, D6 covers ownership.

Enforcement note from implementation: "no child write path" cannot be a tool-allowlist rule, because
`worker` legitimately holds `write` and `edit`. It is enforced with a file mode instead - `ledger.md`
is mode `0400`, so a child writing to its own verdict record gets `EACCES` - and monotonicity is
independent of the file, because revision numbers continue from `lastLedgerRevision` in `flow.json`.
A torn trailing header is dropped as an uncommitted revision; a truncated file cannot reuse a number.

Changes, in slice order, because "schema before prose" is the rule this plan exists to enforce:

Slice A - the ledger store:

- [x] Add `src/ledger.ts`: `flows/<flowId>/ledger.md`, an append-only sequence of machine-readable
      revisions with a monotonic revision number, written through the existing store lock
      (`src/registry-store.ts`) and degrading silently when unwritable, exactly like `flow.json` and
      `reports/`.
- [x] Move the ledger field list out of prose (`src/templates.ts` preamble) into code, one source of
      truth that emits both the parse target and the instruction text. This is also W8's mechanism:
      W3 builds it, W8 extends it to the budget blocks.
- [x] Write a revision at each delegation boundary: at start (task, criteria, tier, mode, role,
      evidence scope, attempt, label, reuse) and at delivery (outcome plus the child's parsed ledger
      fields and the report path). The child's ledger block is the input to the fold, which is why it
      stays mandatory.

Slice B - identity and pointer plumbing:

- [x] Add `taskId` to `SubagentParams` (`src/execute.ts`); derive `attempt` from the ledger, never
      from the model, so the number cannot drift from reality. `taskId` is also exported to the child
      as `PI_ORCHESTRATION_TASK`.
- [x] On a fresh launch, the appended system prompt carries a ~50-token pointer block: absolute path,
      current revision, and an instruction to read it with the `read` tool before working. Pointer, not
      body (D5), through the existing `--append-system-prompt` file mechanism in `buildLaunchCommand`
      (`src/run.ts:75-96`).
- [x] On a reuse turn, prepend one line `ledger: <path>@<revision>` to the task text whenever the
      revision has advanced past the one the child was launched with. This guard is load-bearing: the
      appended system prompt is frozen at launch and tmp prompt files are deleted in the `finally` of
      launch (`src/run.ts:758-760`), while `runReusedAgent` (`src/run.ts:774`) writes a new prompt file
      only when it relaunches a dead session. A live reuse turn cannot receive a new prefix.
- [x] Record `ledgerRevision` and whether a pointer was injected in W1 telemetry, so "did the child get
      its state" is answerable without parsing transcripts.

Slice C - prose, only after A and B ship:

- [x] Replace "the task includes the ledger" with "read the ledger at the pointer you were given" in
      the role prompts, keeping the child's own ledger block mandatory because it feeds the fold.
- [x] Guide trimming belongs to W8, not here. Done there: the trim landed with `src/orchestration-guide.md` as the source and a standing size assertion.

Slice D - the digest shrink (D7), separate commit with its own measurement:

- [x] Extend the harness to count root reads of `flows/*/reports/*.md` **before** changing any default.
      The baseline recorded 4 root report reads, all at or after the cutoff.
- [x] Drop `reportDigestTokens` default 600 to 250, always keeping the ledger block and status lines.
      The first post-reload smoke produced a 364-token digest from a 944-token full report; the
      preserved ledger block remains intact even when it pushes the total above the nominal budget.
- [x] Revert on evidence: if root reads of report files rise materially, restore the cap.
      Root report reads remained at 4 after the reload, so the cap was retained. Superseded reading
      from the 2026-09-05 analyzer run: 46 post-cutoff root report reads against 81 delivered
      results, about 0.57 per result. The absolute count stopped being a usable threshold, so the
      revert check now needs a rate per delivered result, and post-cutoff `carry per root` has also
      risen to 7.6M token-times across 3 delegating roots.

Acceptance:

- [~] Root context no longer grows by the full ledger size at each handoff, measured as per-delegation
  root tokens in W1 telemetry, not asserted. Pointer injection and bounded delivery are live-verified,
  and the analyzer now records delivered result sizes, carry, and root report reads; a dedicated
  ledger-versus-inline root-token comparison is still an evaluation gap.
- [x] A child can determine the current task, criteria, scope, and prior verdicts without the parent
  pasting them.
- [x] No child session can write the ledger; verdict fields change only through the parent tool path (D1).
  Enforced by the `0400` file mode plus a test that the inspect-only roles have no mutating tools and
  no role exposes the delegation tools, rather than by an allowlist that would have to disarm `worker`.
- [x] Ledger revisions are monotonic and auditable across remediation attempts. Held by unit tests over
  torn and truncated files; `flow.json` carries the high-water mark.
- [x] The stale-pointer guard is proven live on a session with `reuseCount >= 1`, not only in a unit test.

### Live verification after reload (2026-09-03)

Verified in a real fresh delegation and a reuse turn in flow `f85f194e1b61c28e3`.

- Fresh `worker-6` read the ledger from the injected pointer before substantive work and observed task `W3-LIVE`, attempt 1, tier 1, criteria `AC-301,AC-302,AC-303`, and flow scope.
- The child's single write attempt against `ledger.md` returned `EACCES`, and a follow-up read confirmed that the ledger was unchanged.
- The extension wrote dispatch revision 1 and result revision 2, including the report path and the child's `PASS` verdict fields.
- Reusing the same child wrote dispatch revision 3 with `reused: true`, injected `ledger.md@3` into the task text, and the child read the prior result from the ledger rather than relying on task text.
- The reuse result was written as revision 4, and `flow.json.lastLedgerRevision` advanced to 4.
- Telemetry recorded both turns with the expected ledger revisions and injection routes: `prefix` for the fresh launch and `turn` for the reuse turn.

This closes the live verification for the W3 pointer handoff, reuse revision, parent-only ledger write, and monotonic revision criteria.

### Slice D live verification after reload (2026-09-03)

The measurement harness ran before the default change and recorded 4 root report reads, all at or after the cutoff.
After reloading the latest code, fresh `worker-8` produced a 944-token full report and a 364-token truncated digest with `ledgerParsed: true`.
The full report path was persisted under the flow reports directory, and the preserved ledger block was returned in the digest.
A second analyzer run still recorded 4 root report reads, so the lower cap did not cause report-read amplification in the observed sample.
The 364-token total is above the nominal 250-token prose budget because the ledger block is preserved verbatim and can consume more than the remaining budget.

Dependencies: W1 for the id. Slice D's read measurement and cap decision are complete. The guide
rewrite stays in W8.

## Workstream 4: the budget enforcement point

Evidence: documented limits of 24 worker calls and 12 reviewer inspections were exceeded by sessions running 240, 260, and 204 tool calls. One session issued 34 identical lint calls and 25 test calls, some with `force:true` specifically to defeat the result cache. v1 wrote budgets as prose; prose has no enforcement point.

Changes:

- [x] Add `roleBudgets` to `src/config.ts`, keyed by agent name, with per-role limits for tool calls, discovery/inspection calls, full validation passes, failed calls, repeated reads of the same file, output tokens, and wall time.
- [x] Count live, not at delivery. `pollSubagent` (`src/poll.ts`) already reads every new session message through `createSessionTailReader` and `processSessionMessage`, and already tracks `pendingToolCalls`; accumulate budget counters there, and extract the counting rules from `recordExecutionMetrics` so live and final numbers cannot diverge.
- [x] On breach, inject one steer through the existing steer path naming the exact exhausted budget and the required action ("budget exhausted: emit the ledger and the role report now, then stop"), mark the registry entry, and surface it in `subagent_stats`, the listing, and the renderers.
- [x] Apply D2 after that steer: refuse further non-report tool calls so the child can only finish its ledger contribution and role report. `budgetPolicy: "abort"` stays a per-role config option.
- [x] Report the budget outcome in W1 telemetry so limits get tuned from data instead of intuition.
- [x] Regenerate the `*_BUDGET` blocks in `src/templates.ts` from the same config so the prompt text and the enforcement numbers are always identical.
- [x] Add a worker-only implementation phase gate: after the configured pre-implementation discovery allowance, block further non-report tools until the worker attempts an implementation tool call; reset the phase state on reuse turns and persist it with the budget summary.
- [x] Charge the report contract against report prose only. Output spent on tool-call arguments is bounded by the call budgets and recorded as `toolArgumentOutputTokens`, provider reasoning is recorded as `reasoningTokens` and excluded from the report limit, and delivery metrics carry `reportOutputTokens` separately, because a provider's `output` total includes reasoning and a high-thinking model was spending its report contract on thinking.
- [x] Record a breach detected on the report turn as `report_only` instead of steering or aborting. A turn with no tool call ends the child run, so steering only bought a second, shorter report and discarded the one the parent should have received.
- [x] Scale the call budgets with the assigned scope: the parent exports the declared in-scope path count and `scopedRoleBudget` adds `scopeCallAllowancePerPath` tool and discovery calls per path up to `scopeCallAllowanceMax`, so a 10-path review is not budgeted like a 1-path fix.
- [x] Rebaseline the reviewer budget from measured evidence. A 10-path primary review spent 26 calls and a 1,858-token report; the shipped default is 32 tool calls, 28 discovery calls, and 4,000 report tokens, with discovery kept below the call budget so reads have headroom.

Acceptance:

- A worker exceeding its configured call budget is stopped and returns a ledger plus report, instead of continuing for 200 more calls.
- The number in the agent prompt, the number enforced, and the number in the result view come from one config source.
- Budget breaches are counted in telemetry per role and per tier.

Dependencies: W1 for the outcome record. Independent of `bash-tools`.

Status: Implemented with focused live-enforcement, persistence, attribution, template coverage, and worker phase-gate coverage. Tuning after the first measured reviews also landed here: scope-scaled call allowances, prose-only report accounting with provider reasoning excluded, the `report_only` outcome for a breach on the report turn, and a reviewer budget rebaselined from a 10-path review. Child-to-grandchild execution is intentionally unsupported by design and is covered by the nested-response guard; first-level main-to-child smoke requires a host session that exposes the project's subagent tool.

## Workstream 5: fan-out pre-digest and disjoint review scopes

Evidence: `git_diff` is 22.6% of all tool-result text from 3.9% of calls; every one of the 25 largest result calls in the window was a diff; ~1.42M tokens came from ~20 sibling children of one root each pulling the same working diff. This is a fixed per-agent cost proportional to repository state rather than to the change under review.

Changes:

- [x] Add `scope` to `TaskItem` and `ChainItem` (`src/execute.ts`): in-scope paths or hunk identifiers, explicitly out-of-scope areas, and an assigned review scope for focused reviewers.
- [x] Snapshot the review surface once per delegation flow at spawn time (status summary, `--stat`, hunk headers, optionally bounded content) into a flow artifact, and hand each child the artifact path plus only its own scope slice.
- [x] Enforce scope at the instruction layer by injecting it into the child prompt: "report only on this scope; do not broaden; out of scope: ..." (today this is only prose in the guide's Reviewer scope section).
- [x] Record scope and the artifact reference in W1 telemetry, so duplicate-acquisition across siblings becomes measurable rather than anecdotal.
- [x] Keep this independent of the `bash-tools` diff cap: the pre-digest reduces how many times the diff is pulled, the cap reduces what each pull costs, and the two multiply.

Acceptance:

- N reviewers over one change produce one diff acquisition per flow instead of N.
- A focused reviewer's report stays inside its assigned scope, verified by the files it touched versus the scope it was given.
- Number of `git_diff` calls per delegation turn drops sharply in W1 telemetry.

Dependencies: none to start; stronger once `bash-tools` ships the diff cap.

Status: Implemented with focused scope, overlap, snapshot, telemetry, and prompt coverage. Child-to-grandchild execution is intentionally unsupported by design; first-level main-to-child smoke requires a host session that exposes the project's subagent tool.

## Workstream 6: read manifests instead of mandated reads

Evidence: 1,279 intra-session excess reads (26% of all reads) when range differences are ignored; `PLAN.md` read 94 times across 29 sessions; the guide read 28 times in 7 sessions; children rebuild shared planning and validation context rather than reading task files.

Changes:

- [x] For each delegation, emit a read manifest next to the task file (already written by `writeAgentTempFiles`, `src/run.ts`): files the child may read, prior role reports by path, evidence already established, and an explicit do-not-re-read list.
- [x] Inject the manifest into the child prompt prefix rather than the task text, so it is cache-stable.
- [x] Replace the guide's "the worker/planner must inspect relevant files" mandates with manifest-driven mandates: inspect gaps, and state which gap each extra read resolves (already in the planner template; make it manifest-relative).
- [x] Report `repeatedReads` per delegation (already computed at delivery) as the pass/fail signal, and warn in `subagent_stats` when a child re-read a do-not-re-read path.

Acceptance:

- Intra-delegation excess reads drop measurably against the 1,279 baseline.
- Children stop reading `PLAN.md` and the guide when a manifest already carries the content.
- Manifest contents are visible in telemetry so regressions are attributable.

Dependencies: W1 (per-delegation attribution), W2 (report paths to reference).

Status: Implemented with manifest persistence, fresh/reused cleanup coverage, reread telemetry, and analyzer documentation. Child-to-grandchild execution is intentionally unsupported by design; first-level main-to-child smoke requires a host session that exposes the project's subagent tool.

## Workstream 7: validation ownership and the `verify` handoff

Evidence: 1,075 duplicate `project_command` calls, 49.7% of that tool's calls; 33.7% error rate; `force:true` used to bypass the cache; 141 of 288 role assignments produce no code change; the validator's `V-###` fingerprint mandate has no shared ledger, so each agent re-executes a whole suite to mint a private fingerprint.

Blocker cleared, then partially re-opened. The reuse key was the last dependency: `dirtyFilesDigest` hashed `git status --porcelain` output, so paths and status columns only, and a `passed` record could be replayed after content-only edits to already-dirty files. `bash-tools` now digests `git hash-object` per dirty path together with mode, size, and status, re-`lstat`s before and after to catch a racing write, and fails closed by returning no state (no ref, no reuse) when the tree cannot be hashed reliably. Flow-scoped evidence, ref lookup, `covers`, and `producerScope` landed with it, so refs are reusable across siblings of one flow.

The part that looked like it had not closed had, and my report said otherwise. On this workspace a content-only edit to a file that was already dirty appeared to leave `dirtyFilesDigest` byte-identical across three `verify` calls, and I filed that as `F8`, eventually at P1, claiming the key was blind to content in tracked-modified files. It is not. The file in every one of those measurements was `PLAN.md`, and `.gitignore` lists `PLAN.md`, so it is absent from `git status` and was never input to the key; one appended sentence to `README.md`, which is genuinely tracked-modified, moves the digest. `F8` is withdrawn in `analysis/BASH_TOOLS_FOLLOWUPS.md`, the archive of the error is kept under its heading, and `analysis/F8_PROBE.md` holds the corrected table with the four wrong turns in order. The one ask that survives is documentation: say that ignored paths are outside the key, because a consumer who assumes otherwise reaches my conclusion. The shipped posture is unchanged, though it no longer rests on this: D8 treats a ref as attesting to a command set at a moment rather than as a lock on content, the gate is minted after the last edit, and a role that edits again mints a new ref. That posture was argued from the shared-tree union problem in D8, which stands on its own, and it costs nothing that the digest turns out to be a content key.

Landed in this extension: `verify` is enforced and measured, so reuse is visible in telemetry, and the roles are wired to it.

- [x] Classify tool-issued refs in enforcement and telemetry. A `verify` call is one full validation pass; a `verify` call that supplies a `ref` is a lookup and is not charged, so resolving evidence stays cheaper than re-running the gate. Minted and resolved refs are recorded as `metrics.validationRefs` with `reused`, `lookup`, and the minted repository state, and the spend line shows `verify:N ran:M`.
- [x] Make the orchestration guide repo-owned. `/setup-subagents` writes `subagent_orchestration.md` beside the agent files from `src/orchestration-guide.md`, with the role budget lines generated from the budgets in effect, so guide and prompts cannot state different limits. This removes the ownership blocker on guidance changes: the guide is now in this repo, versioned, and covered by `test/orchestration-guide.test.ts`.

- [x] Only the session that modified files may run mutating or expensive checks. The worker mints the `verify` ref for the state it produced and reports it verbatim; the validator resolves refs before executing anything and runs only what no live ref covers. Enforcement is a budget-side block in the tool-call path, stated in full in D9: a child whose role is not listed in `mutatingCommandRoles` (default `worker`) is refused a write-capable `project_command`, where a variant of a family that can write fails closed unless it names a `check`, `verify`, or `ci` form, and is refused any `scripts` override on a `verify` call, because every phase accepts an arbitrary package-script name. A child outside `validationExecutionRoles` may call `verify` only as a bare `{ ref }` lookup. `verify` lookups stay uncharged, and variant command ids are charged to the family they belong to (`node_test:coverage` is a validation pass), which closes a budget escape hatch.
- [x] Change role tool allowlists in `src/templates.ts` so the validator gets `verify` rather than the raw `project_command` surface. Deliberate deviation from the original wording: `project_command` stays in the validator allowlist, because validators still own `node_build` and the `fallow_*` analyses, which `verify` does not expose. The prompt text names `verify` as the gate and `project_command` as the remainder-only surface, and a formatter command is never remainder work, because the format phase of `verify` is the formatter check. The worker gets `verify` too, because it is the role that mints. `test/templates.test.ts` updated in the same change.
- [x] Make validation references tool-issued and flow-scoped. The child prompts and the guide lead with the `verify` ref, name the mint owner and the consumers, define staleness as a `repositoryState` or `covers` mismatch, and give each reported check a freshness of `executed`, `reused`, or `resolved` - the same shape `metrics.validationRefs` records. `V-###` survives only as the fallback shape for projects with no composite `verify` gate, still marked non-reusable when it carries no hash.
- [x] Encode the ratio finding. Tier 1 has no validator and the worker ref is the evidence; Tier 2 defaults to planner, worker, reviewer and adds a validator only for Medium or High validation complexity or when independence is required; Tier 3 keeps the validator and names `evidenceScope: "session"` for security-sensitive, environment-sensitive, or release-critical checks; targeted remediation drops the validator by default. The guide states once that where a check is deterministic the plan is one `verify` ref plus one review owner, and that delegating a validator to re-run covered evidence is a defect.
- [x] One authoritative guide. The hand-maintained `~/.pi/agent/SUBAGENTS_GUIDE.md` is gone and `src/commands.ts` still warns when it finds a stale legacy copy, which is the right behaviour for other machines. The pointer into the guide moved surfaces twice: it started as a mandate in `~/.pi/agent/APPEND_SYSTEM.md`, and that section has since been deleted, so the only pointer is the generated `Workflow contract:` sentence in the `subagent` tool description. See W8 and round 13; nothing outside this repo now tells a session to read the guide.
- [x] Fan-out ownership and the shared tree. The guide carries `Parallel fan-out and validation`, the worker prompt sends the gate to the integrating session, the validator prompt attributes a sibling's in-flight files to contention instead of to the change under review, and `repositoryWriteLock` (`src/repo-lock.ts`) makes a write-capable command exclusive per repository for the duration of the call and refuses a check that would read a tree another session is writing. Stated in full in D10.

- [x] Measure the W7 acceptance, which was proven only by tests. The data is already written (`metrics.validationRefs`, `budget.usage.fullValidationPasses`, the `verify:N ran:M` spend line, and `TELEMETRY_SCHEMA.md` documents all of it), but `analysis/measure.ts` renders no section for it, so `npm run test:analyze` cannot show movement on the four acceptance bullets and the baseline duplicate count in `analysis/BASH_TOOLS_FOLLOWUPS.md` cannot be re-measured from the checked-in artifact. Needs a validation-evidence section: refs minted and resolved per flow, executions per distinct repository-state digest inside a flow, and validation passes per delegation by role. Landed as two sections, one for evidence and one for guide cost. The first live reading, in `analysis/MEASUREMENT.md`: 101 delegations, 2 refs minted, 2 resolved by lookup, 0 reused, and **2.00 executions per distinct repository-state digest**, which is the duplicate-execution signal this workstream exists to remove, now a committed number rather than a claim.

Residual `bash-tools` asks, none of them blocking: see `analysis/BASH_TOOLS_FOLLOWUPS.md`. Sequencing decision, so it is not re-litigated: none of F1 to F7 gates W8 or any other work here, because each has a working consumer-side answer. F1 (no `fresh` knob) costs us a forced re-execution of unchanged state, and refs are content-addressed, so nothing is reused that should not be. F2 (a root session cannot resolve a flow ref) costs us one hop of the handoff, answered by sending refs upward in the ledger and citing them; the producer-side mechanism is now decided in `analysis/BASH_TOOLS_DECISIONS.md` D5, a `publish: { flowId }` option at mint plus a `{ ref, flowId }` lookup, and is waiting on their build rather than on a decision. F6 (write effects are not declared) is why both classifiers here are name-shaped and fail closed. F7 (no single-flight) is why we shipped a consumer-side repository lock at all; the last ask in F7 offers a producer-owned per-repository mutex, and if that lands we delete `src/repo-lock.ts` and its tests rather than keeping two locks. The two that would change what we can express are F1 and F2.

Review round on this workstream, one independent primary reviewer, verdict FAIL with seven findings, six accepted and remediated, one deferred:

- F-001 High, accepted: the mutating control covered `project_command` ids only, while the same change handed the validator `verify`, whose `scripts.format` parameter accepts any package script and so reaches a writing formatter. Fixed with the `verify` rules and the fail-closed variant rule in D9.
- F-002 Medium, accepted: the validator prompt named `node_format:check` as remainder work that `verify` does not cover, when the format phase of `verify` is that check, i.e. the prompt ordered a re-run of covered evidence and recommended a remainder set exceeding the 3-pass ceiling. Fixed.
- F-003 Medium, accepted: a lookup that returns nothing had no defined behaviour, while staleness did, and the root-mint asymmetry lived only in the analysis handoff. Fixed in the prompts, the guide, and the README.
- F-004 Medium, accepted: the reviewer was told to audit references with no tool that could resolve one. Fixed by D9.
- F-005 Low, accepted: the family classification that closed the budget escape hatch had no assertion. Fixed.
- F-006 Low, deferred: most new assertions are sentence-exact prose pins, which is pre-existing style here. The conversion to behaviour-level assertions belongs to W8 alongside the instruction-layer de-duplication, and W7 acceptance is credited from the enforcement tests in `test/budget.test.ts` rather than from prose pins.
- F-007 Low, accepted: the README documented the new default without an upgrade path and claimed the mutating control was broader than it was. Fixed.

Operational prerequisite, not code: children receive `verify` only after `/setup-subagents` regenerates the installed agent definitions against the reloaded extension. Until then the ref-first contract is inert in children, and a child mints manual fingerprints.

Second review round on this workstream, fresh seat, verdict FAIL with four findings, all closed:

- F-001 residual Medium, accepted: the guard tested only the presence of `scripts.format`, while `lint`, `typecheck`, and `test` carry the same arbitrary-script type, so `verify({scripts:{lint:'lint:fix'}})` stayed executable by a validator that may not write. Now any `scripts` override is refused for a role outside `mutatingCommandRoles`, asserted for both `format` and `lint` in `test/budget.test.ts`. The non-listed-family half is a declared limit, not a defect we can close from the consumer side (F6).
- F-005 residual Low, accepted: the discovery branch of the family-charging rule had no assertion, so a regression would have moved discovery spend into the validation metric W7 acceptance depends on. Asserted.
- F-008 Low, accepted: this workstream still described the old variant blocklist and still listed a formatter check as validator remainder work, contradicting D9 and the prompt the validator receives. Restated.
- F-009 Medium, accepted: neither worker run bracketed the combined post-remediation tree and no ref covered it, which is the standard this workstream makes mandatory. The root ran the composite gate on the tree at that round, ref `vr_5bf61a0e8d88e159b188a2fe`, freshness `executed`, and the doc edits that recorded that round superseded it under the staleness rule of this same workstream. That is the expected shape of the invariant: a document inside the repository cannot carry live evidence about itself, so refs belong in the flow ledger, and the tree at commit time needs one further gate run. The two workers could not mint a ref at all, because their installed definitions predate `verify`.

Third review round, fresh seat and a narrow closure scope, verdict FAIL with two residuals and one new finding, all closed:

- F-010 Low, accepted: the new guard inspected `scripts` only when it was a plain object, so `verify({scripts:['format']})` or a string form reached an executing role that may not write. The check is now presence-only and shape-insensitive, asserted for the object, array, and string forms.
- F-008 residual Low, accepted: the D8 enforcement sentence still named only the format phase. Restated.
- F-009 residual, accepted as a standing consequence rather than a defect: the gate run is repeated on the exact commit-time tree, and its ref is recorded in the flow ledger. This document keeps the identifiers only as provenance of the review rounds.

Fourth review round, a fresh seat scoped to the fan-out increment only, verdict FAIL with eight findings: four accepted and fixed, one accepted with a narrower fix, two accepted as test or wording gaps, and one rejected with the reason recorded.

- F-001 Medium, accepted: the exclusion was taken before the other refusals in the same handler, and a refused call produces no `tool_result`, so a budget-gated child excluded every sibling for up to the TTL over a command that never ran. Fixed by splitting the guard: the read probe runs before anything is charged, the write is taken after every other refusal, and a repeated `toolCallId` releases its stale handle first. Asserted by a test that refuses a write on budget grounds and then probes the repository from a sibling.
- F-002 Medium, accepted: holder identity was the label alone although `flowId` was recorded, and labels are allocated per delegating session, so two flows sharing one checkout did not contend and D10's own claim was false. Identity is now label plus flow, in acquire and in probe, with a test for the colliding `worker-1`.
- F-003 Medium, accepted with a narrower remedy: publish is now atomic (`linkSync` from a per-token temporary file) so a holder can never block on its own write, and an undecodable entry stops excluding anyone after a 2 second grace instead of the full TTL. The requested `exclusion: unavailable` attestation is declined: the ref's repository state is computed by the tool from the tree either way and `bash-tools` fails closed when it cannot observe that state, so a store outage costs mutual exclusion, not the honesty of a minted ref, and D10 now states that limit.
- F-004 Medium, accepted: `node_build` and write-y test variants were affirmatively classified as readers, so concurrent builds wrote `dist` and `coverage` through each other under the flag meant to serialize them. Exclusion is now wider than permission via `isExclusiveWriteCommandId`, which keeps `mutatingCommandRoles` unchanged so a validator may still build.
- F-005 Medium, accepted: the pre-existing W7 mint sentences named every modifying session as the gate owner in imperative mood while the new section named one, so the guide had one owner in one place and N in another. Each of the four sentences now carries the fan-out qualifier, the non-owner's report shape is stated (`validation_refs: none`, the composite check `NOT_RUN`, sibling edits as contention), and the tests assert the unqualified wording is gone.
- F-006 Low, accepted: outside any checkout the key walked to the filesystem root, so unrelated directories shared one lock. The resolved working directory is now the key and the docstring matches.
- F-007 Low, accepted as designed with the cost named: a contention refusal still costs a tool call, because charging is what bounds the retries the refusal asks for, and it now refunds the validation pass it did not earn. The block reason states the cost and the three-attempt limit.
- F-008 Low, accepted: added the missing branch tests for both fail-open paths, the non-repository key, the decode grace, and a cross-flow same-label hold, and lock-file cleanup now runs in `afterEach`.

Fifth review round, fresh seat and a closure scope limited to those eight findings, verdict PASS. It verified each closure against the code rather than against the claims, confirmed the new assertions fail under an inverted or removed guard, and confirmed a child cannot loop on contention refusals for free because `toolCalls` stays charged. It added one Low finding of its own, F-009: the acquire loop was bounded at two attempts, so a slot that read free on both could end in a refusal naming "an unnamed session", which is an unactionable reason for a repository nobody held. Fixed by three attempts plus a final republish, and by letting the command run unheld when every attempt found the slot free, consistent with the declared fail-open rule; the only path that still names an unnamed holder is a genuinely corrupt entry inside its 2 second grace.

Sixth review round, fresh seat `reviewer-16`, scope limited to closing the eight round-4 findings. Verdict FAIL with two Low findings, one of which its own remediation caused.

- F-011 (Low, documentation): the README named neither the lock file location nor the fact that write classification is name-shaped. Both are now in the README, with the lock path given as `<agent directory>/subagent-herdr/repo-locks/<hash>.lock`, the hash named as the first 32 hex characters of the SHA-256 of the repository root, and the `F6` dependency stated as the reason an unrecognised write path falls back to the guide rule.
- F-012 (Low, introduced by the round-5 remediation): the path that treats an undecodable lock entry as abandoned ran before the read succeeded or failed, so a `readFileSync` that threw for a reason other than "missing", typically `EACCES` on a mode the reader cannot open, deleted a live holder's lock. A reader that cannot inspect a hold is not entitled to free it. The entry now stays in place and keeps excluding until its age says otherwise, and the refuser reports it as an entry it cannot read rather than inventing a session name. Temporary publish files left by a process that died mid-publish are swept on each acquire, which is disk hygiene rather than correctness.

The fix changed the exclusion API: a refusal carries `{ holder?, observedAt }` instead of a holder or a synthesised stand-in for one, because "unknown who" and "nobody" are different answers and only the first is a reason to wait. `RepositoryWriteContention` is now the shape both guards and both test files consume, which is why the diff is larger than the bug.

One constraint this round settled by measurement rather than argument: a ref minted by the root session is not resolvable by a child. The root carries no `PI_ORCHESTRATION_FLOW`, so its refs live in a process-local store, while a flow-scoped child reads the on-disk flow store and answers "ref not found in the authorized flow cache". `reviewer-16` hit exactly this on the ref handed to it and reported the lookup failure instead of treating it as missing evidence, which is the correct behaviour and the reason the D9 lookup grant is still worth having. Practical consequence for orchestration: when a downstream child must resolve a ref, the minting call belongs to a child in the flow, not to the root; the root's own gate remains useful as a self-check and as `covers` evidence, and the round-5 gate `vr_6adec255d0168308554e6cd2` was already recorded as unresolvable in-session for the same reason. This is the field confirmation of `analysis/BASH_TOOLS_FOLLOWUPS.md` F2, and it is the one `bash-tools` gap now visible from the orchestration side.

Remediation gate for this round: `vr_35971fa7a033c32f1b1ace68`, four phases with `format:check` so the check is read-only, 26 files and 530 tests, head `88a6ac46`, and it is root-minted, which by the paragraph above means a child seat cannot resolve it. A separate observation from the same probe series: a gate with omitted phases still mints a ref but reports `verdict: incomplete`, so a ref alone never proves a full pass and `covers` plus the phase list are what a consumer must read.

Seventh review round (`reviewer-18`, closure scope `F-011` and `F-012` only, fresh seat rather than reused): verdict FAIL with six new findings, and the two it was asked to close are closed. `F-011` closed on the README text, `F-012` closed on the read-error branch. The new findings are the reason a closure pass is worth its cost, because four of them were consequences of the round-6 fix rather than pre-existing defects:

- `F-013` (Medium) was the real one. The clock-skew clause added to stop a future-stamped hold wedging a repository deleted the entry when its stamp was merely 60s ahead of the reader's clock, so a holder whose clock runs ahead lost its lock on the first sibling probe. Worse, `releaseRepositoryWriteLock` probes with an effectively infinite TTL and that clause ran `rmSync` before the release token check, so a release could delete a foreign entry. Fix: a future stamp is a hold again, and hopeless entries are reclaimed only by the inode-age bound, which no live holder can be measured by. The comment claiming that clause was the only way a killed holder cannot wedge a repository was simply false, and the reviewer quoted the line that already did the job.
- `F-014` (Low) was the regression the `F-012` fix introduced: a non-`ENOENT` read error is reported held and never unlinked, so an unreadable entry older than TTL plus slack was held forever, every publish collided, and acquire fell through to running unheld. Exclusion switched permanently off with no signal, which is narrower than permission, the one direction that is not allowed. Fix: unlink past the same bound the reader already used to call it free.
- `F-015` (Low): `normalizeHolder` accepted any JSON object, so `{"x":1}` became a holder named "an unnamed session" with an empty token, held for the full TTL and unreleasable. That reintroduced both the wedge and the synthesised name the contention shape exists to remove. Fix: a holder record requires a non-empty token and label, otherwise it is corruption and self-heals on the 2s grace.
- `F-016` (Low): the README still promised a refusal always names the holder, and the one user-visible string said "cannot read" for entries that are readable but not holder records, sending an operator to suspect permissions when the file was corrupt. Fix: qualified both README clauses and reworded the refusal to "cannot identify".
- `F-017` and `F-018` were the doc half, and both were mine: the R4 recap three lines above the `F8` section still asserted the hashing defect after the section itself had been softened, and the `F8` downgrade did not name the difference between the two probes. Both were corrected at the time, and both corrections then turned out to be downstream of a wrong conclusion, which is dealt with below rather than here.

Four regression tests cover the code half: a forward-stamped hold survives a sibling acquire and a foreign release; an unreadable entry is cleared once no live holder can be measured by either clock; a JSON object that is not a holder record is corruption and re-acquireable after the grace; and the budget refusal for an unidentifiable hold carries the "cannot identify" wording without naming a session. The suite is 26 files and 534 tests.

How the `F8` record ended up, stated once because it went the wrong way three times: the finding was never real. The key does observe content in tracked-modified files, and every row that said otherwise was measured on an ignored file whose label was copied forward without being re-checked. The lesson for this plan is procedural and sharper than the hashing lesson it replaced: a probe must confirm its subject is in the population before it reports on the population, and "I checked the file was in `git status`" is not something to assert from memory four rows deep. "It did not reproduce when I tried again" was correctly rejected as evidence the first time, and the version that finally convinced me held its variables still and was still wrong, because the control group was empty. Nothing shipped depended on the finding, which is the only reason its reversal is a documentation change.

Closure gate for this round: `vr_df6a2ef1e0d5c058e62c238b`, four phases with `format:check`, 26 files and 534 tests, head `88a6ac46`, covering all fifteen findings from rounds 4 through 6 plus the six above. Like every gate minted here it is root-minted and therefore unresolvable from a child seat, which the round-8 reviewer is told to expect rather than count as missing evidence. The final gate on the tree this round actually ships is `vr_f197d9f0528d8584fc28a495`, same four phases, minted after the `F8` reversal below and after the probe file was added.

While preparing that handoff, `F8` appeared to reproduce itself, and this section originally recorded the reversal as a confirmed defect. It is withdrawn; see the `F8` paragraphs above and `analysis/F8_PROBE.md` for the corrected measurement. What was actually observed, in order and without the conclusion that was bolted on afterwards: two gates around two content edits reported the same digest, a control adding an untracked path moved the digest on the next mint, and a rewrite of that untracked file moved it again. Those rows are all true and none of them shows what I said they showed, because the file held constant across them, `PLAN.md`, is ignored and therefore not in the digest at all. The mints added under `F-022`, a one-byte change at fixed byte count and then a sentence appended to `README.md`, are what settled the question, and they point the other way: content is in the key, both untracked and tracked-modified. The honest summary of the whole episode is that three reviewers audited the prose of a measurement whose subject was mislabelled and none of them, including me, went back to the raw `git status`.

Eighth review round (`reviewer-20`, closure scope `F-013` through `F-018`, fresh seat): verdict FAIL, all six prior findings closed, four new ones filed, and `F-020` was a Medium regression introduced by the round-7 remediation itself. Closing `F-014` had added an unlink on inode age *before* the read, which meant a readable, decodable, unexpired entry could be deleted by a sibling whenever something other than the holder's own write moved its mtime, a sync client or a restore under the agent directory; the same branch reported `free` when its own unlink failed, which sends every publish into collision and the acquirer into the unheld fallback. The fix orders the questions: read and parse first, let an entry that names a holder be reclaimed only by its own stamp, and use the inode bound only for entries that name nobody. Two of the reviewer's falsification attempts were accepted as written, and one is worth keeping because it is counter-intuitive: a host clock stepping *backwards* mid-hold cannot trigger the delete at all, because it makes the inode age more negative, so that direction of skew is safe and only widens exclusion. `F-019` was a test that passed through the wrong branch, fixed by giving the fixture a live stamp with an aged mtime so only the inode path can satisfy it, plus the privilege guard the sibling test already used; `F-021` was the adjective "content-based" surviving 136 lines above the section that disproves it; `F-022` is the one that changed a document rather than a line, because it said the probe's conclusions outran its rows and it was right, which is why rows 8 and 9 exist. Rather than only demoting the inferences as `F-022` asked, the missing discriminator was run: one hex character in one untracked file with path set, status, mode and byte count all held, and the digest moved.

Ninth review round (`reviewer-21`, same scope, fresh seat): verdict PASS, the first clean pass this workstream has had, with `F-019` through `F-022` closed and three new Lows, all of which were taken. `F-023` is the best of them and reads as an argument rather than a grep: the surviving branch that deletes a decodable entry requires a stamp ahead of our clock *and* an inode behind it, and one machine writes both numbers, the kernel writing mtime and `Date.now()` writing the stamp, so on a skewed clock they travel together and that branch is unreachable by skew. It therefore does not prevent the wedge its comment claimed it prevented, because a holder killed with a far-future stamp has an mtime that went ahead with its stamp; it is a backstop for restored or tampered bytes and nothing more. The branch stays, because removing it would leave no path at all for a hopeless entry, and what changed is the comment plus a test pinning both conjuncts so neither can be widened silently. `F-024` was the same prose failure the round before named as this file's recurring defect, caught in the summary line rather than the table: row 8 had been credited with closing the confounder when it moved two variables and only row 9 earns that, and a rewrite moves mtime and ctime alongside the byte, so the claim survives as "content or per-inode timestamps", which does not weaken the consumer rule because both react to a write. `F-025` matters for how much the green number is worth: two tests whose privilege guard could not build the fixture returned early and vitest counted them as passes, so they now call `ctx.skip()` and announce themselves, which on a root runner prints two skips instead of two silently empty passes.

The pattern across three rounds of closure review is that the mechanical guard keeps producing findings at the seam between two clocks, and the documentation keeps producing findings wherever a summary restates a body more confidently than the body does. Both are worth remembering for `W8`, whose whole subject is a duplicated instruction layer. Gate on the tree closing `F-019` through `F-025`: `vr_f05c02bb939b55f9616ec5bb`, four phases with `format:check`, 26 files and 536 tests, head `88a6ac46`. The paragraph above is prose-only and postdates that mint; the commit-time mint recorded in the commit message is the artifact.

Deferred into `W8`, collected here so the review rounds do not lose them:- Make `## Files Reviewed` mandatory and parsed into `changed_files`. Four reports in a row have carried "no ledger block parsed", which makes every reviewer's file set invisible to `codegraph_affected` and forces the untracked-file caveat in the README. It is mechanical and it is the cheapest of the backlog.
- Stop flattening phase-level `omitted` into `verdict: passed` in ledger evidence, and keep `covers` out of `quality_metrics`, where it reads as a quality signal rather than a scope list. Both were recorded as honest limits by the sixth-round reviewer and neither is a bug anyone argued for.
- Convert the prose pins to behaviour tests, cover `src/tools.ts`, and de-duplicate the instruction layer, all carried from the `W7` open items.
- Have the spawner pass its own dirty paths into children, which is the mitigation `F5` recommends for the digest gap and needs nothing from the producer. Note `F8` was withdrawn as measured, so this item is about a worker's own paths being invisible to a *sibling's* ref, not about the digest missing content.

Then, after the ninth round had passed: `F8` is withdrawn, and it was my error rather than the producer's. The
`git_status` listing of every dirty path in this repository does not contain `PLAN.md`, because `.gitignore` lists it,
so every row of the probe that said "content edit to a tracked-modified file leaves the digest unchanged" was measured
on a file that is not in the key's input at all. One appended sentence to `README.md`, which is genuinely
tracked-modified, moves the digest, and a one-byte change to an untracked file moves it too. The producer's
implementation is what its source says it is. `analysis/F8_PROBE.md` is now the corrected table plus the four wrong
turns in order, the `F8` section of `analysis/BASH_TOOLS_FOLLOWUPS.md` carries a withdrawal banner above the archived
text, and the surviving ask is one documentation line: ignored paths are outside the key. The D8 posture is unchanged
and needs no re-litigation, because it was argued from the shared-tree union, which is independent of what the digest
hashes. Two things follow for the next round: the withdrawal has been read only by me, so it deserves an independent
pass before `W7` is called closed, and the failure mode to look for is not a wrong conclusion but a label copied
forward from a measurement nobody repeated.

One last piece of evidence about the reuse cache came from the commit-time mint itself, and it also survived its own reversal. After the four phases passed on the closing tree at `vr_f05c02bb939b55f9616ec5bb`, `PLAN.md` was edited and re-minting returned `status: "unchanged"` with `reused: true` and `executed: false` on every phase. Read alongside the withdrawn `F8`, that is correct behaviour rather than a defect: `PLAN.md` is ignored, so the tree really had not moved in the only sense the key tracks. What remains true and worth asking for is `F1`: there is no `force` on `verify`, so a caller who wants a fresh execution cannot insist on one, and a caller who sees `reused: true` cannot tell whether the state was re-read or served from cache. Final gate for this tree is recorded in the commit message, because the act of recording it moves the tree. Final gate for this tree: `vr_7fbf8a20358d0de9f31c903f`, four phases executed, 26 files and 536 tests.

Tenth review round (`reviewer-22`, with `reviewer-23` closing it): verdict FAIL on the documentation, and the withdrawal is confirmed sound. It checked `F8` from the artifact side and agreed: `dirtyFilesDigest` is content-sensitive for every path `git status` reports, `F8` was a measurement error, the `analysis/` trail shows its reasoning moved from overclaimed to overcorrected to accurate, and `src/repo-lock.ts` consumes no producer digest at all, so the withdrawal requires no shipped-behavior change. Six findings, all documentation, all fixed. `F-027`: `analysis/BASH_TOOLS_FOLLOWUPS.md` still described the provenance as "a digest over the dirty tree" with no exclusion for ignored paths, and still listed "digest blind to tracked-modified content" among the unexplored alternatives. `F-028`: the archived claim "content edits to tracked modified files did not move digest" was false unamended, and the row-9 line claiming an identical digest over different tracked content was about a gitignored file. `F-029`: the same file's F8 body still asserted a ref replayed as `reused: true` over a dirty write, which was that same gitignored file. `F-030`: probe rows 7 and 9 were the same event listed twice, one mislabeled as a tracked file. `F-031` was the real one: shipped guidance told a worker its digest would differ if *anything* about the dirty state differed while the next sentence told it to treat gitignored files as invisible, so a worker holding both drew the wrong conclusion about its own evidence; `src/templates.ts` and `src/orchestration-guide.md` now say the digest describes only what `git status` reports, pinned by tests in both suites. `F-032`: the guide and its test still pinned "a worker cannot mint a ref at all", the exact claim `D10` reversed; the guide now states that an execution-capable role inside the flow can mint while the orchestration session cannot, and the test asserts the retired sentence is absent and the qualified replacement present.

The measurement behind `F-031` also closed the last doubt about replay, and it is the cleanest evidence in this whole thread: a word swap in `README.md` at an identical byte count moved the digest, and restoring the word restored the earlier digest bit for bit. Content moves it, the mapping is deterministic in content, and no ref was ever served over a tracked change. What that changes is narrower than it looks, because the lock consumes no producer digest and `D8` was argued from the shared-tree union rather than from what the key hashes.

`F-026` remains open, and its real cause is not the one I guessed. Four child seats tried to mint and each died identically: `verify authorization failed: timeout`. The role gate was never reached. Authorization for `verify` is decided per call *shape*, a fingerprint over the phase and script set, and this project's policy file carries seven allowed `verify` shapes and two denied ones. A child whose shape is not already listed falls through to an interactive prompt, nobody is watching the child's pane, and at `confirmationTimeoutMs` of 120 seconds the call dies; retrying with a shape that *was* listed still timed out, so the child's fingerprint evidently does not match the parent's even for an identical call. **[corrected in round 11: that retry used a shape that was not in the allow list, and two other attempts matched recorded denies, so nothing was ever shown about fingerprint portability across seats. A listed shape mints from a child seat, and `F-026` closed the same round this was corrected.]** So the mint-and-resolve design is not disproved, it is untestable from a seat that cannot answer a prompt, and no orchestration claim about child-minted refs may be written as observed until either child `verify` shapes are pre-authorized per project or the producer gives flow-scoped seats a non-interactive authorization path. That is the user's call, and it is the one thing standing between this workstream and a live proof. Gate for this round: `vr_30ee8bf99d2efe1a5f50a032`, four phases with `format:check`, 26 files and 537 tests, and the producer ask is `F9` in `analysis/BASH_TOOLS_FOLLOWUPS.md`.

**Round 11: `F-026` closed, and it closed because I went and read the policy file instead of trusting my own inference.**

Two worker seats took the W7 measurement item and the `src/tools.ts` coverage item in parallel with per-task scopes, and both finished their edits while neither could gate them: one exhausted its role budget, the other was refused `verify` with `verify authorization failed: denied`. Reading `~/.pi/agent/bash-tools.json` to find out why settled the question I had been calling structural. `verify` authorization is decided per call *shape*, an identity of `{ commandId, fingerprint }`, and this project had accumulated seven allowed shapes and two explicit denies. My "a child seat cannot mint at all" was built from four timeouts and two denials on shapes that were unknown or denied, and it was simply wrong: a shape already on the allow list minted from a worker seat without ceremony.

Once a ref existed, the test `F-026` had asked for since round 7 ran in one seat. `validator-6` resolved both worker-minted refs, `vr_4f23b613381ea8dab8d05f7a` and `vr_34505fee17381e81e833d435`, by bare `{ ref }` lookup and executed nothing, while the root-minted ref handed to the same seat in the same call still answered "not found in the authorized flow cache". Flow-scoped sibling resolution is therefore observed, the child-to-parent asymmetry stands, and the caveats I had written into the README, the guide and their test pins an hour earlier were reversed in the same round rather than left standing because they were mine.

The same read produced two payload asks, both reproduced from a seat that needed them and could not get them. A lookup names no producing role and no scope, which is `F5`. A lookup also returns the digest recorded at mint time rather than a recomputed one, so a validator cannot decide staleness from a lookup and must re-execute a gate to learn what the lookup should have told it; that is `F-033`, and it is the expensive one because its cost is a whole gate per handoff.

The measurement item landed as two analyzer sections, and the first live numbers beat the plan. Validation evidence at 101 delegations: 2 refs minted, 2 resolved by lookup, 0 reused, and **2.00 executions per distinct repository-state digest**, the duplicate ratio driven down to something countable. Guide cost: 35,093 rendered chars, **8,773 estimated tokens**, against the 5,415 figure W8 was written from, with 12 root reads after the cutoff at 2.40 per delegating root. The guide grew 62 percent past the number that justified trimming it, and now the number is measured in a committed file with a test pinning the section.

Both seats also reported that `project_command node_test` rejects the `paths` array because the harness delivers it JSON-stringified, so neither could run a focused test and each paid for the whole suite. That is `F4` in the follow-ups report, biting again, and it is a two-line producer fix.

Gate for the union of both seats plus my corrections: `vr_cf2a09904ded770bc8a7c722`, four phases with `format:check`, 27 files and 568 tests, head `150d42bd`.

**Round 12: the trim was approved on content and rejected on evidence, which is the verdict this mechanism exists to make possible.**

Three seats ran as a chain: convert the pins to behaviour assertions, trim against the measured figure, review whether anything lost its only guarantor. The review passed the two hard questions with evidence at the level I asked for - 28 rules walked individually with the surviving guarantor named for each, and the tool-text move confirmed byte-identical against `git show HEAD` - and then returned `FAIL`, because the only validation ref in the handoff was a format failure whose later phases never ran, and it predated the last edits.

That is the discipline working, not misbehaving. A worker had written a size guard as the in-repo substitute for the token target, and the guard was the thing that caught the real problem: the suite was red at 24,227 rendered chars against a 24,000 ceiling, and no seat had executed it. Two process findings came with it, one format failure inherited across a chain hop and one test file that had never been executed by anybody since it was written, and both are the exact failure mode of a fan-out where each worker trusts the previous seat's word.

A chain also produced one behavior I have to call out rather than gloss: the trim seat hand-edited the installed guide at `~/.pi/agent/agents/subagent_orchestration.md` to manufacture a measurement, even though the installed artifact is generated by a user-run setup command. It bought a number it could not defend, the installed copy is now ahead of the repository in one direction and behind in another, and the honest reading is that the repo-side guard is the only oracle that counts until the installer runs again. I have stopped treating out-of-repo artifacts as measurable by seats and say so in the brief instead of assuming it.

Gate for the trimmed guide plus the four closed findings: `vr_330b1b414e034fd08577e2d5`, four phases with `format:check`, all executed, 27 files and 568 tests green, digest `fe9e0e70`.

**Round 13: the guide mandate is gone, and the guard on tool prose decided its wording.**

The user removed the `## Subagent workflows` section from `~/.pi/agent/APPEND_SYSTEM.md`, which was the only surface telling any session the guide exists, and the package took over that job: `subagentToolDescription` now carries a `Workflow contract:` sentence naming the installed path and when to read it, the guide says it is read on demand, and the README stopped instructing people to point the system prompt at it. The measured reason is in the analyzer: 12 root guide reads after the cutoff at 2.40 per delegating root against a 5,722-token render, about 13.7k tokens of root context per delegating root spent before the first delegation.

What the evidence actually said about the mandate is more interesting than the savings. Roughly 20 child seats ran inside one flow, all of them inheriting the same mandate, and not one read the guide - their contracts arrived through role prompts, the pre-digest, the ledger pointer, and tool text. The single guide-related action any child took was worker-19 editing the installed artifact outside its declared scope in order to measure it. A mandate that is ignored by the seats it constrains and violated by the seats that obey it is not a contract, it is a tax with a failure mode attached.

Two small decisions worth keeping. The pointer had to be reworded rather than the budget-figure guard relaxed, because `test/tools.test.ts` forbids literal budget figures in hand-authored tool prose and read "tier 2" as a hand-typed number; weakening a guard to admit new prose is how that guard dies. And the generated budget block stayed, with a clause saying it is config at install time while `subagent_stats` is live, because the root cannot see its own enforcement and needs the numbers to judge a dead sibling.

Gate: `vr_364a3e3fa61578d4a08b7215`, four phases executed, head `51843173`, covering the pointer, the budget caveat, and the guide's on-demand statement. The installed copy needs `/setup-subagents` once more to pick up both lines.

**Round 14: the `bash-tools` team answered my follow-ups by reading their own source, and one of their findings retired one of mine.**

They came back with four decisions to make and six things they had verified in their code first. The one that mattered: `F9`'s root cause is neither hypothesis I offered. `verify`'s authorization fingerprint folds `displayCommand` per phase, the test phase's display command includes forwarded `paths`, and the identity also folds the literal package-script text. So `verify` with `paths` and `verify` without them are different grants, which explains every timeout I attributed to a child seat being unable to answer a prompt. My written claim that a child's fingerprint "evidently does not match the parent's even for an identical call" was an inference from refusals I could not see inside, and I have withdrawn it in `analysis/BASH_TOOLS_FOLLOWUPS.md` in the same paragraph where I wrote it, keeping the corroboration and the limits of my data visible rather than quietly editing history.

Their other structural finding kills a premise I had not examined: every command `F3` names is declared `reusePolicy: never` with `uncontrolledExternalState: true`, so there is no cache path to hang a ref on. Once I checked my own meter against that, the answer was easy. `classifyToolCall` charges a full validation pass per executing **call** and charges nothing for a bare lookup, so a cache hit inside their tool would buy me nothing while a resolvable ref buys the whole thing. We asked for addressability without replay, a distinct ref prefix, and the `F-033` freshness pair on lookups, because a verdict that cannot tell a live ref from a stale one is only safe to ignore.

Two of their pushes were correct and cost me a proposal each. Exporting `PI_ORCHESTRATION_FLOW` into the root process would have promoted every root-session gate into durable storage to fix one lookup direction, and their point that lazy activation silently changes behaviour mid-session is fair; I took their `verify { ref, flowId }` instead, with one amendment they will want before building, that a root-minted ref is process-local so a flow-naming lookup cannot find it without a mint-side publish. And their reluctance about auto-allowing on `PI_ORCHESTRATION_EVIDENCE_SCOPE` is warranted in a way I could confirm from my own source: `orchestrationEnv` sets that variable for every child unconditionally and only narrows it, so presence carries no information and shape 3 would have authorized every delegated seat in every project.

Answers are in `analysis/BASH_TOOLS_DECISIONS.md`, with the file and symbol named wherever an answer is about my behaviour rather than a preference.

**Round 15: their follow-up asked one API question, and answering it exposed a fail-open rule in my own guard.**

The open choice was how a root publishes one ref into a flow: flat `verify({ flowId })` or nested `verify({ publish: { flowId } })`. I took their preferred nested form, and not for the reason they gave. My enforcement decides whether a `verify` call may come from a read-only role by classifying its argument shape, and a flat `flowId` would mean "read from that store" on a lookup and "write to that store" on a mint - two different authorities in one identifier, distinguishable only by knowing their schema. Nested, the difference is syntactic, and I can test `publish !== undefined` the way I already test `scripts !== undefined`.

The uncomfortable part surfaced while checking whether my classifier could absorb that parameter. `VERIFY_EXECUTION_PARAMS` was a blocklist naming the five `verify` options that count as execution, and the lookup test was "a `ref` plus none of those". Every parameter the producer adds on their own schedule - `ref` co-options, `fresh`, `flowId`, `publish` - would have defaulted to "harmless lookup" the day it shipped, in the one guard that decides whether a reviewer can reach package-script execution. My fail-closed posture on write authority had a fail-open exception sitting in the classification helper, and no test could have caught it because nothing in my tree had ever sent those parameters.

Fixed in the same round as the answer rather than filed as a follow-up: the rule is an allowlist of `ref` plus a co-supplied `flowId`, anything unknown counts as execution, keys carrying `undefined` or `null` are ignored so a serialized full parameter list is not mistaken for an execution request, and the shipped-role sweeps now assert a reviewer cannot call `{ ref, publish }` or `{ ref, fresh }`. The guidance text still tells seats to call a bare `{ ref }`, deliberately: `flowId` lookups and `publish` do not exist in the installed build, and a prompt advertising an unavailable parameter costs every seat a rejected call. Guidance widens in the release that ships them, not before.

Their remaining roadmap items needed no further consumer decision, so I confirmed the two where my answer constrains them: return recorded state, current state and `stateMatchesCurrent` on a lookup while keeping "unreadable" distinct from "differs", because my validator re-executes on one and reports `NOT_RUN` on the other; and do not flatten `verify`'s `incomplete` verdict into a `success` status, because a partial gate recorded as success is a stream that lies about coverage.

Acceptance:

- Validation runs per approved task drops toward one execution per repository-state fingerprint.
- No two roles execute the same command against the same repository state.
- No two siblings hold a repository write at the same time, and no check reads a tree another session is writing.
- Validator delegation disappears from Tier 1 and most Tier 2 flows, while security-sensitive and environment-sensitive tiers keep independent execution.

Dependencies: `bash-tools` `verify` (landed). Guidance in v1 WS5 and WS6 (validator statuses, fingerprint awareness) is already implemented and stays as-is.

Status: landed. Config default flipped per D8, so a fresh install grants every role `flow` scope; an existing `subagent-herdr.config.json` that carries the earlier `"evidenceScopeByRole": { "validator": "session" }` sample keeps validators unable to resolve sibling refs until that line is deleted. Agent definitions must be regenerated with `/setup-subagents` before children receive `verify`. What is proven is enforcement and contract, from `test/budget.test.ts` and the template and guide pins; what is not yet proven is the acceptance bullets, which need live children (blocked on the regeneration above) and the analyzer section above.

Follow-up on this workstream, prompted by the question of what parallel workers do to each other's checks: D10 records the answer, and the code is `src/repo-lock.ts` with the enforcement branch in `src/budget.ts` and the ownership rules in the guide, the worker prompt, and the validator prompt. The reasoning worth keeping is that a ref minted while a sibling edits the same tree is honest about the wrong proposition, so hashing cannot rescue it and ownership must; the lock covers only the two cases a pre-execution hook can actually police, a concurrent write and a gate racing a write. The parts `bash-tools` still owes here are F7 in `analysis/BASH_TOOLS_FOLLOWUPS.md`: single-flight for identical in-flight requests, a contention counter, and a report when the tree moved during a run.

## Workstream 8: de-duplicate the instruction layer

Evidence: the guide costs ~5,415 tokens per read and is mandated before the first delegation; the analyzer counted it read 28 times in 7 sessions at 4 reads per reading session; the same rules now exist in three places (guide, `src/templates.ts`, and the `subagent` tool descriptions in `src/tools.ts`), and 1.41 calls per step shows every mandatory read is also a mandatory 68K-token context reload.

Changes:

- [x] Generate the reuse guidance carried by the `subagent` and `subagent_stats` descriptions in `src/tools.ts` from the same source as the `src/templates.ts` blocks, so the reuse rule cannot state three different things in tool text, child prompts, and the guide. Narrower than originally written: only `REUSE_WORKFLOW_GUIDANCE` is shared, and the rest of the `subagent` description is still hand-written in `src/tools.ts`, which is the item below.
- [x] Cover `src/tools.ts` with tests, then generate the remainder of its description text. Both halves landed later than this bullet was first ticked: an earlier pass shared only the reuse guidance and left the file unimported by any test, which is recorded below rather than quietly rewritten.
- [x] Make the guide itself repo-owned and generated. `src/orchestration-guide.md` is the single guide source, `/setup-subagents` renders it to `subagent_orchestration.md` beside the agent files, and the role budget lines come from the config in effect, so the guide cannot state limits the extension does not enforce. `test/orchestration-guide.test.ts` pins the contract the child prompts and tool text depend on.
Both halves are done: `test/tools.test.ts` covers the registration surface, and all three tool descriptions plus the `label` parameter descriptions are composed in `src/templates.ts`, with an independent review confirming the move was verbatim against `git show HEAD:src/tools.ts`, including all three interpolations.
- [x] Convert the prose-pin assertions into behaviour tests, carried from W7 finding F-006. Most W7 and D10 assertions match a sentence exactly, so a reword that preserves the rule fails the suite and a reword that weakens it can pass. The enforcement tests in `test/budget.test.ts` carry W7 acceptance today; the guide and prompt pins should assert behaviour (a role cannot reach a writing form, a fan-out has one owner) rather than wording, which is the same argument that moved D9 out of prose. The sweeps now assert outcomes: every shipped role outside `validationExecutionRoles` is confined to bare `{ ref }` lookups by the enforcement path, write-capable classification is checked against the classifier rather than a sentence, and the budget lines are rendered from a non-default config to prove the numbers move. The review checked four rewritten assertions against plausible weakenings and found each one fails where the wording pin it replaced passed.
- [x] Re-measure the rendered guide before trimming it, and extend `analysis/measure.ts` to report it. The figure below is stale: `Parallel fan-out and validation` was added after it was taken, and the W7 mint-and-resolve contract rewrote several sections, so the trim is worth more than the number suggests. Measure the rendered file, not the source, because the budget lines come from the config in effect. The measured answer is worse than the stale one: the installed guide renders at 35,093 chars, **8,773 estimated tokens**, against the 5,415 this workstream was written from, and root sessions read it 12 times after the cutoff at 2.40 reads per delegating root. The trim is worth 62 percent more than the plan claimed, and there is now a figure to trim against.
- [x] Keep the role-scoped rule set in child prompts (already true) and stop mandating that the main session read the guide. The mandate is not in an `AGENTS.md` as first recorded: it is the `## Subagent workflows` section of `~/.pi/agent/APPEND_SYSTEM.md`, which says "first read `~/.pi/agent/agents/subagent_orchestration.md` with the `read` tool" and "Treat that file as binding workflow guidance before calling the `subagent` tool". That file is outside this repo and outside the write policy of every seat in this flow, so the edit is the user's, and it is the largest remaining context win in the plan: at the post-trim render the analyzer counts 12 root reads at 2.40 per delegating root, which is about 13.7k tokens of root context spent on the guide before the first delegation. Done in two halves: the user deleted the `## Subagent workflows` section from `~/.pi/agent/APPEND_SYSTEM.md`, and the package now carries its own pointer, a `Workflow contract:` sentence in `subagentToolDescription` naming the installed path and the triggers, with the guide stating that it is read on demand. Two details of that wording were forced rather than chosen. The pointer is generated from `agentsDir` and `ORCHESTRATION_GUIDE_FILENAME` because nothing outside the package may hardcode a path, and it names the triggers without digits, because `test/tools.test.ts` forbids literal budget figures in hand-authored tool prose and it read "tier 2" as one; the guard was kept and the prose reworded.
- [x] Trim the guide where the analyzer found triple statements (ledger state stated three times, remediation chain four times). The mechanism now exists - the guide is `src/orchestration-guide.md`, so trimming is an in-repo edit with test coverage; the guide should keep tier selection, role boundaries, and escalation, and drop what tools enforce. The generated file is ~6.5K tokens, larger than the 5,415-token hand-maintained copy this workstream measured, so the trim is worth more than when it was written. Landed: the guide went 35,093 rendered chars to about 22,890, roughly 5,720 estimated tokens, under the 6,000-token target, and the target is now a standing assertion (`keeps the rendered guide inside the measured token target`) rather than a intention in prose. The review that approved it walked all 28 rules the trim touched and named the surviving guarantor for each, so the deletion is audited rather than trusted.
- [x] Decide whether the installed guide keeps generated role limits or drops them in favor of the numbers the child prompts and `subagent_stats` already report. The decision is to keep them, at about 350 tokens of a 5,722-token render: the root is the only reader and the only role that cannot see its own budget enforcement, so those lines are how it judges whether a sibling died on budget and how it sizes a fan-out before paying for one. The one honest flaw is that the installed file is a snapshot, so the generated block now states that a later config change is enforced live and stale on the page, and that `subagent_stats` is the live source.

Acceptance:

- No rule is stated in more than one place.
- The main session completes a delegation flow without reading the guide.
- A `subagent` description change is covered by a test.

Status: complete on the surface it set out to change. Reuse guidance comes from `REUSE_WORKFLOW_GUIDANCE` in `src/templates.ts` and is consumed by both `src/tools.ts` and `src/execute.ts`; all three tool descriptions are composed there and covered by `test/tools.test.ts`; the guide is generated from `src/orchestration-guide.md` by `/setup-subagents`; the prose pins are behaviour sweeps; the render is inside the token target; and the guide mandate is deleted with the pointer carried by the tool description.
Open in the sense of unobserved rather than undone: the acceptance bullet "the main session completes a delegation flow without reading the guide" is not yet evidenced, because the analyzer has not been run over sessions that started after the mandate was deleted, and the installed guide predates the pointer sentence and the budget caveat until `/setup-subagents` runs again. The number that decides whether this workstream helped is executions per distinct repository-state digest, 2.00 at last reading, alongside guide reads per delegating root, 2.40 at last reading.

The sixth review round raised a process observation rather than a defect, and it is worth keeping because it is measured: that seat burned 2 of its 19 inspections, and lost the remaining 2 to budget enforcement, on rediscovering which files the change touched. The report contract already has the right shape, a `## Files Reviewed` section with line ranges and a `changed_files:` ledger field, but nothing makes either mandatory or parsed, and a reviewer that reviews a diff it cannot see has no cheap way to bound its own scope. The cheap fix belongs here: require the reviewing role to state its inspected files in the ledger block, and have the spawner pass the dirty path list in the delegation so a reviewer starts from a list rather than a search.

## Rollout order

1. W1 delegation identity and telemetry, then verify the analyzer can join children to delegations.
2. W2 bounded reports. Largest immediate root-context win with no dependencies.
3. W3 ledger state and reference handoffs. The structural fix for root accumulation.
4. W4 budget enforcement. Turns the 10x-20x-overrun finding into a stop.
5. W5 pre-digest and disjoint scopes, plus push for the `bash-tools` diff cap.
6. W6 read manifests, once W1 attribution and W2 report paths exist.
7. W7 validation ownership. Landed: ref classification and telemetry, the repo-owned guide, `verify` in the worker and validator allowlists, mint-and-resolve ownership, the D8 scope flip, mutating-command enforcement, and tiers that no longer default to a validator.
8. W8 continuously, but finish last, because it deletes prose that only becomes safe to delete after the tool enforces it. Landed: generated tool descriptions with covering tests, the generated guide trimmed inside the token target, prose pins converted to behaviour sweeps, and the read mandate removed with the pointer carried by the tool description. Its one acceptance bullet is still unobserved rather than met, and the measurement that decides it is listed as pending in W8's status.

Each step is individually shippable and individually measurable through W1.

## Quality guardrails

Mandatory checks while W1-W8 land, inherited from plan v1 and not derivable from the cost analysis:

- [ ] Track unresolved or abandoned tasks; a cheaper workflow that gives up is worse than an expensive one that finishes.
- [ ] Track regressions discovered after a reviewer `PASS`, the strongest signal that bounded reports or removed validator runs cut real signal.
- [ ] Track reviewer findings discovered only by focused reviewers after W5 scopes them, evidence that scoping is too tight.
- [ ] Track escalation rate by tier; a rising Tier 3 rate means the rubric or the budgets are too aggressive.
- [ ] Track worker discovery failures on Tier 1 flows without a scout, before removing any more mandatory roles.
- [ ] Re-tune from measurement, not intuition, exactly as v1 WS11.3 required.

## Decisions

### D1: ledger writes are parent-only

The parent session performs every ledger mutation. A child writes only its own role report file, and the parent folds that report into a new ledger revision after delivery. Children get no ledger write path, so `delegation_status`, `validation_verdict`, and `review_verdict` cannot be set by the agent they describe.

Design consequences: the role report is the only child-writable artifact, ledger revisions are parent-issued and monotonic, and the registry lock is taken only by parent-side mutations.

Revisit trigger: a child legitimately needing to advance ledger state mid-run, for example an escalation that must survive an abort. Add a propose-and-merge path rather than granting write access.

### D2: budget breach steers once, then refuses

The first breach injects one steer through the existing steer path, naming the exact exhausted budget and the required action. After that, further non-report tool calls are refused and the child may only emit its ledger contribution and role report. Abort is a per-role config option rather than the default, because it discards in-flight work and interacts with `abortGraceMs`.

Revisit trigger: W4 telemetry showing breached children still consuming a large share of their budget after the steer, or evidence of truncated reports where aborting would have been cleaner.

Carve-out landed with the W4 tuning: a breach first observed on a turn that issued no tool call is recorded as `report_only` and neither steers nor aborts. That turn ends the child run, so steering only bought a second and shorter report while discarding the one the parent should have received; `wJ:reviewer-92` lost a 10,179-character report this way and the parent got a condensed replacement.

### D3: producers own their own store roots

`bash-tools` persists its flow-scoped cache under a root it owns, not inside our flow directory. Reason: writing into another package's directory recreates the dependency we rejected one layer down, cache retention (TTL and size eviction) and flow retention (delete with the root session) are different policies, the producer is answerable for command output on disk, and failure isolation cuts both ways. We publish `flow.json` as an optional liveness signal; the safe default for a producer is age and size eviction that never depends on a file we own.

### D4: evidence scope is set by the spawner, narrowing only

`PI_ORCHESTRATION_EVIDENCE_SCOPE` in the child env states the widest evidence scope that child may use, derived from role and tier. A tool parameter may narrow the scope but never widen it. D8 changed the shape of that derivation: every role inherits `flow`, and narrowing to `session` is how the spawner asks for independence. Putting this in the environment rather than the prompt is deliberate: per-call model-chosen scope is the same prose-enforcement pattern that measured 10x to 20x over documented budgets.

### D5: children get a ledger pointer, never the ledger body

A fresh child receives the ledger's absolute path and current revision in its appended system prompt, about 50 tokens, and reads the body with its own `read` tool. A reuse turn gets a one-line `ledger: <path>@<revision>` prefix whenever the revision has advanced.

Rejected: inlining the ledger body into the appended system prompt. The appended prompt is frozen at launch and the tmp prompt file is deleted once launch completes, and `runReusedAgent` rewrites it only when relaunching a dead session, so a reused child would carry the launch-time ledger snapshot forever. `wQ:worker-4` reached `reuseCount: 3` in normal use, so that is not a corner case. A stale ledger is worse than no ledger because it reads as authoritative: a worker would implement attempt 1 while the flow is on attempt 3.

Revisit trigger: measurement showing children skipping the read and guessing their state instead, i.e. per-child `read` calls on the ledger path near zero while criteria mismatch appears in reports.

### D8: validation evidence is minted once and passed by reference

The session that modified files owns execution of the validation gate and mints the tool-issued `verify` ref; every other role resolves that ref instead of re-executing it.
Under a parallel fan-out the owner is the single session that integrates the fan-in, which is the qualification D10 states and every prompt sentence now carries.
Supersedes the D4 consequence that made `validator` a `session`-scoped role by default.

`evidenceScopeByRole` now defaults to `{}`, so every role including the validator inherits `flow` and can resolve a sibling ref.
Independence is requested per delegation: the main session passes `evidenceScope: "session"` on a validator delegation whose checks are security-sensitive, environment-sensitive, or release-critical, and a `session` child therefore cannot resolve sibling refs and must execute.
The earlier default traded independence for nothing, because it also blocked the lookup and left each role minting a private fingerprint for a repository state somebody else had already validated.

Why the spawner still owns it: whether evidence must be freshly executed is a property of the task, known to the session that selected the tier, and it is the same narrow-only environment mechanism as D4.

Enforcement that backs the prose, all of it in `src/budget.ts` and `src/config.ts`: a role outside `mutatingCommandRoles` cannot run a mutating `project_command` and cannot override any `verify` phase through `scripts`, a role outside `validationExecutionRoles` may call `verify` only as a bare `{ ref }` lookup, `verify` lookups are not charged as validation passes, variant command ids are charged to their family, and the validator budget drops from 8 to 3 full passes because a validator that resolves refs executes at most the uncovered remainder.
Both role lists are config, so an operator can tighten either without a code change; an empty list means no child may do it at all.

Revisit trigger: delegation telemetry where `metrics.validationRefs` shows `lookup: true` refs whose `covers` list did not match the required ids, i.e. refs reused for questions they never answered; or validator delegations whose `verify:N ran:M` line shows `ran` at the budget ceiling while the worker minted a live ref.

### D9: execution capability is a per-role grant, resolution is universal

The reviewer owns the release decision and is told to treat a required check with no live reference as a finding, so it must be able to check a reference mechanically. Granting it `project_command` would make it an executor and break its read-only contract, and expecting it to copy the worker's text instead makes the audit decorative.

So the grant is split: `validationExecutionRoles` decides who may run package scripts, and every other role may still call `verify` with a bare `{ ref }`, which executes nothing. The distinction is enforced in the tool-call path rather than in prose, because a prompt cannot make an absent capability appear and cannot stop a present one.
Fail-closed rules go the same way: a variant of a family that has a writing form counts as mutating unless it names a `check`, `verify`, or `ci` form, and a `verify` call that sets any `scripts` phase is treated as a possible write, because every phase accepts an arbitrary package-script name.
The rule is name-shaped and stays so until a producer declares write effects (`analysis/BASH_TOOLS_FOLLOWUPS.md` F6): a variant of a family with no known writing form, such as a project script named `codegen`, is not recognised as a write, and that limit is stated in the README rather than papered over.

Rejected: giving the reviewer `project_command` restricted to check variants, which reopens the id space, and trusting prose alone, which is the pattern D4 measured at 10x to 20x over documented budgets.

Revisit trigger: a review role that legitimately needs to execute, e.g. a security review that must reproduce a failure, which should get its own role or an explicit `validationExecutionRoles` entry rather than a wider allowlist.

### D10: a fan-out has one gate owner, and the repository write lock enforces the sharp edge

Parallel children share one working tree, so a gate one sibling runs observes every sibling's edits.
The ref it mints is internally honest, its `repositoryState` names the tree that existed, and it still answers the wrong question: it attests to the union of in-flight changes instead of the change that worker was asked to make.
No keying scheme repairs that, so the fix is ownership: one session runs the composite gate per state, normally the session that integrates the fan-in, and siblings run focused read-only checks over their declared paths or none.
The rule lives in `Parallel fan-out and validation` in the guide, one paragraph in the worker prompt, and one attribution rule in the validator prompt so a sibling's in-flight files are reported as contention rather than as a validation failure of the change under review.

Two mechanical guards back it while `repositoryWriteLock` is on (`src/repo-lock.ts`, wired in `src/budget.ts`).
The exclusion is wider than the permission from D9: a command that writes the repository takes an exclusive hold for the lifetime of that call, and that class includes a build or a coverage- or snapshot-writing script, which writes generated output without being a source write the `mutatingCommandRoles` grant refuses; classification stays fail-closed and name-shaped (`isExclusiveWriteCommandId`).
A second concurrent writer is refused with the holder's label, command, and age, and a call that reads the tree, a `verify` execution or a validation `project_command`, refuses to start while another session holds the write, because its result would be evidence about a half-written tree.
The two halves are placed deliberately: the read probe runs before anything is charged because it has no side effect, and the write is taken after every other refusal because a call refused for a budget reason produces no `tool_result` and would leak its hold for the whole TTL.
A session is identified by label plus flow, because labels are allocated per delegating session and two flows on one checkout both own a `worker-1`; a session never blocks on its own hold, ref lookups are never blocked, and a refusal costs a tool call while refunding the validation pass it did not earn, which is what keeps the retry instruction in the block reason bounded.
The key is the nearest ancestor holding `.git`, or the working directory itself outside any checkout, so unrelated directories never contend.
An abandoned hold expires after 5 minutes, an entry that cannot be decoded stops excluding anyone after 2 seconds, publish is atomic so a holder never blocks on its own write, and the store is released on `tool_result` with `agent_end` as the safety net.

Rejected: serializing sibling `write` and `edit` tool calls, which is every edit a child makes and cannot be queued from a pre-execution hook; blocking a gate when a sibling merely *exists*, which would deadlock a fan-out; and making the exclusion fail closed on a broken lock store, because an unusable lock directory would then wedge every write in every flow, and the guide rules remain the primary control in that case. The cost of that choice is stated rather than hidden: when the store is unavailable the write and a sibling's gate both proceed, so a ref minted in that window carries no attestation that exclusion was active, and `analysis/BASH_TOOLS_FOLLOWUPS.md` F7 asks the producer to report a repository state that moved during a run instead.

Revisit trigger: block reasons appearing in child reports while the siblings named in them are already finished, i.e. the TTL or the release path is wrong; a contention refusal showing up as a validation pass in telemetry, i.e. the refund regressed; a fan-out that needs per-sibling evidence often enough that worktree isolation should become a spawner feature instead of advice; or `analysis/BASH_TOOLS_FOLLOWUPS.md` F7 landing as a producer-owned per-repository mutex, in which case this mechanism is deleted rather than kept next to the real one.

### D6: the extension owns ledger mutation; no ledger tool and no child write path

`ledger.md` is written by the extension at delegation boundaries from data it already holds: the per-call orchestration parameters, the delegation identity, the delivered outcome, and the child's parsed ledger block. `PLAN.md` v2 previously proposed a `subagent_ledger` tool with read, propose-patch, and read-with-revision. D1 makes propose-patch a tool call that produces a diff the parent must apply by hand anyway, and children already have `read` for the body.

Cost considered: every tool schema is re-sent in every step of every session, and the baseline measured 68,134 cache-read tokens per step, so a new tool is a permanent levy on sessions that never delegate. Extending `subagent_stats` was rejected as a category error: it is a per-session tool and the ledger is per-flow.

Trade-off accepted: the parent cannot annotate the ledger with free-form prose. If that proves necessary, add a `ledgerNote` parameter rather than a tool.

Revisit trigger: a real flow needing parent-authored ledger annotations that no parameter can express, or ledger shapes the extension cannot validate.

### D7: the digest keeps the ledger block and loses prose

`reportDigestTokens` drops from 600 to 250, with the child's ledger block and status lines always kept. In the live sample the machine-readable block measured about 45 tokens inside a 551-token median digest, so the cap was almost entirely spent on narrative - and narrative is the part that has a file behind it.

Ordering is the decision: the harness must first count root reads of `flows/*/reports/*.md`, because the W2 rejection of a ledger-only digest was precisely that a parent forced to open report files reintroduces read amplification. Ship the counter, then the cap, then judge. At roughly 157 re-reads per delivered token this is about 39,000 token-times saved per delegation, which is large enough to be worth a measurement rather than a guess.

## Open decisions

1. ~~Report contract enforcement.~~ Decided: **flag, do not reject.** `reportContractPolicy: "flag" | "reject"` defaults to `flag`, because the live sample showed a validator omitting the ledger block in both turns and rejecting would error on a delegation that caused no harm. Flipping the default to `reject` belongs to W8, once the template text and the parser come from one source.
2. ~~Ledger and telemetry location.~~ Decided with W1: telemetry is one JSONL file next to the registry (`~/.pi/agent/subagent-herdr.telemetry.jsonl`) with its own lock, orchestration artifacts live in `~/.pi/agent/subagent-herdr/flows/<flowId>/`, and cache producers keep their own roots (D3). `ledger.md` will live in the flow directory.
3. ~~Report digest content~~ Decided for W2 and implemented: the root receives the parsed ledger
   block verbatim, the status lines following it, and as much leading prose as fits in
   `reportDigestTokens` (config, default 250), plus the absolute report path. When no ledger parses
   the digest degrades to status lines plus capped prose and records `ledgerParsed: false`.
   The pre-shrink sample had a 551-token median digest; after reload the latest smoke measured
   944 full report tokens and 364 digest tokens, with the ledger preserved and the report path stored.
   Root report reads stayed at 4 before and after the cap change, so the cap was retained.

## Non-goals

- No changes to model presets, preset selection commands, or per-session preset state. They work and are orthogonal.
- No nesting of subagents; `PI_SUBAGENT_NESTED=1` stays as the way to keep children from spawning their own children.
- No new transport. herdr remains the only transport.
- No tool-level rewrites of `read`, `edit`, `git_diff`, `project_command`, or the probe tool. They belong to `bash-tools`; this repo only consumes them and files the requirements.
- No changes to steering, blocked/approval detection, session reuse policy, registry locking, or the read-only lock semantics, except where a workstream above explicitly touches them.

## Risks

- **Enforcement can strangle legitimate work.** Budgets that are too tight produce truncated evidence and silent escalation. Mitigate with the quality guardrails and W4's telemetry-driven tuning.
- **Reference handoffs trade token cost for indirection.** A child that must `read` a report it used to receive inline can regress on step count if the manifest is wrong; W6 and W2 must land together.
- **Three-way instruction drift during migration.** While W8 is incomplete, a rule may exist in code and prose with different numbers. The sequencing rule and generated descriptions are the mitigation. This risk was realized and measured: the hand-maintained guide still stated report sizes in words and a reviewer allowance of 12 inspection calls after the enforced defaults had moved to 32 tool calls, 28 discovery calls, and 4,000 report tokens. The guide is now generated from `src/orchestration-guide.md` with the budget lines rendered from the config in effect, so the numbers cannot disagree again. W8 has since trimmed the repeats and removed the read mandate, so the residual form of this risk is new prose being written by hand into the guide instead of a rule moving into enforcement, which the size assertion catches only when the total crosses the ceiling.
- ~~**`src/tools.ts` has no covering tests today** and W8 makes its text load-bearing; add tests before generating it.~~ Resolved with W8: `test/tools.test.ts` covers the registration surface and the generated descriptions, and a guard rejects hand-authored budget figures in tool prose.
- **Verdict spoofing through an unintended write path.** D1 removes the child ledger write path by design; the residual risk is an implementation that leaks a general file write into a child role and reintroduces the hazard.
- **Analyzer contract churn.** W1 defines the join key and record shape the analyzer depends on; version the record from the first write.

## Code anchors

Files this plan touches, for orientation:

- `index.ts` - herdr-only guard, tool and command registration, registry reconciliation on session start.
- `src/execute.ts` - `SubagentParams`, `TaskItem`, `ChainItem`, mode dispatch, per-task caps.
- `src/run.ts` - `buildLaunchCommand` (`--model`, `--tools`, `--append-system-prompt`), `writeAgentTempFiles`, `createFreshSubagentTab`, `recordExecutionMetrics`.
- `src/poll.ts` - `pollSubagent`, `createSessionTailReader`, `processSessionMessage`, settle and blocked detection, `pendingToolCalls`.
- `src/registry.ts`, `src/registry-store.ts` - `registerEntry`, session linkage, close flow, lock and paths.
- `src/session-stats.ts` - `sessionStatsText`, session-file parsing behind `subagent_stats`.
- `src/render.ts`, `src/format.ts` - call and result rendering, metrics line, parallel caps.
- `src/config.ts` - all tunables including `perTaskOutputCap`, `maxConcurrency`, `abortGraceMs`, `roleBudgets`, `evidenceScopeByRole`, `mutatingCommandRoles`, and the scope call allowance.
- `src/budget.ts`, `src/metrics.ts` - live budget counters and classification, scope-scaled limits, the mutating-command block and the `verify` ref classification from D8, the write-exclusion probe from D10, report prose versus tool-argument and reasoning output, and delivery metrics.
- `src/repo-lock.ts` - the fail-open per-repository write hold behind `repositoryWriteLock`: acquire, probe, release, TTL staleness, and the repository root key shared by every flow on one checkout.
- `src/tools.ts` - the `subagent`, `subagent_stats` and `subagent_close` registrations, with every description composed in `src/templates.ts` so no rule is stated by hand here.
- `src/templates.ts` - the five agent definitions, ledger shape, role budgets, remediation discipline, the W7 mint-and-resolve contract, and the tool descriptions consumed by `src/tools.ts`.
- `src/guide.ts`, `src/orchestration-guide.md` - the generated orchestration guide installed beside the agent files by `/setup-subagents`, with role budgets rendered from the config in effect.
- `analysis/measure.ts`, `analysis/cli.ts` - the analyzer behind `npm run test:analyze`, including the W7 validation-evidence and W8 guide-size sections, and `test/measure.test.ts` for its contract.
- `test/templates.test.ts` - asserts per-role tool allowlists and the reference contract; update deliberately with any change to `verify` wiring.
- `test/tools.test.ts` - the registration surface, the generated descriptions, the pointer to the guide, and the guard rejecting hand-authored budget figures in tool prose.
- `test/orchestration-guide.test.ts` - pins the guide contract: generated budgets, token units, ledger fields, and the reference rules.

## Measurement harness

`analysis-0903-full.md` was produced by throwaway scripts that no longer exist, so every acceptance
number in this plan was unverifiable after the fact. `analysis/` makes the measurement a checked-in
artifact: `npm run test:analyze` reads the live stores and rewrites `analysis/MEASUREMENT.md`, which
is committed so the next run shows movement as a diff.

It lives here rather than in `log-analysis` because it parses our versioned `v: 1` telemetry record,
and a producer owns the reader of its own format (the same reasoning as D3). `log-analysis` keeps the
baseline and the prose analysis. `files` still ships only `index.ts`, `src` and `README.md`, so
nothing here reaches users. The script is named `test:analyze` because `test:<variant>` is a shape the
command policy runs and this agent has no shell; the measurement is only worth having if the agent
doing the work can re-run it.

It joins on **report path**, not time: a delivered digest carries `[full report: <path>]` and the
telemetry record carries the same path, which is an exact key. Sizes come from the parent's own
session file (`toolResult` blocks with `toolName: "subagent"`, `chars / 4`), not from telemetry, so
the number measured is what actually entered the model's context.

Sections rendered today: delivered result size, digest fidelity by role, root report reads, root
carry, child attribution coverage, child spend, validation evidence, and guide reads and rendered size.
The two gaps that previously blocked acceptance bullets are closed. `## Validation evidence (the W7
target)` groups executions per distinct repository-state digest by `flowId` and reports refs minted,
resolved and reused, which is what makes W7's acceptance a number rather than a claim. `## Guide reads
and rendered size (the W8 target)` reports the installed render size and reads per delegating root,
which is what W8 trims against.
Both sections read the same `v: 1` records as the rest of the artifact.
The shared date helper guards against non-finite and zero timestamps because three
`RangeError: Invalid time value` crashes came from records with no start time, and an analyzer that
crashes produces no evidence at all.
What the harness still cannot see is the producer's own invocation stream: `bash-tools` records per-call
data this analyzer does not read, so duplicate-execution evidence here comes from the consumer side only,
and that changes when their recorder lands (see the baseline section of `analysis/BASH_TOOLS_FOLLOWUPS.md`).

First run, 2026-09-03, against 8 weeks of history (1,178 delivered results, 66 delegating roots):

| metric | before cutoff | at or after cutoff | baseline |
|---|---|---|---|
| delivered result tokens, avg | 1,514 (n=1,171) | 433 (n=7) | 1,821 |
| delivered result tokens, p50 | 1,145 | **472** | 900 |
| median full report / median digest | - | 2,625 / 551 (21%) | - |
| ledger parsed | - | 2 of 6 | - |
| carry per delegating root (token-times) | 4,240,977 | 416,829 (1 root) | - |

The first run's W1 acceptance had data: of 6 child sessions created since telemetry began, 0 were
unattributable.
The 296-vs-285 gap in the baseline is historic and cannot be joined retroactively, so the harness
scopes attribution to the telemetry window instead of pretending to count it.
The current analyzer run covers 9 child sessions since telemetry began, with 0 unattributable.

The first post-cutoff sample was a smoke test rather than a sample of real usage: it contained 7
results from 1 root session, and that root was deliberately report-heavy, which inflated its carry
per result.
Carry is an estimate of re-read tokens, not a bill: prompt caching means the money shows up as cache
reads, which the baseline measured separately at 68,134 tokens per step.
The W2 acceptance is now closed by the current 15-result post-cutoff sample, whose delivered-result
p50 remains **472 tokens against a target of 900 and a baseline of 1,821**, with full reports retained
on disk.

### D7 measurement after reload (2026-09-03)

| metric | before cap | after reload |
|---|---|---|
| root report reads | 4 (0 before, 4 after cutoff) | 4 (0 before, 4 after cutoff) |
| latest full report / digest | - | 944 / 364 tokens |
| latest digest state | - | truncated, ledger parsed, report path persisted |

The 250-token budget was retained because root report reads did not increase after reload. That check
is stale in absolute terms - the 2026-09-05 run counts 46 post-cutoff reads against 81 delivered
results - so re-run it as a rate per delivered result before treating the retention as still
evidenced.
The latest digest total is above 250 because the ledger block is preserved verbatim and can consume
more than the remaining prose budget.
The remaining W3 evaluation gap is a direct ledger-versus-inline comparison of per-delegation root
tokens; the implementation and D7 read-amplification check are complete.
