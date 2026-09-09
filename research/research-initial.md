# Pi session findings for 2026-09-09

## Report scope

This report analyzes Pi sessions stored in `backend/data/token-tracker.db`.

The analysis window is `2026-08-09T23:11:43.969Z` through `2026-09-08T23:11:43.969Z`.

The window uses `sessions.started_at`, matching the analyzer's current window semantics.

The database's `last_seen_at` values are import-time values and were not used as activity timestamps.

All findings come from read-only SQLite and filesystem analysis.

The original report investigation did not run repository tests, lint commands, formatting commands, git checks, or project validation commands.

The analyzer telemetry implementation was checked separately after the original report was written, but those checks are not historical session findings.

Commands and test failures mentioned in this document are historical telemetry recorded in the database unless explicitly labeled as analyzer validation.

## Executive summary

The dominant inefficiencies are repeated context acquisition, failed mutation requests, repeated validation, and large orchestration fan-out.

The largest immediate optimization targets are:

1. Typed preflight validation for tool arguments.
2. Better stale-context and uniqueness handling for `edit`.
3. Cross-child caching of reads, diffs, searches, and validation results.
4. Retry policies that distinguish malformed requests from transient provider failures.
5. Explicit fan-out and repeated-validation budgets.
6. Compact child-session contracts backed by content-addressed artifacts.
7. A shared workspace evidence broker for `read`, search, diff, status, and validation results.
8. Constrained search, batch-read, diff-summary, workspace-state, and ledger-summary tools.
9. Weekly telemetry review so orchestration improvements are not mistaken for overall tool-discipline improvements.

The cost totals are significant, but the more important signal is the amount of repeated context and repeated work.

The analyzer now emits retry, latency, normalized-error, duplicate-scope, artifact, cost-reconciliation, orchestration, and data-quality sections for machine-assisted follow-up analysis.

Cache hit rates above 98% conceal more than 3.3 billion cache-read tokens and should not be interpreted as evidence of efficient orchestration.

## Scope and accounting

| Metric                       |         Value |
| ---------------------------- | ------------: |
| Sessions                     |         1,154 |
| Root sessions                |           150 |
| Child sessions               |         1,004 |
| Model steps                  |        42,558 |
| Tool calls                   |        59,207 |
| Paired tool results          |        59,167 |
| Tool-result errors           |         5,058 |
| Steps without computed cost  |         2,378 |
| Input tokens                 |    41,933,642 |
| Output tokens                |    24,278,492 |
| Cache-read tokens            | 3,314,890,652 |
| Computed cost                |   $166.925735 |
| Reported cost                |   $151.308863 |
| Computed minus reported cost |    $15.616872 |

The computed/reported cost difference is approximately 9.36% of computed cost.

The root sessions account for `$97.829191` of computed cost.

The child sessions account for `$69.096544` of computed cost.

The largest computed/reported differences are concentrated in these provider/model combinations:

| Provider and model                |                   Computed cost |                   Reported cost | Difference |
| --------------------------------- | ------------------------------: | ------------------------------: | ---------: |
| `github-copilot` / `gpt-5.6-luna` |                     $100.566809 |                      $89.837218 | $10.729591 |
| `github-copilot` / `gpt-5.6-sol`  |                      $12.896169 |                       $8.357268 |  $4.538901 |
| `cortecs` / `qwen3.8-flash-next`  | Not material to the total delta | Not material to the total delta |  $0.231318 |

The provider/model pricing tables and reported-cost accounting should be reconciled before using either total as an invoice authority.

## Model-step outcomes

Model-step outcomes were:

| Outcome          |  Steps |
| ---------------- | -----: |
| `toolUse`        | 37,526 |
| `stop`           |  2,355 |
| `error`          |    217 |
| `cancelled`      |     50 |
| `length`         |     26 |
| Null stop reason |  2,384 |

The 217 model steps with `stop_reason='error'` are a different failure layer from the 5,058 tool-result errors.

The 2,378 steps without computed cost were primarily `thinking_level_switch` and `model_switch` roles.

These control events should have explicit cost-exclusion reasons instead of being reported only as unknown cost.

## Cache and context volume

Root cache hit rate was approximately 98.86%.

