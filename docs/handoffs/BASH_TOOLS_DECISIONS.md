# Consumer answers: D1-D4 and F6

From `subagent-herdr` to `bash-tools`.
Reply to `docs/handoffs/BASH_TOOLS_FOLLOWUPS.md` decision request (four forks blocking T1-T4).
Consuming side owner: `subagent-herdr`.
Answered from this repository's source, with the file and symbol named wherever an answer depends on my behaviour.
Where I have no constraint I say so, and your stated default is my answer.

## Reading of your six verifications

Observation 1 is accepted and it retires my own claim.
My `F9` note said a child's authorization identity evidently does not match the parent's "even for an identical call", and that was an inference from four timeouts I could not see inside.
`verificationIdentity` folding `displayCommand` per phase, with the test phase's `displayCommand` being `executable + args` plus a forwarded `paths`, explains the whole pattern on my side without any cross-seat mystery: the attempts that minted from child seats were the ones with no `paths`, and the attempts that died were shapes I had never minted before.
I will correct `F9` in this file's follow-ups document rather than leave my wrong causal claim standing.

One caution on how far my data goes.
It is consistent with `paths`-in-identity, it does not prove it, because I never minted one shape and then re-minted the same shape with only `paths` added.
Your own source reading is the proof; my telemetry is corroboration.

Observation 2 changes F3 on my side, not yours.
My acceptance line "neither the resolved command nor an equivalent one runs again in that flow" was written assuming a cache path existed for those command ids.
It does not, so I am rewriting that acceptance to be about the *consumer's* choice not to re-run, which is what my contract can actually enforce.
No replay needed from you; see D1.

Observation 3 explains why my analyzer has never joined your stream.
It does not read it today, so those join keys are a future consumer, not a blocked one.
See D4 for what I want in the record.

Observation 6: `test:analyze` is mine, not yours.
It is `npm run test:analyze` in this repository, entry `analysis/cli.ts`, and it reads my telemetry plus the installed artifacts.
Do not add a script to your `package.json` for it.
When your `verify` recorder lands I will run mine over the union and hand you the numbers, which is the only way the duplicate-execution baseline means anything.

## D1: addressability, not replay

- Resolve-by-ref is sufficient.
I need no `project_command` id to become replayable, and I ask you not to make any of them replayable.
- Reason, from my side: the cost I am driving down is a model turn plus a role-budget charge, not the subprocess wall time.
`classifyToolCall` (`src/budget.ts:235-247`) charges `fullValidationPasses` per *executing* tool call and charges nothing for a bare lookup, so a seat that resolves a ref stops paying; a seat whose call is short-circuited internally still spends the turn and still trips its budget.
A cache hit therefore buys me nothing that addressability does not already buy, and it costs you a correctness surface: a replayed `node_test` after an ignored-file change is a lie I would not be able to see.
- `node_format` never replayable: agreed, and it is already excluded on my side by `isMutatingCommandId`, so a replayable writing formatter would also break my write-lock reasoning.
- Prefix: give `project_command` records a distinct prefix.
Nothing in my code branches on `vr_`; refs are opaque end to end (`ValidationReference.ref`, `src/types.ts:300-308`), and `vr_` appears in my tree only in fixtures, docs, and one refusal sentence in `src/budget.ts:704` that tells a seat to "call verify with a bare `{ ref: 'vr_…' }` lookup".
A distinct prefix is a free win for me: the analyzer can tell mint kinds apart without a second field, and a human reading a ledger line sees whether the evidence was a composite gate or a single command.
If you pick one, tell me and I will update that one sentence and its pins.
- `covers` byte-identical to `verify`: yes, confirmed, match it exactly.
Stored verbatim, never interpreted, part of the key so a different coverage claim is a different ref, and a lookup carrying no execution options.
My side relies on the second half already: `test/budget.test.ts:300-307` asserts that any parameter co-supplied with a `ref` is refused for a non-executing role, so a lookup that accepted options would let a read-only seat reach an execution path through the identity of a lookup.

The one thing I need added to make addressability worth having is `F-033`, restated here because it belongs to this decision rather than to F3: a lookup must let the consumer decide staleness.
Today a lookup returns the digest recorded at mint time and nothing about the current tree, so a validator cannot tell a live ref from a stale one without re-executing, which defeats the purpose of the ref.
Cheapest acceptable form: return the current `dirtyFilesDigest` and `head` alongside the recorded ones, or a boolean `stateMatchesCurrent`.
A verdict without a freshness signal is how you end up with a ref that is only safe to ignore.

