# PLAN.md - subagent-herdr

The active plan is v3 below: simplify and consolidate.
Plan v2 is complete; its outcomes, decisions, and open evidence items are archived at the bottom of
this file.
Plan v1 lives in git history.

# Active plan (v3): simplify the orchestration core

## Purpose

This plan sequences the simplification work identified by the architecture review of the current
codebase, ordered from most to least impact.

Impact is scored as (measured waste removed + correctness risk removed + maintenance burden removed)
divided by (implementation cost + regression risk).

The review's core finding: the simple, synchronous enforcements (digest caps, budget counting)
produced measurable wins cheaply, while the distributed-systems pieces (the repository write lock)
produced nine review rounds, twenty-five findings, and standing fail-open caveats.
This plan acts on that asymmetry: fix the hot write path, repair the one real cache bug, constrain
the delegation decision space, and resolve the lock question on evidence rather than on taste.

Provenance update: the producer's consumer-aligned evidence handoff landed in bash-tools 0.11.7,
verified against the installed package README, the producer repository's PLAN.md, and live lookup
probes.
Every F-item from `analysis/BASH_TOOLS_FOLLOWUPS.md` is shipped, which rewrites two sections of this
plan: S2's gate is evaluated below against what actually shipped, and S5's blockers moved entirely
to the consumer side.

## Relationship to v2

Plan v2 is functionally complete: all eight workstreams are implemented and live-verified, and its
only unchecked items are the six quality guardrails, which are tracking obligations rather than
construction.
This plan succeeds it; v2 is archived at the bottom of this file as the provenance record.
The transition, explicitly:

- v2's open acceptance bullets (the W3 ledger-versus-inline root-token comparison, the W7 validation
  ratios, the W8 "no guide read" observation) are measurement windows, not work items.
  They are served by S5's analyzer join and by ordinary usage, and they stay tracked in
  `analysis/MEASUREMENT.md`.
- v2's quality guardrails remain mandatory and are restated below; the subset telemetry cannot
  answer today (post-PASS regressions, unresolved-task rate) is tracked manually per window until the
  analyzer grows those sections.
- Three deferred v2 items are absorbed here rather than lost: the spawner passing its own dirty path
  list into children lands with S3, whose fingerprinting already computes the dirty set; the two
  report-contract items (mandatory `## Files Reviewed` parsed into `changed_files`, and no flattening
  of phase-level `omitted` into `verdict: passed`) land with S5's evidence-vocabulary work.
  The fourth, the prose-pin conversion, is done per W8's status and carries no residual item.
- The operational prerequisite v2 names - regenerating the installed agent definitions with
  `/setup-subagents` - runs once at the end of S5's guidance widening, so W7's contract and the
  widened evidence surface go live in one regeneration.
- On the producer side, nothing remaining blocks this plan.
  bash-tools' only open roadmap item (R9, curated read-only probes) is optional and theirs, and their
  repository notes uncommitted remediation work, so the S5 guidance pins target the installed build
  and are re-checked at each producer release, per the follow-ups file's own rule.

## Baseline this plan works from

| Signal | Value | Source |
| --- | --- | --- |
| Registry writes | one locked whole-file read-modify-write per child `tool_call`, `tool_result`, and `turn_end` event | `src/budget.ts` `persist()` call sites |
| Registry format | `JSON.stringify(reg, null, 2)`, rewritten in full on every mutation | `src/registry-store.ts` |
| Registry reads | one full read+parse per 1.5s poll iteration per running child | `src/poll.ts` `findEntry` |
| Repo lock | 396 lines, two test files, nine review rounds, documented fail-open limits | `src/repo-lock.ts`; v2 W7 review rounds (archive below) |
| Review surface | written once per flow, never invalidated (`existsSync` gate) | `src/scope.ts` `ensureReviewSurface` |
| Evidence reuse | 5 refs minted, 0 reused, 1.25 executions per state digest, 21 validator passes in 13 turns | `analysis/MEASUREMENT.md` |
| Report reads | 61 root report reads against 119 delivered results post-cutoff (~0.51 per result) | `analysis/MEASUREMENT.md` |
| Delegation yield | 49.0% of role assignments produce no code change (baseline window) | v2 baseline (archive below) |

