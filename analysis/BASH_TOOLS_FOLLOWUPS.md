# Residual `bash-tools` asks after W7

Handoff from the `subagent-herdr` workspace, follow-up to
`bash-tools/docs/handoffs/bash-tools-flow-cache-requirements.md`.

Provenance: `subagent-herdr` W7 (validation ownership) landed on top of the `verify` composite, the
repository-state digest (a key over content, mode, size and status for the paths `git status` reports, with
ignored paths excluded; see `F8` for the measurement and its withdrawal),
the flow-scoped evidence store, and ref lookup.
Those four closed R1, R1a, R3, and most of R4.
The items below are what the consuming side still cannot express, each one observed while wiring agent roles to `verify`.
Owner of implementation: `bash-tools`.
Owner of the orchestration contract: `subagent-herdr`.

## Already satisfied, recorded so nobody re-litigates it

- R1, R1a: flow-scoped store keyed on `PI_ORCHESTRATION_FLOW` with `producerScope` on records and decisions, process-local fallback when the env is absent, narrowing-only evidence scope from the spawner.
- R2: `git_diff` defaults to a summary of status, per-file stat, and hunk headers, with explicit `mode: "patch"` and per-path fetch.
- R3: `verify` runs format, lint, typecheck, and test in a fixed order under its own budget with one authorization, and returns a bounded payload plus a ref.
- R4 for `verify`: stable `vr_...` refs, a `ref` lookup that executes nothing, and opaque `covers` stored and echoed verbatim.
- The reuse key that blocked W7: closed, and the report claiming it was still open was wrong. `dirtyFilesDigest` is a key over content, mode, size and status for reported paths, so a `passed` record is not replayable after content-only edits to tracked files. The measurement that said otherwise was run on `PLAN.md`, which `.gitignore` excludes from the dirty set, so those edits were never in the key's input; one appended sentence to `README.md`, a tracked-modified file, moves the digest. `F8` below is kept as the archive of that error and `analysis/F8_PROBE.md` holds the correction. What genuinely remains is that a caller cannot tell a fresh read from a reused one, which is F1 and F7, and that ignored paths are silently absent from the key, which is correct but undocumented.

## F1 (P0) A freshness knob for `verify` inside a flow scope

Problem: inside a flow, a role that must produce fresh evidence for inputs somebody else already validated has no way to ask for it.
The cache read is gated only by the effective scope and the key, and `verify` has no `force`.
The only escape is to change the request shape, because the key includes `paths`, `omit`, `scripts`, and `covers`.
Editing `covers` to force a re-run falsifies the coverage claim, which is the one property we asked `bash-tools` never to interpret and never to break.
The instruction we now ship to validators, "run the gate again or report the check as not freshly executed", is unsatisfiable inside a flow scope, so it is prose again.

Ask:

- [ ] Accept `fresh: true` on `verify`. It skips the cache read, executes every selected phase, and stores the resulting record.
- [ ] Keep the ref content-addressed as today, so a forced re-run returns the same ref with `reused: false` rather than a new identifier for identical evidence.
- [ ] Add `forced` to the `verify` decision vocabulary in the invocation record, matching the `miss | hit | forced | ineligible | invalidated` shape already used by `project_command`, and keep it independent of evidence scope.
- [ ] Name the flag in the tool description, so an agent does not have to guess that re-running is available.

Acceptance:

- Two identical `verify` calls in one flow, the second with `fresh: true`: the second executes, reports `reused: false`, returns the same ref, and records `forced`.
- `fresh: true` combined with `ref` is rejected as an invalid request, matching the existing rule that a lookup carries no execution options.
- Without the flag, behaviour is byte-identical to today.

Why it matters: it is the difference between independence as a capability and independence as a wish.
Our spawner can already narrow a child to `session` scope to force execution, and that is the mechanism we ship for security-sensitive tiers, but a narrowed child loses the ability to read any sibling evidence.
A flow-scoped role needs one narrow, audited escape hatch.

## F2 (P1) Ref resolution from the session that owns the flow

Problem: the root session carries no `PI_ORCHESTRATION_FLOW`, so its effective scope is `session` and a ref minted by a child is unresolvable there.
Refs therefore travel upward as text only, and the parent has to trust a copied identifier instead of checking verdict, `covers`, and repository state.
W7 asks exactly that check of the parent and of the reviewer, so the last hop of evidence handoff is the hop we cannot verify.
The reviewer now holds `verify` for lookups only, so the gap is one tool call away from being closed on the child side and still open in the parent.