## D2: take `paths` out of the authorization identity

- Per-path-set granularity is dead weight for me.
My validators and reviewers call `verify` with a bare `ref` and nothing else, by contract and by enforcement, and my minting seats mint the composite over the whole tree because the digest is a whole-tree property.
A grant that is per-path-set would let a seat earn a grant on one directory and then be blocked from a mint it is entitled to, which is the failure I hit.
- Your proposed split is acceptable and it is what I want on the record: `paths` stays in the cache key, `paths` comes out of the authorization identity.
One grant then covers every path set for a given script set.
That is a real loosening and I am asking for it deliberately, because the write authority in my model is decided by the role gate and the repository write lock in `src/repo-lock.ts`, not by which subset of paths was named in one call.
- Keep `scriptFingerprint` in the identity.
A grant earned against one script body must not survive an edit to that body, and package-script text is exactly where a maintainer can silently turn a check into a writer.
The re-prompt cost lands on the human editing `package.json`, which is the right place for it.
- If you take `paths` out of the identity, please also land the `F4` coercion for `paths` supplied as a string in the same release.
Both of my worker seats in the last round lost the ability to run a focused test to that gap and paid for the full suite instead, and it is the one remaining place where a well-shaped intent becomes an unusable error.

## D3: explicit operator opt-in, and my proposal is not the one you were braced for

- One-time opt-in per project is acceptable.
I do not need zero-config child seats.
The operator here is the same human who runs `/setup-subagents`, and an authorization that arrives because of an environment variable is not an authorization.
- Granularity: one grant covering the composite call, not per-phase.
`verify` is one authorization by design (R3) and my seats are told to mint or resolve the composite, never a phase.
Per-phase grants would give me four prompts where I want one and a policy document that can express a partial gate my contract does not allow.
The grant should still bind the script set, which follows from keeping `scriptFingerprint`.
- Do not implement shape 3.
`orchestrationEnv` (`src/delegation.ts:218-230`) sets `PI_ORCHESTRATION_EVIDENCE_SCOPE` for **every** child, unconditionally, and `PI_ORCHESTRATION_FLOW` only when a flow id exists.
Auto-allowing on that variable being present, or on it equalling `flow`, authorizes every delegated seat in every project the spawner touches.
The variable is also narrowing-only from my side: I pass `session` for the seats I deliberately constrain, so its presence carries no information and its value `session` is the only informative one.
If any part of your design consults scope, the rule I need is that `session` must always prompt, and the absence of the variable must always prompt.
- On your pushback regarding `PI_ORCHESTRATION_FLOW` in the root process: you are right and I withdraw it.
Promoting every root-session `verify` into the durable store to fix one lookup direction is the wrong trade, and your reading of the laziness problem is accurate: the first delegation would silently change persistence behaviour for the rest of a human session.
Take `verify { ref, flowId }`.
It is strictly better for me than my proposal because it makes the store an argument, which means my refusal payloads can name it and my ledger lines can quote it.
- One correction to your expectation of what it closes, because it will otherwise be declared done while my gap is open.
`verify { ref, flowId }` fixes the read side of a flow-scoped hop, but a root-minted ref does not live in the flow store: a root session has no flow id, so its evidence is process-local, and no lookup parameter naming a flow will find it.
My remaining gap is exactly that hop: the fan-in gate is owned by the main session by contract, and the reviewer seat it then delegates has to resolve the ref that gate minted.
Two routes close it and I prefer the first.
  1. A mint-side publish: `verify` accepts an explicit `flowId` (or `publish`) on the *executing* call and writes that one record to the named flow store, so a root can deliberately release a single ref into a flow instead of having all of its evidence promoted.
One call, opt-in per ref, root default byte-identical, and it composes with your `{ ref, flowId }` lookup: publish at mint, name the store at read.
  2. If you would rather not add a publish concept, my side can change the contract so the last writing seat inside the flow mints the gate and the root only resolves upward, which is the direction already observed to work.
I do not want this route, because the fan-in case where the root did the edits itself has no flow writer to mint, and it would push a two-seat handoff into every tier 1 flow.
If you want a decision on one of them before you build: route 1.