## S1: repair the registry write path

Highest certainty of payoff, lowest cost, no dependencies.
The registry is currently used as a high-frequency IPC channel: every child persists its full budget
state on every tool event, and each persist is a global lock plus a whole-file rewrite of a
pretty-printed JSON document that grows with every delegation.
With four concurrent children this is dozens of locked rewrites of an ever-growing file per minute,
and it is the one place where a stalled lock wedges every session at once.

Changes:

- [ ] Persist budget state to the registry only on transitions the parent acts on: a breach being
      added, an outcome change (`within` / `steered` / `report_only` / `aborted`), `turn_end`, and
      `agent_settled`.
      The root reads live budget state for two reasons: to detect `outcome === 'aborted'` during
      polling and to render spend in `subagent_stats`.
      Both are served by transition-time writes, because the abort outcome is itself a transition.
      Live per-event counters visible mid-turn are the only thing dropped, and `turn_end` persistence
      keeps those current to within one turn.
- [ ] Stop pretty-printing the registry: `JSON.stringify(reg)` without an indent.
      The file is machine-read on every poll; the human-readable form costs bytes and write time on
      every mutation and is available on demand through `listVerbose`.
- [ ] Memoize the poll-side read: `findEntry` in the poll loop stats the registry first and reparses
      only when mtime or size changed.
      Four concurrent children currently each trigger a full read+parse every `pollIntervalMs`.
- [ ] Count persists per delegation in the budget state and record the count in the telemetry
      record's budget summary, so the reduction is measured rather than asserted.

Acceptance:

- Telemetry shows persists per delegation at or below a small constant (transitions only), down from
  roughly two per tool call.
- `test/budget.test.ts` and `test/poll.test.ts` pass unchanged in behavior: an `abort`-policy breach
  is still visible to the poll loop within one cycle, and `subagent_stats` still reports spend.
- A stall in the registry lock now wedges at most one transition write, not a per-event stream.

Dependencies: none.

## S2: the repository write lock - F7 gate evaluated, verdict is retain-frozen

Revised position after the producer's F7 build landed in bash-tools 0.11.7.
F7 shipped in its alternative shape: single-flight coordination for identical non-mutating requests,
`concurrentExecutions` counts, and `stateDrift` reporting when the tree moved mid-execution.
The per-repository execution mutex was deliberately not built; the producer's README states the
consumer-owned write lock remains the authority for writer-versus-reader coordination.
This plan's original gate asked whether single-flight plus drift reporting are sufficient together.
Evaluated honestly: they close evidence honesty (a gate over a moving tree now reports
`stateDrift: true` instead of silently attesting to a half-written tree) and duplicate read-side
execution, but they do not cover the writer side - two concurrent mutating commands are not
single-flight deduped and would interleave writes - and they do not prevent paying for a doomed gate,
they only mark it after the fact.
That is not sufficient for deletion, and the producer's own documentation says the same.

So the lock stays, frozen at its current converged and review-passed state.
What changes is that the deletion question becomes measurable for the first time: the producer's
invocation stream now records `concurrentExecutions` and `stateDrift` per call, and our telemetry can
record contention refusals, so "does the lock ever fire" is a number rather than an argument.

Changes:

- [x] Freeze: no new features and no review rounds on `src/repo-lock.ts`; defects fixed only on a
      live wedge.
- [x] Teach the role prompts and the guide the drift vocabulary: a result carrying
      `stateDrift: true` is not usable evidence; the seat waits for the sibling to settle and
      re-executes, which is the same discipline the lock's contention refusal already prints.