Ask, in the order we would take it:

- [ ] Confirm that nothing in the flow path assumes the flow env implies a child process.
      Per-invocation records must tolerate `flowId` present with `delegationId` and `role` absent.
- [ ] Confirm the zero-change rule still reads as: no flow env means session scope and the process-local store.
      We propose to amend our side of the contract by exporting `PI_ORCHESTRATION_FLOW` and `PI_ORCHESTRATION_EVIDENCE_SCOPE=flow` into the root process lazily, at the first delegation of that session, so a session that never delegates keeps today's byte-identical behaviour.
      Say so in your docs, or push back before we implement it.
- [ ] If you would rather not widen membership, expose an explicit lookup that names the flow instead of inheriting membership, for example `verify { ref, flowId }` validated against a store the caller may read.

Acceptance:

- A ref minted by a child resolves in the delegating session, and the record names the producing role and `producerScope`.
- A ref from another flow, another repository identity, or another working directory still cannot be read.
- A session that never delegated sees no change in tool surface, output, or timings.

## F3 (P1) Refs and lookup for `project_command` results, not only for `verify`

Problem: `verify` covers format, lint, typecheck, and test.
A validator still runs `node_build`, the `fallow_*` analyses, and check variants through `project_command`, and those results carry a `resultFingerprint` that nothing can resolve.
So the remainder of a validation plan is precisely the part that cannot be handed over, and the next role re-executes it.

Ask:

- [ ] Return a ref for every cache-eligible `project_command` execution, alongside `resultFingerprint`.
- [ ] Accept a lookup that resolves a ref to its stored record without executing: a `ref` parameter on `project_command`, or one small dedicated command id if you prefer to keep execution and resolution apart.
- [ ] Accept the same opaque `covers` parameter on `project_command`, stored and echoed verbatim, so the two ref surfaces behave alike.
- [ ] Mark records non-reusable when no reliable state digest exists, as you already do for `verify`.

Acceptance:

- A worker mints a `node_build` ref, a validator resolves it in one call, and neither the resolved command nor an equivalent one runs again in that flow.
- A ref cannot claim coverage it was not given, and no caller can forge one.

## F4 (P2) Argument-shape errors that name the shape

Evidence from the delegation that shipped this change: four separate worker children each lost a step submitting `project_command` with `commandId: "node_test"` and `paths` as a serialized string rather than an array, and the error said only that the request was invalid.
That is the same class as the R5 `force: "true"` finding, one wasted step per occurrence and a retry that may guess wrong again.

Ask:

- [ ] On a validation error, name the offending parameter and the type it expected, with one literal example of the accepted shape.
- [ ] Coerce a JSON array or boolean supplied as a string when the parse is unambiguous, and record the coercion in the invocation record rather than hiding it.
- [ ] Keep rejecting anything ambiguous, with the same actionable message.

Acceptance: no validation error is emitted without a remediation line naming the parameter and the expected shape.

## F5 (P2) Make the lookup payload self-explanatory

The `not-found` path already states which bucket was searched, which is good.
Two additions would let an agent decide what to do without re-reading prose:

- [ ] Echo the effective evidence scope and whether a flow id was present on a lookup failure, so the child learns whether to re-execute or to hand the ref back to its parent.
- [ ] Include `producerScope` and the producing role in a successful lookup, so a validator can see whose execution it is citing.
- [ ] Recompute and return the current repository state on a lookup, or state plainly that the returned `repositoryState` is the minted state and that no comparison was made. Observed from a validator seat: a successful lookup returns `status`, `verdict`, `ref`, `projectPath`, `perStep`, `failureTail`, `reused`, `covers` and `repositoryState`, and the digest in it is the one recorded at mint time, so staleness after a post-mint edit cannot be decided from the payload. A seat must then re-execute to learn what a lookup should have told it, which is the exact cost this tool exists to remove.

## F6 (P1) Say whether a command writes to the repository

Problem: the consumer side has to guess. A role-restriction control in `subagent-herdr` now refuses a write-capable command to a role that must not write, and it can only decide by command-name shape: `node_format` writes, `node_format:check` does not, and a variant such as `node_lint:update` is unknowable because variants are arbitrary package-script names. We implemented the guess fail-closed, so an unknown variant of a family that has a writing form is treated as writing.
That is the best available heuristic and it will occasionally refuse a read-only command.
The cost is already real: a role outside `mutatingCommandRoles` cannot retarget any `verify` phase, so a validator that needs `scripts.test` pointed at an end-to-end script must use the `project_command` form of it instead.