Child cache hit rate was approximately 98.60%.

The cache-read total exceeded 3.3 billion tokens despite those high percentages.

The analyzer should report absolute cached and uncached context volume, not only hit rate.

Useful additional metrics include cache-read tokens per successful workflow, cache-read tokens per child, and repeated cached context attributable to duplicate requests.

## Weekly trend inside the 30-day window

Four consecutive full seven-day buckets were computed using the same `sessions.started_at` semantics as the main report.

The first two days of the 30-day window, from `2026-08-09T23:11:43.969Z` through `2026-08-11T23:11:43.969Z`, are a separate residual bucket with 51 sessions, 3,225 tool calls, and 201 tool-result errors.

The weekly comparison is recent performance versus earlier weekly buckets, not a comparison of independent samples.

| Bucket                        | Calls per day | Tool error rate | Duplicate excess | Cross-child duplicate excess | Overall latency p95 | Subagent latency p95 | Cost delta | Maximum fan-out |
| ----------------------------- | ------------: | --------------: | ---------------: | ---------------------------: | ------------------: | -------------------: | ---------: | --------------: |
| 2026-08-11 through 2026-08-18 |         1,983 |           6.31% |            5.35% |                       16.03% |              13.7 s |               26.3 m |     19.32% |              51 |
| 2026-08-18 through 2026-08-25 |         1,400 |           8.25% |           10.72% |                       16.03% |              19.0 s |               62.4 m |      5.34% |              60 |
| 2026-08-25 through 2026-09-01 |         1,883 |           9.93% |           11.38% |                       20.68% |               4.7 s |               17.5 m |     13.42% |              72 |
| 2026-09-01 through 2026-09-08 |         2,732 |           9.76% |           12.88% |                        6.28% |               5.0 s |                6.1 m |      0.12% |              39 |

The last week shows a clear orchestration recovery.

Cross-child duplicate excess fell from 20.68% to 6.28%, the maximum fan-out fell from 72 to 39, subagent p95 latency fell from 17.5 minutes to 6.1 minutes, and the computed/reported cost delta fell from 13.42% to 0.12%.

Retry behavior also improved from the previous week.

The fraction of failed calls that were repeated fell from 24.2% to 15.2%, while the conditional success rate of those retries rose from 41.6% to 50.9%.

The recovery did not improve overall tool discipline.

Exact duplicate excess continued to rise across the four buckets from 5.35% to 12.88% of calls.

Tool error rates also rose from 6.31% to approximately 9.8%.

The latest week had 1,609 excess `project_command` calls out of 2,359 calls, or 68.2% excess within that tool.

The current interpretation is that orchestration became less redundant across children while root-local validation and repeated-work churn remained unresolved.

## Custom-tool opportunities for subagent-herdr and bash-tools

A raw `rg` alias is unlikely to materially reduce token usage by itself.

The existing `grep` interface already exposes pattern, literal, path, glob, case-sensitivity, context, and result-limit controls.

The main search problem is repeated requests and oversized result payloads rather than only search-engine speed.

During the latest seven-day bucket, the largest captured result-volume sources were:

| Tool                | Calls | Estimated result tokens | Errors | Duplicate excess |
| ------------------- | ----: | ----------------------: | -----: | ---------------: |
| `read`              | 6,382 |              10,854,722 |    225 |              124 |
| `grep`              | 2,682 |               4,603,517 |    126 |                8 |
| `git_diff`          |   628 |               2,862,558 |     32 |               58 |
| `codegraph_explore` |   437 |               2,048,141 |      2 |                0 |
| `read_batch`        |   216 |                 832,956 |      0 |                0 |
| `project_command`   | 2,359 |                 663,284 |    662 |            1,609 |

The result-token estimates are captured-content proxies based on the analyzer's character-to-token estimate, not direct provider billing.

The first four tools alone emitted approximately 20.4 million estimated result tokens in the latest week.

### P0: Shared workspace evidence broker

The highest-value addition is a read-only evidence cache shared across root and child sessions.

The cache key should include the workspace fingerprint, tool name, canonical arguments, and the relevant file or repository fingerprint.

It should cover `read`, `read_batch`, search, `git_diff`, `git_status`, and validation commands.