- [x] Record contention in telemetry: `stateDrift` and `concurrentExecutions` extracted from `verify`
      and `project_command` payloads (lands with the S5 metrics work), plus our own lock refusals.
- [ ] Deletion gate, consumer-side and measurable: delete the module when a full measurement window
      shows zero contention refusals and zero drift-flagged executions across flows, because then the
      guide's ownership rule alone is doing the work and the lock is insurance with no claims.
      If it fires, it is earning its keep and stays.

Acceptance:

- No further engineering time on the lock unless telemetry shows wedges or contention.
- Drift-flagged evidence is never cited as fresh by any role; the guidance states the wait-and-rerun
  rule.
- The delete-or-keep decision is an analyzer readout, not a judgement call.

Dependencies: none. The producer half landed in 0.11.7; the rest is instrumentation.

## S3: invalidate the review surface

The one cache-correctness bug found in this repository.
`ensureReviewSurface` writes `predigest/review-surface.md` once per flow behind an `existsSync`
check, so a fan-out whose tree changes between the first and the Nth delegation hands later children
a stale snapshot labeled as current.
Every delegation already calls it (`launchFreshAgent` and `runReusedAgent`), so the refresh check has
a natural home.

Changes:

- [ ] Fingerprint the snapshot inputs: hash the `git status --short` and `git diff --stat` output
      already computed for the snapshot, store the hex in the document header, and rewrite the
      snapshot when a later delegation computes a different fingerprint.
      Two bounded git calls per delegation is the entire cost.
- [ ] Stamp each snapshot with a monotonically increasing `snapshotRevision`, and record the revision
      plus a `refreshed` flag on the delegation context and in telemetry, so "children saw different
      surfaces" is answerable without diffing files.
- [ ] Keep the write under the existing per-flow lock and the fail-soft posture: an unwritable store
      means no snapshot, exactly as today.
- [ ] Absorb the v2 deferred item: the spawner passes its own dirty path list into the delegation and
      the read manifest, so a worker's in-flight paths are visible to its siblings and a reviewer
      starts from a list rather than a search.
      The fingerprint computation already runs `git status`, so the list is free at the same moment.

Acceptance:

- A fan-out where a worker edits between two reviewer dispatches gives the second reviewer a snapshot
  containing the edit, proven by a live delegation and by a unit test over the fingerprint comparison.
- Telemetry records `reviewSurfaceRefreshed` per delegation; a flow with no tree changes shows a
  single write.

Dependencies: none.

## S4: constrain fan-out composition at the tool boundary

The largest remaining token lever, and the one that addresses "the workflow is still too random" at
its cause.
The review's reading of the baseline data: randomness is downstream of freedom.
The `subagent` tool exposes a wide decision surface (modes, five standard roles, tiers, scopes,
evidence scopes), and nothing enforces composition: validators appear in Tier 1 flows, reviewers fan
out without disjoint scopes, and 49% of assignments produce no code change.
W4 enforced budgets *inside* a delegation; this enforces the *shape* of a delegation, which is the
same "enforce, do not instruct" thesis one level up.
This item adds a small amount of code to remove a large amount of behavioral variance; it belongs in
a simplification plan because what it simplifies is the effective workflow.

Changes:

- [ ] Add a composition check in `src/execute.ts` at the `subagent` boundary, evaluated per call
      before any spawn, over the standard role names only (unknown agent names pass through
      untouched):
  - Tier 1 refuses a `validator` delegation: the worker's `verify` ref is the evidence by design.
  - A parallel fan-out with more than one `reviewer` requires disjoint `scope.paths` per reviewer.
  - A `validator` delegation at tier 2 or below without `evidenceScope: "session"` warns: resolving
    the worker ref is the default.
  - A `worker` delegation with no preceding `planner` at tier 3 warns.
- [ ] Gate enforcement behind `compositionPolicy: "warn" | "enforce" | "off"` in `src/config.ts`,
      default `"warn"` for one measurement window, flipping to `"enforce"` only after the warn data
      shows the rules fire on delegations that should have been refused.
      A per-call override parameter remains available for the exceptional case, and its use is
      recorded in telemetry.
