# Decision request: four forks block T1-T4

From `bash-tools` to `subagent-herdr`.
Follow-up to `docs/handoffs/BASH_TOOLS_FOLLOWUPS.md`.
Owner of implementation: `bash-tools`.
Owner of the orchestration contract: `subagent-herdr`.

We are asking one thing per decision: **does your consuming side need a particular implementation of it?**
If you have no constraint, reply "no constraint" and we take our stated default.
One line per decision id is a sufficient answer.

## Six things we verified in our own source before asking

1. **The F9 root cause is neither of your two hypotheses.** The decision *is* shared across seats of one project; the *shape* is what differs.
   `verificationIdentity` (`src/tools/verify/tool.ts:380-395`) folds `displayCommand(resolved)` for every phase into the authorization fingerprint.
   `resolveSteps` (`:300-303`) forwards `input.paths` into the test-phase resolution, whose `displayCommand` is `executable + args` (`src/tools/project-command/node/command-resolution.ts:57,204`).
   So `verify` with `paths` and `verify` without them are two different authorization identities, and so are two different `paths` sets.
   The identity also folds `scriptFingerprint`, which is the literal package-script text, so editing a script in `package.json` re-prompts.
   A third candidate is that project keys are `realpath(ctx.cwd)`, so a child seated in a subdirectory is a different project.
   Your "seven allowed shapes and two denied, accumulated from an interactive seat" is consistent with all of this.
2. **There are no cache-eligible `project_command` executions among the commands F3 names.** `node_test`, `node_build`, `node_lint`, `node_typecheck`, `node_format` and all six `fallow_*` are declared `reusePolicy: "never"` plus `uncontrolledExternalState: true` (`src/tools/project-command/definitions.ts:211-486`).
   `projectCommandReusePolicy()` (`:547-562`) returns `never` whenever either flag holds, overriding the declared value.
   `cacheIsEligible()` (`runner.ts:537-558`) refuses those.
   F3's "a worker mints a `node_build` ref" is therefore not reachable by adding a `ref` parameter to the existing cache path.
3. **R7 join keys are absent from the record entirely.** `flowId`, `delegationId` and `role` are parsed from env (`src/tools/project-command/orchestration.ts:26-33`) but `ProjectCommandInvocationRecord` (`src/observability/project-command-invocation.ts:80-99`) carries only `sessionId` and `producerScope`.
   Separately, `verify` emits no invocation record at all: it is registered at `src/index.ts:46` with no recorder, unlike `project_command` at `:40-45`.
   Your F2 acceptance (root-session records join on `flowId` alone) and F7 acceptance (join on `flowId` or `delegationId`) are both blocked behind this.
4. **F4 is already partly landed.** `invalidRequest` (`src/tools/project-command/schema/validation.ts:50-74`) emits `invalidField` plus a remediation line, misspelled `commandId` errors already carry a nearest-match `correctedExample`, and `force` already coerces `"true"` and `"false"` (`:227`).
   The remaining gap is precisely the one your workers hit: `paths` supplied as a string is rejected with no expected-shape example (`:177`, `parameters/validation.ts:44-50`) and there is no array coercion.
5. **F8 stays withdrawn.** `contentDigest` (`src/tools/project-command/repository-state.ts:96-163`) runs `git hash-object -- <paths>` over every dirty path and folds hash, mode, size and status, rejecting the read on a pre/post `lstat` disagreement.
   We still owe your documentation ask, plus something bigger: the README documents neither the digest semantics, nor refs and reuse, nor the `verify` tool, which is missing from its tool catalog entirely.
6. `npm run test:analyze` from your "Baseline for measuring F1 to F3" does not exist in our `package.json`.
   Tell us which analysis you want re-run and we will add the script rather than invent a proxy.

## D1 (blocks F3) Does a ref mean "addressable" or "replayable"?

F3 asks for a ref on every cache-eligible `project_command` execution.
Per observation 2, none of the named commands is cache-eligible, so we must choose what a `project_command` ref is.

Our default: **addressability-only.**
We would store and resolve evidence for script and Fallow executions without ever returning them as a cache hit that skips execution.
Reuse policy stays `never` for every script and Fallow command, and your F3 acceptance line "neither the resolved command nor an equivalent one runs again in that flow" is then satisfied by the validator choosing not to re-run, not by our cache short-circuiting it.

What we need from you:

- [ ] Is resolve-by-ref sufficient, or do you need any of these command ids to become *replayable* (a hit that avoids execution)?
- [ ] If replayable, name the ids.
      We will not make `node_format` replayable under any option here, because it can write the tree.
- [ ] Should `project_command` refs share the `vr_` namespace with `verify`, or get a distinct prefix so the record type is identifiable from the identifier alone?
- [ ] Should `covers` on a `project_command` record behave byte-identically to `verify` (stored verbatim, never interpreted, part of the key so a different coverage claim is a different ref)?
      Our assumption is yes, and we would match `verify`'s rule that a lookup carries no execution options.

## D2 (blocks the durable half of F9) Is `paths` inside the auth fingerprint on purpose?

Today it is, per observation 1.
That is defensible: a different forwarded argument set is a different call.
It is also why a grant earned interactively did not cover your child seats.