A cache hit should return an artifact ID, content hash, compact summary, and reference to the stored content instead of making every child receive the full result again.

The cache must invalidate affected evidence after `edit`, `write`, `delete`, or `move` operations.

Recent examples justify this priority:

- One `git_status` request repeated 32 times across 17 child sessions.
- One flow ledger was read 26 times across 26 child sessions.
- One `project_command` format check repeated 25 times across 9 child sessions.
- The same flow ledger was read 81 times across 40 sessions.

### P0: Cached validation command tool

`project_command` should expose typed command IDs such as `node_test`, `node_lint`, `node_format`, and `node_typecheck`.

Results should be cached by workspace fingerprint, command ID, arguments, relevant environment, and lockfile or package fingerprint.

Unchanged retries after schema errors should be rejected.

The result should contain the exit code, concise summary, failure count, cache status, artifact ID, and output tail.

Full command output should be available through an artifact reference rather than automatically inserted into the next model context.

### P1: Constrained `search_code` tool

The preferred search addition is a semantic wrapper around the existing search capability, not a second unconstrained search command.

It should support `count`, `files`, `matches`, `context`, and `symbols` modes.

The default should return file names and match counts rather than every matching line.

Every request should enforce maximum matches, maximum bytes, bounded context lines, and pagination cursors.

Search results should include a stable result ID, workspace fingerprint, content hash, and query metadata.

This would reduce context volume while preserving a path to fetch exact snippets only when needed.

### P1: Artifact-oriented batch reads

`read_batch` is already present in the latest telemetry with 216 calls, approximately 833,000 estimated result tokens, no errors, and no exact duplicate excess calls.

It should become the default interface for related file reads.

It should support multiple paths and ranges, overlap removal, per-file and total byte limits, head and tail modes, content hashes, and continuation cursors.

The analyzer currently treats `read` as a read observation but does not yet include `read_batch` in the same artifact analysis.

That analyzer gap should be fixed so batch reads are included in path repetition, result hashes, and artifact freshness metrics.

### P1: Cached workspace state

`git_status` produced 629 calls, 187 errors, and 235 duplicate excess calls in the latest week.

A `workspace_state` tool should return a compact repository fingerprint, commit, dirty flag, changed files, staged files, untracked files, and status hash.

Repeated requests should use the cached state unless a mutation or explicit refresh occurred.

### P1: Structured and bounded diffs

`git_diff` should distinguish `names`, `stat`, and `patch` modes.

The default should return changed files and statistics.

Full patches should require explicit path selection and a byte limit.

The request schema should reject empty paths, simultaneous `path` and `paths`, stringified arrays, and non-numeric `maxBytes` before dispatch.

Diff results should include file hashes, pagination cursors, and cache metadata.

### P1: Flow-ledger summary and tail tools

Append-only flow ledgers should not be reread from byte zero by every child.

Specialized operations should include `flow_summary`, `flow_tail`, and incremental `flow_events` by byte offset or content hash.

A summary should contain current status, latest decision, producer and consumer scopes, pending work, recent errors, content hash, byte count, and event count.

### P2: Compact symbol context

`codegraph_explore` generated approximately 2.05 million estimated result tokens in the latest week despite only two errors.

A compact `symbol_context` operation should return a definition, direct callers, direct callees, file path, relevant line range, signature, and content hash.

The existing exact `codegraph_callers` and `codegraph_callees` operations already provide part of this behavior.

### Orchestration-only reductions

`codegraph_sync` was called 254 times in the latest week with approximately 91% duplicate excess.

It should become a no-op when the index is current, and callers should invoke it only after actual source changes.

`verify` produced 263 calls, 65 errors, and 55 duplicate excess calls in the latest week.

It should use typed targets and workspace-fingerprint result caching.

## Duplicate and repeated work

The analyzer identified 2,085 exact-duplicate request groups.

There were 5,877 excess duplicate calls after the first request in each group.

There were 994 duplicate calls with identical results.

Repeated results represented approximately 3,814,940 result tokens and approximately `$15.35` of associated model-step cost.

The associated-step cost is not an invoice-level savings estimate because a model step can contain both duplicate and useful calls.

The duplicate categories overlap with retry, same-root, and cross-child repetition.

### Cross-child and same-root duplication