- [ ] Emit every refusal and warning as a telemetry field (`compositionVerdict`), so tuning comes
      from the analyzer rather than from anecdote.
- [ ] Generate the guide's composition rules and the tool description's summary from the same source
      as the check, per the W8 single-source rule: the prose and the enforcement cannot drift.

Acceptance:

- Validator delegations per Tier 1 flow trend to zero in the analyzer's validation-evidence section,
  with no rise in unresolved or abandoned tasks (the quality guardrail from plan v1 applies).
- Warn-mode telemetry from the first window justifies or refutes each rule before `"enforce"` ships.
- A refusal message names the rule, the tier, and the compliant alternative, so the caller's next
  call succeeds on the first retry.

Dependencies: none to start in warn mode; S1 keeps the added telemetry field cheap.
Risk: over-restriction strangles legitimate work, which is exactly why the rollout is warn-first.

## S5: make evidence reuse observable and its failures loud

The reuse machinery exists and is correctly wired; the measured reuse is zero.
The original framing of this item blamed mostly producer-side gaps, and that framing is now obsolete:
the producer's consumer-aligned handoff landed in 0.11.7 and every F-item shipped, including the two
that were expected to be the long poles - the F5 freshness pair on successful lookups
(`repositoryStateStatus: matches | mismatch | unreadable`, carrying both the recorded and the current
state) and F9 (`paths` removed from the authorization identity, one composite flow grant per project
for flow-scoped callers, and refusals that name the shape, project, scope, and whether execution or
publication was missing).
Nothing this item needs remains producer-side.
The consumer side now holds all of the work, most of it scheduled by the follow-ups file's own rule:
guidance widens in the release that ships the parameters, and that release is the installed one.
The consumer side also cannot yet see a failed lookup as a failed lookup, which makes the difference
between "refs are unused" and "refs are unusable" invisible.

Changes:

- [ ] Record failed `verify` lookups in `src/metrics.ts`: a `verify` tool result with `isError` is
      extracted as a `lookupFailed` entry alongside `validationRefs`, with the error class
      (`denied`, `timeout`, `not-found`) parsed from the payload where present.
- [ ] Absorb the two v2 deferred report-contract items: make `## Files Reviewed` mandatory and parse
      it into the ledger's `changed_files`, so a reviewer's inspected set is visible to
      `codegraph_affected` and to S4's scope-compliance check; and stop flattening phase-level
      `omitted` into `verdict: passed` in ledger evidence, keeping `covers` a scope list rather than
      a quality signal.
- [ ] Extend the analyzer's validation-evidence section with per-flow reuse rate and lookup-failure
      counts, so the producer fixes show up as movement in our measurement.
- [ ] Surface an unresolved-ref outcome in `subagent_stats` for the last run, next to the existing
      `verify:N ran:M` line.
- [ ] Widen the role-prompt guidance in `src/templates.ts` and the guide to the shipped producer
      surface, replacing the bare-`{ ref }` text, and move the test pins in the same change:
  - `{ ref, flowId }` lookups and the worker's `publish: { flowId }` at mint, closing the
    child-to-root resolution hop that root-minted refs could not make.
  - `fresh: true` as the audited escape hatch for a seat that must re-execute inside a flow, which
    is the capability the validator's "run it again or report it not freshly executed" instruction
    was waiting for.
  - The lookup vocabulary `repositoryStateStatus`: `matches` means cite the ref, `mismatch` means
    re-execute, `unreadable` means report `NOT_RUN` with the reason - the F-033 close that removes
    the last "re-execute just to learn staleness" driver.
- [ ] Align the D9 classifier with the shipped lookup contract: the producer admits `covers` on a
      lookup as opaque and non-executing, so `VERIFY_LOOKUP_PARAMS` gains it; `{ ref, publish }` and
      `{ ref, fresh }` stay refused, matching the producer's own rejection, and the shipped-role
      sweeps assert all three.