Ask:

- [ ] Return a `mutating` boolean on every `project_command` and `verify` result and decision record, stating whether the executed script was allowed to write, derived from the script the resolver selected rather than from the identifier.
- [ ] State in the tool description whether a `verify` phase was run in a writing form, specifically the format phase when `scripts.format` names something other than the check script.
- [ ] If a reliable derivation is impossible, say so in the docs and we will keep the name-shaped rule permanently.

Acceptance: a caller can decide "may this role run this call" from the tool's own output, without classifying identifiers itself.

## F7 (P1) Concurrent callers in one repository

Problem: the children of a fan-out share one working tree and run their checks at the same time, and two properties of the current implementation make that expensive and misleading.

- Nothing deduplicates two identical in-flight requests. Both miss, both execute the whole gate, and the second execution is pure waste. The flow store itself is safe, `flows.lock` plus per-entry locks with tmp-file `renameSync` and stale-lock reclamation, so this is about execution, not corruption.
- Nothing observes that a sibling is mutating while a gate reads. The digest design makes the outcome silent: a torn read produces no state, therefore no ref and no reuse, and the caller sees only a `miss` on a request it just paid for. When the read does not tear, the verdict is honest about a repository state that includes another session's half-finished edits, which is evidence about nobody's change.

Ownership is the real fix and `subagent-herdr` now owns it: `repositoryWriteLock` gives a write-capable command an exclusive per-repository hold for the duration of that call and refuses a check that would read the tree while a sibling holds it. That guard is name-shaped, exactly as in F6, which is why F6 gates its accuracy.

Ask:

- [ ] Single-flight identical requests: two concurrent calls whose key matches share one execution, the joiner receives the stored record, and the decision vocabulary distinguishes `shared` from `hit` so a reuse is not mistaken for a cached result.
- [ ] Record `concurrentExecutions`, the number of in-flight requests sharing the same repository identity when the call ran, so a consumer can attribute a slow or duplicated run to contention instead of guessing.
- [ ] Detect a tree that moved under a call: compare repository state at completion with the state at start and report the difference, for example `stateDrift: true`, so a verdict gathered over a moving tree is not presented as a clean pass.
- [ ] Alternatively, if you would rather own serialization than expose it, provide a per-repository execution mutex for commands the F6 `mutating` flag marks as writing, and we will delete the consumer-side lock and its tests.

Acceptance:

- Two simultaneous identical `verify` calls in one flow produce one execution and two results carrying the same ref.
- A gate whose repository state changed while it ran reports drift instead of a plain pass.
- Records carry enough identity to join with `subagent-herdr` telemetry on `flowId` or `delegationId`.

## F8 (withdrawn) `dirtyFilesDigest` is not a content key for tracked-modified files

**This item is withdrawn; everything under this heading is the archive of a measurement error, not a request.** The
digest does observe content in tracked-modified files. The rows below were labelled "tracked-modified" and were
actually `PLAN.md`, which `.gitignore` excludes from `git status`, so its edits were never input to the key; one
appended sentence to `README.md`, which is genuinely tracked-modified, moves the digest. If you read one line from
this section, read `analysis/F8_PROBE.md`, which holds the corrected table, the reuse finding, and the four wrong
turns that produced a P1 that should not have been sent. The only thing left standing here is a documentation ask:
say that ignored paths are outside the key, because a consumer who assumes otherwise will conclude, as I did, that
content edits are invisible.

Corrected short form: installed `@ztc/bash-tools` 0.11.4, one seat, one repository. The key moves on a write to any
path `git status` reports, tracked or untracked, including a one-word change at identical byte count, and it returns to
its previous value when the bytes are restored. Ignored paths are not in it. Everything between here and the asks is
the archive of how a P1 got filed against that, and each present-tense claim below that is false carries a marker.