The strongest cross-session repetition signals were:

| Tool              |  Calls |               Unique requests | Global excess |              Same-root excess |            Multi-child groups |
| ----------------- | -----: | ----------------------------: | ------------: | ----------------------------: | ----------------------------: |
| `read`            | 20,143 |                        14,124 |         6,019 |                         3,554 |                         1,589 |
| `git_diff`        |  1,298 |                           933 |           365 |                           260 |                            56 |
| `project_command` |  5,212 | Not available in this summary |         3,177 | Not available in this summary | Not available in this summary |

Repeated requests included `git_diff` of `next-env.d.ts`, broad repository diffs, repeated `package.json` reads, repeated test and lint commands, and repeated flow-ledger reads.

A workspace-scoped evidence broker should share read-only results across children.

A suitable cache key should include the workspace fingerprint, tool name, canonical arguments, and the relevant file or repository fingerprint.

Mutation tools should invalidate affected evidence.

## Tool usage and failures

Tool-result errors are reported separately from model-step errors.

The main tool call volumes and error counts were:

| Tool              |  Calls | Errors | Error rate |
| ----------------- | -----: | -----: | ---------: |
| `read`            | 20,143 |    522 |       2.6% |
| `edit`            |  8,488 |    846 |      10.0% |
| `grep`            |  6,542 |    266 |       4.1% |
| `bash`            |  6,724 |    916 |      13.6% |
| `project_command` |  5,212 |  1,543 |      29.6% |
| `git_diff`        |  1,298 |    179 |      13.8% |

The `bash` failures require further separation into invalid invocations, non-zero command exits, timeouts, policy denials, missing dependencies, and provider/runtime failures.

### `edit` failures

`edit` produced 846 errors from 8,488 calls.

The normalized error categories were:

| Category                       | Errors |
| ------------------------------ | -----: |
| Old-text mismatch              |    507 |
| Identical or no-op replacement |    146 |
| Non-unique old text            |    145 |
| Overlapping edits              |     24 |

The four categories account for 822 of 846 errors, or approximately 97.2% of all `edit` errors.

Representative exact errors were:

- `Could not find edits[0] in src/runtime/pi-adapter.ts. The oldText must match exactly including all whitespace and newlines.`
- `Found 2 occurrences of edits[4] in src/workflow/fixture-runner.ts. Each oldText must be unique.`
- `No changes made to src/classification/npmTrust.ts. The replacement produced identical content.`
- `edits[2] and edits[3] overlap in src/classification/parseTree.ts`

Historical edits also targeted `src/run.ts`, the `scopedTask` function, `src/tools.ts`, `src/execute.ts`, and `src/tools/verify/tool.ts`.

The `edit` workflow should read current context, require unique old text, reject no-op replacements, reject overlapping edits, and permit at most one read-and-rebase recovery.

An old-text mismatch should be classified as `stale_context`, not as a generic retryable tool failure.

### `project_command` failures

`project_command` produced 1,543 errors from 5,212 calls.

It also had 3,177 excess duplicate calls.

A representative schema error was:

```text
Validation failed for tool "project_command": ... force: must be boolean ... Received arguments: { "commandId": "node_test", "force": "True" }
```

This request should be rejected and repaired before reaching the tool implementation.

The repeated command IDs were particularly concentrated around `node_test`, `node_lint`, formatting, and typecheck commands.

Validation results should be cached by working-tree fingerprint, lockfile/package fingerprint, command ID, arguments, and relevant environment values.

### `git_diff` failures

`git_diff` produced 179 errors from 1,298 calls.

Malformed requests included stringified arrays, string `maxBytes`, empty paths, and both `path` and `paths`.

Representative exact errors were:

- `provide either path or paths, not both`
- `path must not be empty; action: Correct the path field or request shape and retry.`

The request schema should use a strict tagged union with either one non-empty `path` or a non-empty `paths` array.

`maxBytes` should be validated as a number before dispatch.

## Retry behavior

There were 848 failed tool calls that repeated the same request within the next five calls.

Those retries represented 276 exact request patterns.

Of the 848 repeated requests, 413 eventually succeeded.

The remaining repeated requests did not succeed and represent likely retry waste or unresolved workflow problems.