- [ ] Update the one refusal sentence in `src/budget.ts` that quotes only `vr_` to name the `pc_`
      prefix too, with its test pins - the D1 carry-over that unblocked when the prefix shipped.
- [ ] Extend `src/metrics.ts` to extract the new payload fields into telemetry:
      `repositoryStateStatus` per lookup, `stateDrift` and `concurrentExecutions` per execution,
      `mutating` per command, and the `forced` decision on fresh runs.
      This is the instrumentation S2's deletion gate reads.
- [ ] Join the producer's invocation stream in the analyzer: the recorder now writes one aggregate
      record per `verify` call carrying `flowId`, `delegationId`, `role`, `ref`, and repository
      state (D4), which closes the "analyzer reads only the consumer side" gap in
      `analysis/MEASUREMENT.md` and makes executions-per-digest computable from both sides.
- [ ] Document the authorization reality in the README's setup section: one composite operator grant
      per project now covers flow-scoped child seats for the default gate, because `paths` left the
      authorization identity.
      The extension does not write the producer's policy file itself: D3's ownership boundary stands.
- [ ] Run the follow-ups file's own verification checklist, now executable end to end: fan-out
      dedup, concurrent single-flight, invalidation on tracked writes, `fresh` re-execution,
      cross-flow isolation and poisoning, no-env fallback, and the telemetry join.
- [ ] Refresh the status banners in `analysis/BASH_TOOLS_FOLLOWUPS.md`: every F-item is landed in
      the installed build, and the follow-ups file becomes a verification checklist instead of an
      ask list.

Acceptance:

- The analyzer distinguishes "0 refs reused because none were minted" from "0 refs reused because
  lookups failed", per flow, and the producer-stream join makes executions-per-digest readable from
  both sides of the boundary.
- Child prompts name `{ ref, flowId }`, `publish: { flowId }`, `fresh`, and the
  `repositoryStateStatus` vocabulary only against the installed producer build, with the template and
  guide test pins moved in the same commit.
- With every producer item live, the analyzer's reuse-rate section is expected to move without any
  further producer change; if it does not, the next measurement window localizes the failure to
  minting, resolution, or guidance instead of guessing.

Dependencies: none. Every producer item this workstream waited on is in the installed build.

## Producer dependency map (bash-tools) - all landed in 0.11.7

Verified against the installed package README (0.11.7), the producer repository's PLAN.md, and live
lookup probes (a `vr_` lookup and a `pc_` lookup with an explicit `flowId`, both correctly not-found
and side-effect free).
Every ask from `analysis/BASH_TOOLS_FOLLOWUPS.md` shipped in the producer's consumer-aligned evidence
handoff (their Steps 1-7):

| Ask | Shipped shape |
| --- | --- |
| F1 freshness knob | `fresh: true` on `verify`; rejected with `ref`; identical evidence returns the same ref with `reused: false`; the forced decision is recorded |
| F2 root-to-flow hops | `{ ref, flowId }` lookup; `publish: { flowId }` at mint with repository-identity checks and provenance stamps; own-flow publish is an accepted no-op |
| F3 project-command evidence | `pc_` refs, non-replayable, `covers` on both surfaces, same lookup metadata as `verify` |
| F4 error shapes | validation errors name the field, the expected shape, and a literal example; unambiguous coercions applied and recorded |
| F5 / F-033 lookup freshness | recorded plus current repository state; `repositoryStateStatus: matches \| mismatch \| unreadable`; producer provenance on success; effective scope named on failure |
| F6 mutating declaration | variant-derived `mutating` on results, invocation records, and decision records; unknown variants of writing families fail closed |
| F7 concurrency | single-flight for identical non-mutating requests, `concurrentExecutions`, `stateDrift`; the mutex was declined, and the consumer write lock stays the writer-reader authority |
| F9 authorization | `paths` removed from the authorization identity (kept in the evidence key); one composite flow grant per project for flow-scoped callers; refusals name the shape, project, scope, and whether execution or publication was missing |