| tree change since the previous mint | kind | digest |
| --- | --- | --- |
| baseline, 32 dirty paths | - | `4feea8e8...` |
| content edits to `PLAN.md` | ignored by `.gitignore`, mislabeled tracked-modified | unchanged, correctly |
| nothing at all | control for read noise | unchanged |
| content edit to `PLAN.md` | ignored, mislabeled tracked-modified | unchanged, correctly |
| created one new untracked file | path set changed | moved |
| rewrote that untracked file | untracked, content and size changed | moved |
| content edit to `PLAN.md` | ignored, mislabeled tracked-modified | unchanged, correctly |
| rewrote that untracked file again, plus a tracked test edit | two variables moved; not load-bearing | moved |
| swapped one hex character in that untracked file | untracked, one byte, byte count fixed | moved |

[archived claim - false: the three `PLAN.md` rows are an ignored file, so their digest invariance is correct behaviour,
not blindness. A tracked-modified edit moves the digest, and does so at fixed byte count. See
`analysis/F8_PROBE.md` rows 9 to 11.] Content in a tracked-modified file is not observed: same path, same status,
changed bytes and size across three edits, three mints, one digest. That was the finding, and it was wrong.

The last row closes the confounder that made the untracked side weak on first pass, and that row alone carries it, the
row before it having moved two variables at once. An earlier version of this document conceded that a rewrite changing
bytes and byte count together is equally explained by a size-keyed read, since your state reader folds mode and size
into the digest. The discriminating mint was cheap and is now run: one hex character in one untracked file, path set,
status, mode and byte count all held constant, and the digest moved. That part survives, and so does the observation
that the reader is not memoised on path set, status, mode or size. What does not survive is the inference drawn from
it, that because the untracked side moved and the `PLAN.md` rows did not, the tracked side must be read some other
way. The two sides were never the variable; an ignored file was.

The mechanism is a named hypothesis, not a result: tracked paths measured against the index and untracked paths
against the working tree predicts these rows, and so does content hashed for untracked paths only with tracked dirty
paths contributing identity and no content. Discriminator, one mint, needs a shell: `git add` a content change to a
tracked-modified file so the index moves while the working tree does not, then mint. The first predicts a move, the
second does not. We could not run it, because arbitrary commands are outside this workspace's tool catalog.

[archived claim - false: a tracked-modified edit is distinguishable by digest, as `analysis/F8_PROBE.md` rows 9 to 11
show.] Why it seemed to matter: a worker in a shared-tree fan-out edits files that are already dirty far more often
than it creates new ones, so the claim implied a gate minted after such an edit was indistinguishable by digest from a
gate minted before it. It is distinguishable. The real trap is narrower and still worth a documentation line: an edit
 to an ignored path, including a plan or notes file a team keeps out of git, is invisible to the key, which is correct
and surprising.

[archived claim - false: that reuse was a stale serve; `PLAN.md` is ignored, so the tree had not moved in the only
sense the key tracks.] The consequence as originally reported: a four-phase gate was minted, `PLAN.md` was edited
twice, and the next call returned `status: "unchanged"`, `reused: true` and `executed: false`. Read correctly, that is
the ignored path again, and reuse keyed on this digest is sound for reported paths, measured directly at rows 10 and 11
where a tracked write produced `reused: false` and the original bytes produced the original digest.

Relation to your source, which is the part that should have been read first: `contentDigest` in
`src/tools/project-command/repository-state.ts` of the sibling working tree runs `git hash-object -- <paths>` over
every dirty path and folds each hash, mode, size and status in, and rejects the read when a dirty path's pre- and
post-`lstat` disagree. That code describes exactly the behaviour measured, and the mistake was in not believing it.
The installed bundle is not readable from our seat under this workspace's file access policy, which is what left room
to speculate past the source.

Correcting my own record, in three directions, because three were made in this file: first I claimed the key is
content-sensitive on the strength of a mint sequence where the tree was also gaining files and changing staged state,
and that claim was confounded; then I demoted the finding to unreproducible on the strength of a repeat that was not
controlled; then I called the key content-blind, which was falsified not by any row in the table above but by
`.gitignore`, which showed the file those rows measured was never in the key's input. No version of the table above
survives; `analysis/F8_PROBE.md` holds the corrected rows. The first error was the dangerous one, because it licensed
trusting a ref as a content lock, and the last was the most expensive, because it sent a P1 to a sibling repository
on a label nobody re-checked.

Asks:

- [x] withdrawn: confirm whether the released artifact hashes working-tree content for dirty tracked paths, and release
      the `git hash-object` version if it is unreleased. It does hash content; there is nothing to confirm.