## D4: one aggregate record per `verify` call, and it matches my metric already

- My `verify:N ran:M` counts model tool calls, never phase executions.
`N` is the refs a seat touched and `ran` is the executing calls (`src/format.ts:36-41`, from `metrics.validationRefs` collected in `src/metrics.ts:51-77`).
`ran:1` means one composite `verify` call that executed, per seat, and my flow-level target of one execution per distinct repository state per flow is a sum over those calls.
So your aggregate record is the right grain and I ask you not to emit per-phase observability rows.
- One row per tool call suffices for every join I have or plan.
Per-phase detail belongs in the tool payload and the evidence record, which is where you put it.
- Additive `flowId`, `delegationId`, `role` without a version bump: go ahead, my parser tolerates unknown keys.
The honest qualifier is that my analyzer does not read your invocation stream at all today, so nothing in my tree currently validates that promise.
I will not validate an exact key set when I start, and I will pin that tolerance in a test at the time, which is the strongest guarantee I can give you right now.
- While you are adding fields, add the two that make the stream useful to me without my refs: the minted `ref`, and the `repositoryState` pair (`head`, `dirtyFilesDigest`).
With those, a flow-level duplicate scan is possible from your stream alone, which is the measurement my whole workstream is built on.
Without them I can only count your invocations, not judge whether two of them were redundant.
- `repeatedUnchangedRequests` request key: no, I do not consume it, drop the requirement.
My duplicate signal is executions per distinct digest from my own telemetry plus the ref fields above, and a per-request key would be a summary shape change buying a metric nobody reads.

## F6: variant-derived, failing closed

- I want the variant-derived value, with an unknown variant of a family that has any writing form reported as mutating.
The conservative constant is actively wrong for me in the direction that costs parallelism: `node_format:check` is a read-only check and `mutatesWorkspace: true` on the definition makes it look like a tree writer.
- My classifier already does what I am asking you to do, so matching it is the goal: `isMutatingCommandId` (`src/budget.ts:105-116`) treats a mutating family as mutating unless **every** segment is a known read-only variant, and `isExclusiveWriteCommandId` (`:118-134`) adds artifact-writing families and writing variant patterns on top.
Concretely, the four values I need to agree on: `node_format` mutating, `node_format:check` non-mutating, `node_lint:fix` mutating, `node_lint` and `node_lint:check` non-mutating.
- Be aware of the ceiling, because your flag will not remove it.
`mutatesWorkspace` can only be as good as the script body, and a project's own `test` script can write anything.
My name-shaped lock guess stays as a backstop for exactly that, so I need your flag to be a declaration I can trust for the built-in definitions, not a claim that covers a user script.
Documenting that limit on the field is worth more than making the guess smarter.

## F1 naming

Keep `fresh`, do not add `force` to `verify`.
`force` on `project_command` means "ignore the cache and run", and it is part of the request identity there.
Your design is the opposite: out of the cache key, same ref back, `reused: false`.
Two names for two semantics beats one name for both, and my docs will say `fresh`.
Rejected-in-combination-with-`ref` is what my enforcement already assumes, since a non-executing role is refused any parameter that changes what runs.
The other half is confirmed as needed: keeping the flag out of the key is what lets my analyzer group by digest and still attribute the forced run correctly, and my digest grouping comes from `repositoryState`, never from the ref string.

## Round 2: the one remaining API choice, and a hole this exchange exposed

### D5: use `publish: { flowId }`, not a flat `flowId`

Take the nested form, and the reason is on my side of the boundary rather than a style preference. My enforcement classifies a `verify` call by argument shape: a call that only resolves evidence is free and open to read-only roles, a call that executes is charged and gated. A flat `flowId` would mean "read from that store" on a lookup and "write to that store" on a mint, two different authorities in one identifier, and my classifier cannot tell them apart without your schema. Nested, the distinction is syntactic: `flowId` alone means read, `publish` means write, and I can test `publish !== undefined` exactly the way I already test `scripts !== undefined` for a fail-closed guard.

Four conditions attached, three of which are the D2 lesson applied one release later.

