# Cover message for the `bash-tools` handoff

Paste this above the requirements doc, or send it as the first message with the doc attached.
Doc: `docs/handoffs/bash-tools-flow-cache-requirements.md` (copy it into your repo if you want it versioned there).

---

Task: work through the attached requirements doc for `bash-tools`. It is self-contained, so read it fully before deciding anything. Do not start implementation on R1, R3, R4 or R7 yet; start on R5 and R2.

Context in three sentences. A measurement window over 334 pi sessions found that orchestration cost is dominated by context re-feeding, not by agent count. The two largest removable signals are `git_diff` output volume (4.28M tokens from 547 calls, 22.6% of all tool-result text from 3.9% of calls) and `project_command` duplicate execution (1,075 exact-duplicate excess calls, half of all calls to that tool). Both are structural: the result cache is process-local and session-scoped, so N fan-out subagents re-diff and re-lint a byte-identical working tree N times.

What is already decided, so do not spend effort relitigating it:

- You own your store root. Suggested shape `~/.pi/agent/bash-tools/flows/<flowId>/project-command/`. Nothing of yours goes into a `subagent-herdr` directory, and nothing of ours goes into yours.
- Evidence scope comes from the spawner environment, and a call parameter may only narrow it. That is R1a, and it is the one requirement we consider non-negotiable, because transparent cross-role sharing would quietly end validator independence, which is the property the whole orchestration protocol is built on.
- R5 and R2 need nothing from us and can start now. R5 is the cheapest win in the doc: boolean coercion for `force`, echoing the valid `commandId` set with a nearest match on schema errors, and finding out why `git_log` errors on 48.4% of calls and `git_status` on 19.2%. R2 is the biggest token win: make `maxBytes` optional with an 8-16 KiB default, add a stat-plus-hunk-headers mode, add per-path hunk fetch, and stop returning a byte-sliced patch that a model can mistake for a complete diff.

What we will do on our side, in this order: export the orchestration identity into child process environments (`PI_ORCHESTRATION_FLOW`, `PI_DELEGATION_ID`, `PI_ORCHESTRATION_ROLE`, `PI_ORCHESTRATION_EVIDENCE_SCOPE`, tier and mode), then create the flow directory and its `flow.json` manifest, then per-delegation telemetry. Until that ships, treat the env names in the doc as the contract and build the fallback path first, which is the no-env case anyway. If we need to change a name, we will tell you before shipping rather than after.

Two things in the doc we would specifically like pushback on rather than agreement:

- R3 `verify` needs a larger time and output budget than the current `PROJECT_COMMAND_PROCESS_TIMEOUT_MS = 30_000` and `PROJECT_COMMAND_OUTPUT_LIMIT_BYTES = 50 * 1024`. A format-plus-lint-plus-typecheck-plus-tests run does not fit in 30 seconds and 50 KiB. Tell us whether you would rather raise those for this one command or stream and return a failure tail, since you know the policy gate implications far better than we do.
- R4 assumes tool-issued validation refs are cheap because `projectCommandStateSnapshotDigest` already produces the repository-state reference the protocol needs. If that is wrong, say so early, because it decides whether our validator workstream waits on you or works around you.

Deliverables we would like back:

1. Answers to the six open questions at the end of the doc.
2. Confirmation or correction of the R1 interface approach, specifically whether widening the namespace argument on the existing `ProjectCommandResultCache` interface is workable or whether you want a separate persistence layer.
3. A statement of the no-env fallback guarantee in your own words, since every requirement depends on that being a zero-change path.
4. Your priority ranking of R5, R2, R1, R1a, R3, R4, R6, R7, R8, R9 from your side, with anything you think is misprioritized called out explicitly.

Constraints to respect while working the doc: no imports from or dependence on `subagent-herdr`; no role or workflow policy inside `bash-tools`, since role capabilities are enforced by us at spawn time via `--tools`; no weakening of authorization or confirmation gates to buy performance; no behavior change when the orchestration environment is absent.

Baseline numbers for measuring your wins are in Appendix B of the doc. One caveat repeated there because it changes how you should rank: dollar attribution in that window is unreliable, so rank by steps and tokens and treat cost as a tiebreaker.