Retry distances were commonly two to five calls for `project_command` and `bash`.

That spacing suggests orchestration interleaving rather than immediate targeted recovery.

Every retry should record its source call, distance, normalized error class, argument changes, workspace fingerprint, delay, and final outcome.

Recommended retry classes are:

| Error class                           | Recommended behavior                                     |
| ------------------------------------- | -------------------------------------------------------- |
| Invalid schema or argument            | Do not retry unchanged                                   |
| Missing or stale edit context         | Re-read and re-plan once                                 |
| Empty or malformed `git_diff` request | Repair the request before retry                          |
| Timeout                               | Exponential backoff with bounded attempts                |
| 502 or 504                            | Provider retry with backoff                              |
| OAuth refresh failure                 | Refresh credentials or switch provider                   |
| `terminated` or user cancellation     | Do not immediately repeat                                |
| Missing module                        | Fix the environment or report dependency failure         |
| Test or lint failure                  | Treat as repository evidence, not transient tool failure |
| Model unavailable                     | Apply provider/model fallback policy                     |

An unchanged retry after a client-side validation error should be blocked.

## Orchestration and subagents

The analyzer recorded 1,060 `subagent` calls, 888 delegation calls, 1,004 child sessions, and 1,003 linked children.

The largest persona groups were workers, reviewers, validators, planners, and scouts.

The persona distribution was:

| Persona   | Sessions |
| --------- | -------: |
| Worker    |      330 |
| Reviewer  |      259 |
| Validator |      211 |
| Planner   |       94 |
| Scout     |       80 |

### Fan-out

Across 150 roots:

- 31 roots launched at least 10 children.
- 16 roots launched at least 20 children.
- 4 roots launched at least 50 children.
- The maximum fan-out was 72 children.

Fan-out was not necessarily wasteful in every case, but it is large enough to justify explicit workflow budgets.

Recommended thresholds are:

- Warn at 10 children per root.
- Require an orchestration reason at 20 children.
- Require explicit override above 50 children.
- Limit repeated validation of the same scope unless the workspace or evidence fingerprint changed.
- Prefer one worker artifact consumed by multiple validators over multiple validators independently reconstructing the same context.

### Reuse behavior

There were 31 calls with a non-empty `reuseLabel`.

Observed outcomes included 19 reuse/reference-style completions, 7 invalid-parameter responses, 3 missing-label responses, 1 `Reuse error: terminated`, and 1 completion without an explicit reuse marker.

The invalid calls returned:

```text
Invalid parameters. Provide exactly one mode (single, parallel, chain, reuse, list, or agents). Available agents: planner (user), reviewer (user), scout (user), validator (user), worker (user)
```

The missing-label responses included:

```text
Reuse failed: No subagent session labeled "wJ:worker-5". Use listSubagents to see available sessions.
```

Reuse should first verify the active label and then dispatch exactly one explicit mode.

Labels should be scoped by root session and orchestration flow to prevent collisions.

### Link status versus child outcome

For children whose own `started_at` falls inside the requested window, the link statuses were:

| Link status      | Children |
| ---------------- | -------: |
| `success`        |      955 |
| `unknown`        |       37 |
| `error`          |       11 |
| No matching link |        1 |

Link status is not equivalent to final child execution success.

Three children with `session_links.status='success'` had final persisted model steps with `stop_reason='error'` and `terminated`.

One child with link status `error` ended with `Request timed out.`.

One unlinked child ended with `stop_reason='cancelled'` and `Aborted after 2 retry attempts`.

The analyzer now reports `link_status` and `child_terminal_outcome` as separate fields.

Two different valid joins produce different link totals.

The child-window join contains 955 success, 37 unknown, and 11 error links plus one unlinked child.

The narrower parent-window join contains 977 link rows with 930 success, 37 unknown, and 10 error statuses.

These values must remain labeled by join scope.

## Artifact usefulness and storage

### Flow ledgers

Twenty-seven flow ledgers were read 357 times.

The captured results totaled 4,722,453 bytes.

The actual ledger files totaled 570,835 bytes.

The largest ledger was:

```text
/Users/cristian.spissack/.pi/agent/subagent-herdr/flows/f4a7c827e86180efe/ledger.md
```