- Reject `publish` together with `ref`. A lookup that also writes evidence is neither of the two things the caller could have meant, and the failure mode of allowing it is a read-only role causing durable writes through a resolution call.
- Keep `publish` out of the authorization fingerprint. You moved `paths` out of that identity for exactly the reason this would recreate: a grant earned by a normal composite gate must not evaporate because the caller also asked for the record to land in a flow store. Do record it on the invocation, and if entitlement fails, refuse with a payload that distinguishes "no composite grant for this shape" from "no permission to publish into that flow", because those need different remedies from me.
- For a caller that is already flow-scoped, publishing to its own flow should be an accepted no-op rather than an error, since its record goes there anyway. If instead it errors, tell me, because then my role prompts have to teach every seat which side of that line it is on, and I would rather encode that once in the tool than twelve times in prompts.
- Knowledge of a flow id is not entitlement. A root publishing into a flow should be checked against what you can see without my registry: require the repository identity to match, and stamp `producerScope`, `delegationId` and `role` on the published record so an audit can tell a publisher that did not belong. My analyzer can then flag a published ref whose producer was not the flow owner, which is the cheapest defence I can build against one session writing evidence into another session's flow.

### The hole: my lookup rule was a blocklist, and your roadmap walks into it

`VERIFY_EXECUTION_PARAMS` in my `src/budget.ts` listed `paths`, `omit`, `scripts`, `covers`, `continueOnFailure`, and the lookup test was "a `ref` plus none of those". Every parameter you add - `ref` co-options, `fresh`, `flowId`, `publish` - would have been classified as a harmless lookup by default, silently, on the day you shipped it, in the one guard that decides whether a read-only role may execute package scripts.

That is fixed here rather than promised: the rule is now an allowlist (`ref`, and `flowId` alongside a `ref`), any unknown parameter counts as execution, and keys carrying `undefined` or `null` are ignored so a serialized full parameter list is not mistaken for an execution. Pinned by a new case in `test/budget.test.ts` and by entries in the shipped-role sweeps in `test/templates.test.ts`, including `{ ref, publish }` and `{ ref, fresh }` as forms a reviewer may not call.

One request falls out of this and it is small: when you ship a parameter that does not change execution, mark it as such in your tool schema or docs. My allowlist needs a source of truth that is not me reading your diffs.

Note that my guidance text still tells seats to call a bare `{ ref }`. That is deliberate: `flowId` lookups and `publish` do not exist in the installed build, and a prompt that advertises an unavailable parameter costs every seat a rejected call. I will widen the guidance in the release that ships them.

### Confirmations on the items you kept

- Ref prefix `pc_`: fine. Tell me when it lands and I will update the refusal sentence in `src/budget.ts` and the pins that quote `vr_`.
- Lookup freshness: return all three, `recorded`, `current`, and `stateMatchesCurrent`, and keep "current state unreadable" distinguishable from "current state differs". That is the whole of `F-033` and the stronger form is the one I want; an unreadable current state must not be summarized as a mismatch, because my validator's correct move differs in the two cases: on a mismatch it re-executes, on unreadable it reports `NOT_RUN` and says why.
- Flow-grant representation: your shape matches my constraints. One composite identity, bound to script fingerprints, only for flow-scoped callers, and it must still prompt when the effective scope is `session` or unset. My spawner narrows scope deliberately for security-sensitive tiers, so a grant that ignores effective scope would authorize exactly the seats I narrowed.
- Aggregate `verify` status mapping: my meter reads the tool payload, not the record, so this is yours to choose. One preference: do not map `incomplete` to `success`. Your vocabulary is about how the process ended and `verify`'s verdict is about whether the gate covered what it claimed, so carry `verdict` verbatim in the record alongside a process `status`, and your stream stays joinable without my knowing the mapping table. `incomplete` caused by omitted phases is honest evidence of a partial gate, and flattening it to `success` is how a stream ends up lying about coverage.

## What I will change on my side as a result

1. `F9`: retire my causal claim about cross-seat fingerprints and record your root cause, with the paths-in-identity mechanism named.
2. `F3` acceptance: rewrite from "no equivalent command runs again in that flow" to "the consumer resolves instead of calling", because that is the half you can give me and the half I can enforce.
3. `F2`: narrow it to your counter-proposal plus a mint-side publish, and drop the root-env export from my asks entirely.
4. One sentence and its test pins whenever your `project_command` ref prefix is chosen.
5. Done in this round: the `verify` lookup classification is an allowlist, so a parameter you add later cannot be mistaken for a harmless lookup by default.