Our default: **keep it strict, and fix the ergonomics instead.**
We would make refusals print the exact rejected identity, and allow that identity to be pre-seeded in project policy, so a one-time interactive run yields a copyable grant.

What we need from you:

- [ ] Do your validators ever need authorization to differ per path set, or is per-path-set granularity dead weight for you?
- [ ] If dead weight, is this split acceptable: `paths` stays in the cache key, and comes out of the authorization identity.
      That means one grant covers every path set of a given script set, which is a real loosening and we want it on the record before we do it.
- [ ] Is `scriptFingerprint` in the identity wanted too?
      Keeping it means package-script edits always force a fresh grant; dropping it means an edited script body runs under a prior grant.
      Our preference is to keep it.

## D3 (blocks the unattended half of F9) How is a flow-scoped `verify` grant expressed?

Three shapes, materially different trust models, we will not pick for you.

1. New project-scope policy field for `verify`.
   Costs a policy document version plus a migration step alongside the existing v1 to v4 chain, and requires the operator to opt in once per project.
2. A wildcard-fingerprint identity shape for `commandId: "verify"`.
   Cheap at read time; `policy/document.ts:41-58` currently requires exactly `{commandId, fingerprint}`, so a wildcard needs a new validated record shape, and it makes one entry cover every future script set.
3. Auto-allow when the spawner set `PI_ORCHESTRATION_EVIDENCE_SCOPE=flow`.
   Zero configuration for you, but it means an environment variable alone authorizes package-script execution.
   We are reluctant, because that env var is an orchestration hint rather than a human authorization.

What we need from you:

- [ ] Is one-time opt-in operator configuration acceptable, or do you need zero-config child seats?
- [ ] Granularity: one grant covering all four phases, or per-phase grants?
- [ ] Does your spawner set `PI_ORCHESTRATION_EVIDENCE_SCOPE=flow` for **every** child, or only some?
      If only some, our grant must key on effective scope rather than on the presence of a flow id, and a security-sensitive tier narrowed to `session` must still prompt.
- [ ] Pushback on your F2 proposal, needs your answer before either side implements: exporting `PI_ORCHESTRATION_FLOW` into the **root** process promotes every root-session `verify` and `project_command` from the process-local store to the durable flow store.
      That makes root refs readable by other processes and starts persisting evidence a human seat previously never wrote.
      Your "a session that never delegated sees no change" acceptance survives only because the export is lazy, so the first delegation silently changes behaviour for the rest of that session.
      Our counter-proposal is `verify { ref, flowId }`, an explicit lookup naming a store the caller may read, which keeps root behaviour byte-identical and closes your last-hop verification gap in one call.
      Confirm which route, or tell us why the route you proposed is preferable for your role model.

## D4 (blocks T1 and F1's record checkbox) What does one `verify` invocation record mean?

`verify` is one model call over up to four phase executions.
The current record shape has singular `status`, singular `output { stdout, stderr }`, singular `executionDurationMs` and singular `commandId`.
A composite does not fit without a decision.

Our default: **one aggregate record per `verify` call**, `commandId: "verify"`, stdout and stderr bytes summed across phases, `status` set from the aggregate verdict, `executionDurationMs` summed, per-phase detail left in the tool payload and the evidence record rather than duplicated into the observability stream.

What we need from you:

- [ ] What does your `verify:N ran:M` metric count, model calls or phase executions?
      Pick the answer that makes your target `ran:1` per distinct repository state per flow still mean what you think it means.
- [ ] Does your join require one observability row per model step, or does one row per tool call suffice?
- [ ] We intend to add `flowId`, `delegationId` and `role` as optional additive fields **without** bumping `invocationFormatVersion` off 1, and the same for `summaryFormatVersion`.
      Confirm your parser tolerates fields it does not know and does not validate an exact key set, otherwise we bump and you must ship a reader first.
- [ ] Your R7 line about `repeatedUnchangedRequests` asks for *which* request key repeated; we persist only a count today.
      Do you consume it?
      Yes means a summary shape change and you should say what key granularity you need; no means we drop the requirement.

## Bonus (F6, not blocking T1-T4)

`mutatesWorkspace: true` exists on exactly one definition, `node_format` (`definitions.ts:322`), and it is per-definition rather than per-variant.
So `format:check` currently reports as mutating, and `lint:fix` reports as non-mutating.
When F6 lands, do you want the conservative constant or a variant-derived value that can be wrong in the other direction?
Your name-shaped `repositoryWriteLock` guess is only as good as this answer.

## What we will start on without waiting for these answers

- `verify` recorder wiring plus the `flowId`, `delegationId` and `role` additive fields.
- F1 `fresh: true`, keeping the flag out of the cache key so a forced re-run returns the same ref with `reused: false`, and rejected in combination with `ref` per the existing lookup rule.
      Tell us now if you would rather call it `force`, for consistency with `project_command`.
- The F9 refusal payload: name the rejected `{ commandId, fingerprint }`, the project path it was searched under, the scope searched, and the effective evidence scope, replacing the single opaque `verify authorization failed: <kind>`.

Object within one round if any of these three conflicts with something you are building.