It was read 81 times across 40 sessions and 2 roots.

Those reads were not all identical.

There were 80 unique result hashes, with result lengths from approximately 790 bytes to approximately 51 KB.

A blanket permanent full-ledger cache would therefore be incorrect.

The ledger is append-only, so the preferred protocol is a stable summary plus incremental tail reads from the last observed byte offset or content hash.

### Other repeated artifacts

Other heavily reread files included:

- `PLAN.md`: 428 reads and approximately 4.1 MB captured.
- `package.json`: 524 reads and approximately 2.45 MB captured.
- `src/tools/project-command/runner.ts`: 275 reads and approximately 2.27 MB captured.

### Subagent result volume

There were 1,058 paired subagent results totaling approximately 6.4 MB of captured result text.

Approximately 757 results mentioned a report or report-related artifact.

Approximately 204 explicitly mentioned a full report.

Sixteen results were `Subagent was aborted`.

Child responses should prefer a compact status contract containing the verdict, acceptance criteria, changed files, evidence references, artifact path, and artifact hash.

The parent should fetch full report prose only when necessary.

### Database storage

The database is approximately 1.39 GB.

`session_messages` consumes approximately 1.20 GB according to `dbstat`.

Repeated tool-result content is therefore a material storage issue even though the flow ledgers themselves are small on disk.

Potential improvements include content-addressed result storage, compression for large results, artifact references instead of repeated full content, and retention policies for duplicate results.

There is a truncation metadata inconsistency.

Sixty `bash_execution` messages had non-null truncation metadata, but a direct query for `output_truncated = 1` returned zero rows and no `full_output_path` values were populated.

This should be treated as a telemetry or schema issue until the field semantics are verified.

Result sizes clustering near approximately 51 KB also warrants investigation.

## Historical validation failures

The following are historical telemetry findings and were not executed during this analysis.

Observed examples included failures in `src/lib/services/pull-requests.integration.test.ts`.

Another recorded failure was `test/execute.test.ts:615` in `executeSubagent - composition policy`, where one warning was expected but two were received.

Other recorded model-step errors included:

- `Request timed out.`
- `terminated`
- `Operation aborted`
- `This operation was aborted`
- GitHub Copilot OAuth refresh failures.
- OpenAI stream termination.
- Model-unavailable errors.
- 502 and 504 responses.
- Missing modules.
- Insufficient OpenCode balance.

These failures should not enter one retry bucket.

A failed test is repository evidence, a 504 is a provider failure, and a malformed tool request is an orchestration failure.

## Recommended workflow rules

### P0: Enforce typed tool preflight

Validate every tool request against its schema before dispatch.

Normalize arrays, booleans, numbers, paths, and tagged unions before execution.

Reject malformed requests with a structured repair instruction instead of retrying unchanged.

This directly addresses `force: "True"`, simultaneous `path` and `paths`, empty paths, stringified arrays, string `maxBytes`, and invalid subagent mode combinations.

### P0: Add mutation-context guards

For `edit`, require the current file fingerprint and enough surrounding context to make `oldText` unique.

Reject no-op replacements and overlapping edits before dispatch.

Permit one read-and-rebase recovery, then return a structured stale-context failure.

### P0: Deduplicate read-only evidence

Share `read`, `git_diff`, `grep`, test, lint, format, and typecheck results across children using workspace and artifact fingerprints.

Invalidate affected evidence after mutation.

### P1: Add normalized retry control

Use retryability classes, bounded attempts, exponential backoff, and changed-argument tracking.

Do not retry unchanged requests for schema errors, invalid paths, duplicate edits, failed assertions, missing reuse labels, or invalid subagent modes.

### P1: Add fan-out and validation budgets

Track per root child count, delegation depth, concurrent children, repeated scopes, repeated commands, total child cost, and total child latency.

Require explicit justification for large fan-out and repeated validation.

### P1: Use structured child contracts

Every child should return `delegation_status`, `validation_verdict`, `review_verdict`, `acceptance_criteria`, `scope`, `files_changed`, `commands_run`, `artifact_path`, `artifact_hash`, `evidence_refs`, and `session_outcome`.

The parent should receive the compact contract rather than the full report by default.

### P2: Improve artifact reads