- [x] withdrawn: add the regression case for a tracked file already dirty, edited in place, digest must move. It moves.
- [ ] State in the docs what the digest is a fingerprint of, in one sentence a consumer can rely on, and include the
      one clause that is easy to omit: paths excluded by `.gitignore` are not in it. This is the only ask left from
      this item, and it exists because I misread the semantics rather than because they are wrong.
- [ ] Keep F1's `force` or freshness knob and F7's mid-run drift report, because a consumer still cannot distinguish
      "nothing moved" from "not observed" without them, and neither of those is this item.

Re-run after a producer release: `analysis/F8_PROBE.md` has the recipe, and the expected result is that a tracked write
moves the digest at any byte count and an ignored-path edit does not move it at all.

Interim posture on our side is unchanged and now rests on measurement rather than caution: `subagent-herdr`
treats a `verify` ref as attesting to a command set at a moment, not as a content lock. The gate is minted
after the last edit, a role that edits again mints a new ref rather than reusing the old one, and the fan-out
rule is ownership rather than hashing. None of that depends on how this issue resolves.

## F9 (P1) An unauthorized `verify` shape reports only that it failed

This was filed as P0, "a delegated seat cannot mint a ref at all", and that framing is withdrawn on evidence.
A worker seat in one flow minted `vr_4f23b613381ea8dab8d05f7a` and `vr_34505fee17381e81e833d435`, and a
validator seat in the same flow resolved both by bare `{ ref }` lookup and executed nothing. Child minting and
sibling resolution both work, so the flow cache contract is now observed rather than designed.

What is real is narrower and still costs attempts. `authorizeVerify` decides per call *shape*, an identity of
`{ commandId, fingerprint }`, with `globalSafe: false`, `allowGlobal: false` and `deferAllowPersistence: false`,
so a shape with no recorded decision falls through to an interactive prompt. A delegated seat has nobody to
answer it and fails at `confirmationTimeoutMs` (120s in this install) as `verify authorization failed: timeout`,
while a shape matching one of the two `deny` entries recorded for this project fails as
`verify authorization failed: denied`. Six child attempts across two rounds produced four timeouts and two
denials before an already-allowed shape was reached, and not one of those refusals was actionable.

The shape-scoped decision itself is right and stays: it is what stops a role that may run the default gate from
running an arbitrary package script through a `scripts` override. The complaint is about the failure, not the
policy.

- [ ] On a refusal, name the fingerprint sought, the scope searched, and whether a prompt was attempted and timed out, so an operator can pre-authorize the one shape a role needs instead of guessing shapes.
- [ ] Name the matched rule on a deny. A child cannot ask the operator what was denied in an unrelated earlier session, and `denied` and `timeout` reach the caller as one undifferentiated failure.
- [ ] Consider letting one project-scope `verify` grant cover the phase-default shapes, since the shapes a legitimate role needs are the defaults, and today every new combination wants its own recorded decision.

Acceptance: a delegated seat that cannot execute `verify` learns from its first refusal what to ask for, rather
than discovering it by exhausting its call budget on shapes.

## Verification we would run on our side once F1 to F3 land

- Fan-out: two child processes in one flow, same repository state, one `verify` and one `project_command` each, asserting one execution and one scoped hit.
- Concurrency: two simultaneous identical requests produce one execution (F7), and a gate whose tree moves mid-run reports drift.
- Invalidation: mutate a tracked file in child A, assert child B misses on the same request.
- Freshness: child B calls `verify` with `fresh: true` against unchanged state and executes.
- Isolation and poisoning: an entry from another flow, repository identity, or working directory cannot be read or rewritten, including by a hand-crafted record.
- Fallback: unset env produces byte-identical results to the current implementation.
- Join: your invocation records join to `subagent-herdr` telemetry on `delegationId` or `flowId` without transcript parsing, and root-session records join on `flowId` alone (F2).

## Baseline for measuring F1 to F3

From the same measurement window that produced the original handoff, to be re-measured with
`npm run test:analyze` in this repo after the follow-ups land:

- `project_command`: 2,163 calls, 728 errors, 1,075 excess duplicate calls, 130 validation and 24 resolution errors.
- Duplicate `project_command` calls per delegation, and `verify:N ran:M` per delegation, where the target is `ran:1` per distinct repository state per flow.
- Validator delegations per flow, where the target is zero for Tier 1 and most Tier 2 flows and independent execution only where the delegation names `evidenceScope: "session"`.