Consequence for sequencing: no item in this plan waits on the producer.
S2's gate was evaluated against what shipped and became retain-frozen with a telemetry-driven
deletion gate, because the shipped shape covers evidence honesty but not writer exclusion.
The remaining work is entirely consumer-side: guidance, classifier alignment, metrics extraction,
the analyzer join, and the follow-ups verification checklist.

## S6: storage decisions - what we are not building

Recorded so the question stays answered.

- Agent-facing artifacts (ledger, reports, read manifests, review surface) remain plain text files.
  They exist so a child can `read` them with its own file tools; a database is opaque to a child, and
  a new query tool would be a permanent schema levy on every session's context (D6, archive below).
- The registry and telemetry remain files after S1.
  The trigger for revisiting is measured, not aesthetic: registry lock timeouts appearing in
  telemetry, or a second writer class beyond the known set.
- If that trigger ever fires, the move is `node:sqlite` with an `engines` bump (>= 22.5), WAL mode,
  and one table per store.
  Never a native dependency (`better-sqlite3`) for an npm-installed extension, and never a server.
  Redis and anything daemon-shaped are out of scope for a localhost tool; herdr is already the only
  daemon this system tolerates.
- The bash-tools flow cache stays producer-owned (D3).
  This plan neither adopts nor reimplements any of it.

## S7 (deferred): consolidate the identity write paths

A delegation currently records its identity in five places: registry entry, telemetry record, ledger
revision, flow manifest participants, and report metadata header.
The shapes are consistent and the writes are cheap after S1, so this is deferred on purpose.
Revisit only if S1 lands and telemetry still shows orchestration writes dominating delegation
overhead.
If it is ever done, the form is a single `delegation.json` per delegation under the flow directory
that the other stores reference by path, not a merge of the stores themselves.

## Rollout order

1. S1 (registry write path) and S3 (review surface) - independent, low-risk, land first in either
   order.
2. S5 (observability, guidance widening, classifier alignment, analyzer join) - fully unblocked
   producer-side, and it instruments the baselines S2's deletion gate and S4 will be judged against.
3. S2's instrumentation half (drift vocabulary, contention telemetry) lands inside S5; the lock
   itself is frozen, with deletion decided by the first clean measurement window.
4. S4 in warn mode, one measurement window, then the enforce decision from data.
5. S7 only on evidence.

Each item ships independently with its own measurement gate, matching the sequencing discipline of
v2: schema and enforcement before prose, and no guide or template text references a mechanism
that does not exist yet.

## Quality guardrails

Inherited from plans v1 and v2 and not derivable from cost data; they apply to every item above, and
to S4 most of all:

- [ ] Track unresolved or abandoned tasks; a cheaper workflow that gives up is worse than an
      expensive one that finishes.
- [ ] Track regressions discovered after a reviewer `PASS`, the strongest signal that a simplification
      cut real signal.
- [ ] Track escalation rate by tier after S4; a rising Tier 3 rate means the composition rules are too
      aggressive.
- [ ] Track worker discovery failures on Tier 1 flows without a scout, before removing any more
      mandatory roles.
- [ ] Re-tune from `npm run test:analyze`, not intuition.

## Risks

- **S1 hides mid-turn budget state.** A long single turn shows stale counters in `subagent_stats`.
  Accepted: `turn_end` persistence bounds the staleness to one turn, and breach transitions are never
  stale.
- **S2 stays forever.** The deletion gate may never open if the lock fires even occasionally.
  Accepted: a converged, frozen module with zero review investment is cheap to keep; the guardrail is
  the freeze itself, and a wedge in practice is the one thing that still gets fixed.