Support summary, tail, and byte-offset reads for append-only files such as ledgers.

Return content hashes and file metadata with every artifact read.

Cache immutable ranges and detect stale reads using file size, mtime, and content hash.

Store report references rather than repeatedly storing full report contents.

## Analyzer telemetry status and remaining gaps

The analyzer implementation in `analyzer/analysis.ts`, `analyzer/types.ts`, `analyzer/schema.ts`, `analyzer/sqlite.ts`, and `analyzer/telemetry.ts` now emits retry, latency, normalized-error, duplicate-scope, artifact, cost-reconciliation, orchestration, and data-quality sections.

The analyzer retains raw request arguments, exact error messages, result hashes, result bytes, timestamps, and bounded examples instead of collapsing evidence into normalized categories only.

The remaining analyzer work should focus on making the new sections complete for all read-like tools and on connecting telemetry to workspace and artifact identities.

### Retry analysis

The analyzer now reports retry distance, retry success, argument-change indicators, original and retry call IDs, and normalized error categories.

Remaining fields should include retryability class, workspace-fingerprint change, backoff duration, and an explicit `retry_of_call_id` field.

### Tool latency

The analyzer now reports p50, p95, p99, and maximum paired call-to-result latency.

Separate provider execution time from orchestration queue time where timestamps permit.

Current paired-result measurements were:

| Tool              |        P50 |          P95 |          P99 |       Maximum |
| ----------------- | ---------: | -----------: | -----------: | ------------: |
| `subagent`        | 106,692 ms | 1,269,860 ms | 3,011,242 ms | 21,252,262 ms |
| `project_command` |   1,320 ms |    26,141 ms |   120,025 ms |    967,299 ms |
| `bash`            |     763 ms |    21,444 ms |   289,541 ms |  2,472,645 ms |
| `read`            |      15 ms |       223 ms |     1,773 ms |    600,129 ms |

These values should be treated as paired-message latency until dispatch, execution, queue, and result timestamps are separated.

### Error taxonomy

The analyzer now keeps both exact raw errors and normalized categories.

Remaining taxonomy work should distinguish command non-zero exits from generic execution failures, and should preserve separate provider timeout, provider unavailable, authentication, cancellation, and orchestration-invalid categories where the raw message supports that distinction.

### Duplicate analysis

The analyzer now reports global, same-root, cross-session, and cross-child duplicate scopes, including byte-identical result counts.

Remaining work should add an explicit same-child scope and report whether the workspace fingerprint changed between duplicate calls.

### Artifact analysis

For every artifact read, including `read` and `read_batch`, record the path, range or offset, captured bytes, actual file size, file mtime, content hash, prior hash, changed-read ratio, stale-read ratio, number of consumers, and full-read versus summary/tail mode.

The current analyzer does not infer filesystem freshness from database-captured tool results, so filesystem metadata should be loaded explicitly when available rather than guessed.

### Cost reconciliation

The analyzer now reports computed cost, reported cost, absolute delta, provider/model, cache-read totals, and unknown-cost roles.

Remaining work should add pricing-version identifiers, explicit cache treatment, and excluded control-event reasons.

### Child-quality analysis

The analyzer now reports parent and root IDs, persona-like session metadata, reuse outcomes, workflow modes, link status, child terminal stop reasons, child errors, tool counts, no-tool-child flags, child cost, and child latency.

Remaining work should add stable task IDs and artifact/report references where adapters provide them.

Report `link_status` and `child_terminal_outcome` independently.

## Final conclusion

The strongest evidence supports a workflow architecture centered on typed tool preflight, workspace-fingerprint evidence caching, bounded retry policies, explicit orchestration budgets, compact child artifacts, and constrained custom tools.

The immediate extension priorities for `subagent-herdr` and `bash-tools` are shared evidence caching, typed and cached validation commands, artifact-oriented batch reads, bounded search and diff operations, cached workspace state, and flow-ledger summaries.

The immediate analyzer priority is to include `read_batch` and other read-like tools in artifact analysis, track workspace fingerprints and artifact consumers, and preserve separate link-status and child-terminal-outcome signals.

Savings estimates should not be added mechanically because duplicate calls, retries, repeated validation, and cross-child reads overlap.