- **S2's drift guidance is ignored.** Roles may cite drift-flagged evidence as fresh.
  Mitigated by the telemetry extraction: a cited ref whose execution carried `stateDrift: true` is
  visible per flow in the analyzer.
- **S4 refuses a legitimate composition.** Mitigated by warn-first rollout, the per-call override, and
  the escalation-rate guardrail.
- **Measurement theatre.** Every item carries an analyzer-visible signal precisely so that
  "simplified" means "the number moved", not "the code looks smaller".

## What this plan removes

When S1-S5 have landed: the per-event registry write stream, the pretty-print tax, the stale-snapshot
bug, the behavioral variance of an unconstrained fan-out, the stale guidance that still teaches
bare-`{ ref }` against a build that ships flow lookups and publication, and the "caches exist but
nothing reuses them" measurement.
What deliberately stays: the repository write lock, frozen, because the producer's F7 shape covers
evidence honesty but not writer exclusion - until a measurement window shows it never fires.
What it adds: one fingerprint comparison per delegation, one composition check per call, the widened
evidence vocabulary in the prompts, and the telemetry to prove all of it earns its keep.

---

# Archive: plan v2 (completed)

This section is the provenance record for the active plan.
The full v2 text, including the fifteen W7 review rounds and their finding-by-finding dispositions,
is in this file's git history (last committed 2026-09-05).

## What v2 was and what it measured

v2 moved enforcement out of prose and into tools, after a 334-session measurement window (2026-08-26
to 2026-09-02: 38 roots, 296 children, 10,064 model steps, 14,139 tool calls, $44.92 computed cost)
showed that mandates written as prose were the mandates that were ignored.
Its thesis: stop paying per-agent for repository state, and give every mandate an enforcement point.

## v2 baseline measurements

| Signal | Measured |
| --- | --- |
| Tool-result tokens per model step | 68,134 cache-read tokens re-read per step; 27.9M fresh input tokens for the window |
| `git_diff` output volume | 4,279,168 tokens from 547 calls, avg 7,823; p95 49,847; 22.6% of all tool-result text from 3.9% of calls |
| Sibling diff storm | one root fanned out ~20 children, each re-pulling the same working diff at 52K-99K tokens; ~1.42M tokens |
| Validation churn | `project_command` 2,163 calls, 1,075 exact-duplicate excess (49.7%); `force:true` used to defeat the result cache |
| Delegation result size | `subagent` results avg 1,821 tokens, p99 6,099, re-read by every later root step |
| Root vs child cost | 38 roots carry $27.85; 296 children carry $17.07; children are 64.2% of steps but 38.0% of cost |
| Role mix | worker 84, reviewer 71, validator 70, planner 39, scout 24; 49.0% of assignments produce no code change |
| Budget compliance | documented limits were 24 worker calls and 12 reviewer inspections; observed sessions ran 240, 260 and 204 tool calls |
| Per-child context reconstruction | 1,279 intra-session excess reads (26% of reads) |
| Mandatory guide read | ~5,415 tokens per read, 28 reads across only 7 sessions |
| Serial tool loops | 1.41 calls per model step; 1.62 results per tool-producing step |

## Outcomes per workstream

- W1 delegation identity and telemetry spine: shipped and live-verified.
  Every delegation carries a stable id, the child environment exports the flow identity contract
  (documented in the README's Delegation identity section), and one JSONL record per delegation turn
  lands next to the registry; 93 of 93 child sessions attributable at closeout.
- W2 bounded structured reports: shipped and live-verified.
  Delivered-result p50 dropped from 1,145 to ~472 tokens against a 900 target; full reports persist
  under the flow's `reports/` directory; a report without a ledger block is flagged, not silently
  passed.
- W3 ledger as tool state with reference handoffs: shipped in slices A-D and live-verified.
  Children receive a ~50-token pointer and read the ledger themselves; `ledger.md` is mode 0400 so no
  child writes it; revisions are monotonic from `flow.json`'s high-water mark.
  Carried into v3 as measurement: the ledger-versus-inline root-token comparison was never run.
- W4 budget enforcement: shipped.
  Budgets count live in the child process; a breach steers once and then refuses everything but the
  report; worker pre-implementation discovery gate; scope-scaled allowances; reviewer budget
  rebaselined from measurement.
- W5 fan-out pre-digest and disjoint scopes: shipped.
  One review-surface snapshot per flow plus per-delegation scopes; its missing invalidation is
  repaired by v3 S3.
- W6 read manifests: shipped.
  Per-delegation manifests replace mandated reads; rereads of do-not-reread paths are telemetry.
- W7 validation ownership and the `verify` handoff: shipped after fifteen review rounds.
  The mint-and-resolve contract, the mutating-command and `verify`-shape enforcement, and the
  repository write lock all landed; the producer's side completed in bash-tools 0.11.7 (see the
  producer dependency map in the active plan).
  Its acceptance ratios (one execution per repository state per flow; no validator delegations in
  Tier 1) are measurement windows carried into v3's S4 and S5.
- W8 instruction-layer deduplication: shipped.
  The guide is repo-owned and generated with budgets rendered from live config, tool descriptions are
  generated and test-covered, the read mandate is gone, and the render sits under a standing size
  assertion.
  Unobserved at closeout: a main session completing a delegation flow without reading the guide.

## Design decisions still in force

These govern the current code and are restated, condensed, because the active plan references them by
number.

- D1: ledger writes are parent-only; a child emits its ledger block in its report and the extension
  folds it in.
- D2: a budget breach steers once, then refuses all but report reads; abort is a per-role config
  option; a breach first seen on the report turn is recorded `report_only`.
- D3: every producer owns its store root; this repo never writes into bash-tools' directories and
  vice versa.
- D4: evidence scope is set by the spawner through the child environment and may only narrow per
  call.
- D5: children get a ledger pointer, never the body, because a reused session's appended system
  prompt is frozen at launch.
- D6: no ledger tool and no child write path; the extension writes revisions at delegation boundaries
  from data it already holds; `ledger.md` is mode 0400.
- D7: the report digest keeps the ledger block and status lines and loses prose; the cap is
  `reportDigestTokens`, default 250.
- D8: validation evidence is minted once by the session that changed files - under parallelism, the
  session that integrates the fan-in - and passed by reference.
- D9: execution capability is a per-role grant (`validationExecutionRoles`, `mutatingCommandRoles`);
  resolution is universal; classification is an allowlist, so unknown `verify` parameters count as
  execution.
- D10: a fan-out has one gate owner; the repository write lock enforces the sharp edge and fails
  open; v3 S2 keeps it frozen with a telemetry-driven deletion gate.

## Open at closeout

- The six quality guardrails, carried into the active plan's guardrails section.
- Three evaluation gaps, all measurement windows tracked in `analysis/MEASUREMENT.md`: the W3
  ledger-versus-inline comparison, the W7 validation ratios (last reading: 1.25 executions per
  distinct state digest), and the W8 no-guide-read observation.
- v2 non-goals remain non-goals: no model-preset changes, no nested subagents, herdr remains the only
  transport, no rewrites of bash-tools-owned tools.

## Detailed records

- `analysis/MEASUREMENT.md` - the live measurement artifact, rewritten by `npm run test:analyze`.
- `analysis/TELEMETRY_SCHEMA.md` - the telemetry record format.
- `analysis/BASH_TOOLS_FOLLOWUPS.md`, `analysis/BASH_TOOLS_DECISIONS.md`, `analysis/F8_PROBE.md` -
  the producer handoff, including the F8 measurement error and its withdrawal.
- The W7 repository-lock review rounds (F-001 through F-033) explain the lock's clock-skew,
  publish-race, and grace behavior; the module's docstrings name the findings they answer, and the
  full narrative is in git history.
- Plan v1's instruction-only items shipped into the guide and agent templates; its disposition table
  is in git history.
