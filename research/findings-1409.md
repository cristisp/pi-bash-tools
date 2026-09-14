# Pi session findings for 2026-09-14

## Report scope

This report analyzes Pi sessions stored in `backend/data/token-tracker.db` after the latest rescan.

The primary analysis window is `2026-08-15T08:25:22.530Z` through `2026-09-14T08:25:22.530Z`, the 30 days ending at the latest stored Pi session.

The window uses `sessions.started_at`, matching the analyzer's window semantics.

Import-time `last_seen_at` values were not used as activity timestamps.

A seven-day window (`2026-09-07T08:25:22.530Z` through `2026-09-14T08:25:22.530Z`) and four seven-day weekly buckets were also generated for trend comparison.

The four weekly buckets cover `2026-08-17` through `2026-09-14`.

A two-day residual bucket covers `2026-08-15T08:25:22.530Z` through `2026-08-17T08:25:22.530Z` so the weekly buckets and the 30-day window reconcile.

All findings come from read-only SQLite and filesystem analysis.

Repository tests, lint, format, and git commands mentioned here are historical telemetry recorded in the database, not commands run for this report.

The analyzer extensions described at the end were validated separately from the historical findings.

## Executive summary

The latest 30 days contain more repeated work and more schema-validation churn than the previous report, while several previously unobservable signals are now recorded directly by the extensions.

The most important changes since the `findings-0909` report are:

1. `bash-tools.tool-inventory` now supplies a reliable observed extension version (`1.0.3`) with 75.9% session coverage over 30 days and 96.6% over the latest 7 days.
2. `bash-tools.authorization-outcome` makes policy-prompt behavior observable: in the recorded cohort, 786 of 788 decisions were automatic and no prompt was emitted.
3. `bash-tools.project-command-summary` and `-invocation` make cache behavior observable: only 48 of 4,979 project-command invocations reused a cached result.
4. `codegraph-runner.tool-inventory` makes Codegraph index freshness and synchronization observable, with zero recorded sync failures.
5. The latest week improved its tool-error rate to 7.86%, but exact-duplicate excess stayed near 12% and cross-child repeated validation remains the dominant waste source.
6. Calls can now be attributed by tool source: 28,844 builtin calls at a 5.0% error rate versus 8,030 `npm:@ztc/bash-tools` calls at 24.2%, which separates owned behavior from the host and interception layers.
7. Failure codes are now counted directly from structured payloads, which surfaces 507 `edit-no-match` and 277 `policy-path-resolution-failure` results that the text-normalized view diluted.
8. The `1.0.3` cohort is measurably cleaner than earlier releases: a 4.8% error rate and 6.7% duplicate excess versus 10.1% and 11.5% for `0.10.1`.

The largest immediate optimization targets remain cross-child evidence caching, typed validation preflight, and result reuse, but they are now measurable rather than inferred.

## Scope and accounting

| Metric                       |       30 days |        7 days |   Residual |          W1 |          W2 |            W3 |            W4 |
| ---------------------------- | ------------: | ------------: | ---------: | ----------: | ----------: | ------------: | ------------: |
| Window start                 |    2026-08-15 |    2026-09-07 | 2026-08-15 |  2026-08-17 |  2026-08-24 |    2026-08-31 |    2026-09-07 |
| Window end                   |    2026-09-14 |    2026-09-14 | 2026-08-17 |  2026-08-24 |  2026-08-31 |    2026-09-07 |    2026-09-14 |
| Sessions                     |         1,032 |           321 |         35 |         121 |         203 |           352 |           321 |
| Root sessions                |           139 |            50 |          0 |          20 |          33 |            36 |            50 |
| Child sessions               |           893 |           271 |         35 |         101 |         170 |           316 |           271 |
| Model steps                  |        40,464 |        12,879 |      1,053 |       4,499 |       7,709 |        14,324 |        12,879 |
| Tool calls                   |        55,599 |        16,637 |      1,862 |       6,879 |      12,198 |        18,023 |        16,637 |
| Paired tool results          |        55,567 |        16,637 |      1,862 |       6,879 |      12,198 |        18,023 |        16,637 |
| Unmatched tool calls         |            32 |             0 |          0 |           0 |           0 |             0 |             0 |
| Tool-result errors           |         4,859 |         1,307 |         99 |         508 |       1,104 |         1,841 |         1,307 |
| Tool-result error rate       |         8.74% |         7.86% |      5.32% |       7.40% |       9.06% |        10.22% |         7.86% |
| Exact-duplicate excess calls |         6,242 |         1,997 |         73 |         776 |       1,326 |         2,070 |         1,997 |
| Exact-duplicate excess rate  |        11.23% |        12.00% |      3.92% |      11.28% |      10.87% |        11.49% |        12.00% |
| Input tokens                 |    59,625,921 |    17,999,305 |      2,931 |   1,096,190 |  17,738,135 |    22,789,360 |    17,999,305 |
| Output tokens                |    24,698,681 |     7,658,150 |    720,949 |   2,444,383 |   4,198,333 |     9,676,866 |     7,658,150 |
| Cache-read tokens            | 3,288,899,494 | 1,123,329,386 | 71,458,929 | 349,388,437 | 677,080,708 | 1,067,642,034 | 1,123,329,386 |
| Steps without computed cost  |         4,206 |         2,741 |         70 |         249 |         438 |           708 |         2,741 |
| Computed cost                |   $159.238856 |    $36.055636 |  $3.068755 |  $20.446408 |  $40.631249 |    $59.036806 |    $36.055636 |
| Reported cost                |   $157.137987 |    $42.465483 |  $2.308465 |  $19.526244 |  $34.035979 |    $58.801815 |    $42.465483 |
| Computed minus reported      |     $2.100869 |    -$6.409847 |  $0.760290 |   $0.920164 |   $6.595270 |     $0.234991 |    -$6.409847 |
| Computed/reported delta      |         1.34% |       -15.09% |     32.93% |       4.71% |      19.38% |         0.40% |       -15.09% |

The latest 30-day window shifted forward by six days relative to the `findings-0909` window, so absolute totals are not directly comparable.

Rate comparisons are the reliable signal.

The tool-error rate is slightly worse over 30 days (8.74% versus 8.55%) but improved sharply in the latest week (7.86% versus 10.22% in W3).

The exact-duplicate excess rate remains above the previous report's value and did not improve in the latest week.

The residual and W1 buckets show near-zero `inputTokens` relative to `outputTokens`, which indicates a token-accounting anomaly rather than a real usage pattern. That anomaly is discussed in the cost section.

## Version and schema baseline

The rescan now persists Pi top-level custom entries, so the analyzer can join extension inventory to database sessions.

The selected window contained 7,775 custom entries across 793 session files.

The exact custom entry types were 4,979 `bash-tools.project-command-invocation`, 957 `bash-tools.tool-inventory`, 837 `bash-tools.project-command-summary`, 788 `bash-tools.authorization-outcome`, 125 `codegraph-runner.tool-inventory`, 51 `bash-tools.git-invocation`, 31 `subagent-herdr-preset`, and 7 `bash-tools.read-batch-invocation`.

The custom-entry inventory now carries `hashAlgorithm: sha256` and a `sessionStartReason`, which were not present in the previous report's data.

### Extension version coverage

| Version | Inventory entries | Unambiguous sessions | Calls | Errors | Error rate | Result tokens (est.) |
| ------- | ----------------: | -------------------: | ----: | -----: | ---------: | -------------------: |
| 0.10.1  |               227 |                  196 | 9,238 |    931 |     10.08% |            9,814,420 |
| 1.0.3   |               113 |                  103 | 4,963 |    240 |      4.84% |            5,847,564 |
| 1.0.2   |                82 |                   75 | 3,297 |    304 |      9.22% |            4,087,326 |
| 0.11.9  |                70 |                   66 | 3,290 |    365 |     11.09% |            3,937,398 |
| 0.9.0   |                61 |                   52 | 2,937 |    319 |     10.86% |            5,747,069 |
| 0.11.4  |                52 |                   37 | 2,153 |    226 |     10.50% |            2,288,180 |
| 0.10.0  |                38 |                   24 | 2,127 |    244 |     11.47% |            1,916,855 |
| 0.5.1   |                38 |                   35 | 1,279 |     75 |      5.86% |            1,927,114 |

The remaining cohorts are smaller and are retained in the machine-readable report.

The latest observed version in the window was `1.0.3`, emitted at `2026-09-14T08:24:56.624Z` in session `01a08640-362a-73b3-9e60-51c8684f888d`.

That inventory entry reported 30 active tools for that session.

The latest version cohort contained 113 inventory entries across 103 unambiguous sessions.

It covered 103 of 1,032 sessions (9.98%) and 4,963 of 55,599 calls (8.93%).

Those 4,963 calls produced 240 errors, a 4.84% error rate, and approximately 5,847,564 estimated result tokens.

Across all unambiguous inventory cohorts, 783 sessions (75.87% of database sessions) had a known single extension version, and 35,778 calls (64.35%) could be assigned to a version cohort.

In the latest 7 days, coverage rose to 310 of 321 sessions (96.57%) and 14,046 of 16,637 calls (84.43%).

Calls from sessions with missing or multiple versions remain excluded rather than assigned by proximity.

The `1.0.3` cohort is now the largest recent cohort, so it is the right basis for the next iteration's baseline.

### Per-version cohort metrics

Each version cohort now reports error rate, duplicate excess, latency, cache decisions, and evidence reuse, not only call counts and result tokens.

| Version | Calls | Errors | Error rate | Dup. excess | Latency p50 | Latency p95 | Cache hits | Reused calls |
| ------- | ----: | -----: | ---------: | ----------: | ----------: | ----------: | ---------: | -----------: |
| 0.10.1  | 9,238 |    931 |      10.1% |       1,062 |       25 ms |    4,095 ms |          0 |            8 |
| 1.0.3   | 4,963 |    240 |       4.8% |         334 |       26 ms |    1,627 ms |          0 |           33 |
| 1.0.2   | 3,767 |    340 |       9.0% |         355 |       36 ms |    3,573 ms |          0 |            1 |
| 0.11.9  | 3,290 |    365 |      11.1% |         528 |       57 ms |    3,551 ms |          0 |            3 |
| 0.9.0   | 2,937 |    319 |      10.9% |         325 |       38 ms |    2,066 ms |          0 |            0 |
| 0.11.4  | 2,153 |    226 |      10.5% |         139 |       22 ms |    5,226 ms |          0 |            4 |
| 0.10.0  | 2,127 |    244 |      11.5% |         385 |       23 ms |   10,987 ms |          0 |            0 |
| 0.5.1   | 1,279 |     75 |       5.9% |         114 |       64 ms |   68,596 ms |          0 |            0 |
| 1.0.0   | 1,057 |     92 |       8.7% |         135 |       33 ms |   26,430 ms |          0 |            0 |
| 0.11.0  | 1,048 |    100 |       9.5% |          23 |       52 ms |    3,037 ms |          0 |            0 |

`1.0.3` is the cleanest recent release on both error rate (4.8%) and duplicate excess (6.7% of its calls), and it also shows the highest evidence reuse (33 calls).

`0.10.1` carried the most duplicate churn in absolute terms (1,062 excess calls, 11.5% of its calls).

Cache reuse is near zero in every cohort, which confirms that the reuse problem is not specific to one release.

The cohort metrics use the same multi-version exclusion rule, so they describe only sessions with a single observed extension version.

### Structured result version metadata

`versionAwareAnalysis.extensionSchemaCohorts` still reads structured tool results separately from the extension inventory.

It found 679 result records with at least one version or schema field.

`resultFingerprintVersion` `1` appeared in 336 records across 44 sessions.

`invocationFormatVersion` `1` and schema hash `21e7bb4fa4f05476722bad7bc91184bd59559b23f65e453fd6ef5f00adf3e868` appeared together in 3 records across 2 sessions.

`nodeVersion` appeared in 386 results: 210 at `v26.3.0` and 176 at `v24.17.0`.

`extensionVersion` did not appear in structured tool results; that value comes only from the inventory custom entries.

## Authorization and policy telemetry

`bash-tools.authorization-outcome` records the authorization decision for each surface and is the first direct evidence about whether a policy prompt was shown.

The 30-day window contained 788 authorization records across 25 sessions.

The outcomes were 786 `authorized`, 1 `confirmation-timeout`, and 1 `unchanged-retry-after-denial`.

The surfaces were 698 `filesystem`, 82 `project-command`, and 8 `verify`.

Only 1 record emitted a prompt, 1 persisted a decision, and none recorded an execution attempt at decision time.

`promptWaitMs` summed to 120,012 ms and was nonzero only for the single prompt, which timed out at 120,012 ms.

The per-command outcomes were 296 authorized `read`, 216 authorized `edit`, 172 authorized `grep`, 33 authorized `node_test`, 25 authorized `node_lint`, 24 authorized `node_format`, 6 authorized `verify`, 6 authorized `write`, 5 authorized `find`, 3 authorized `ls`, 1 `verify` confirmation timeout, and 1 `verify` unchanged retry after denial.

This resolves the previous report's open question about whether users saw or ignored a policy prompt for this cohort: authorization was almost entirely automatic, and the one prompt that was shown timed out after about two minutes.

It does not prove that every historical policy failure involved automatic authorization, because the records only cover 25 sessions and the recent extension release.

The tool-result policy taxonomy continues to run independently of the authorization records.

Over 30 days the normalized classifier found 626 `policy_denied` errors.

The explicit raw-message union contained 935 policy or authorization-related errors, or 19.24% of the 4,859 tool-result errors.

The older five-way `failureTotals.policy` value was 385.

Those three totals are intentionally separate measurements and must not be interchanged.

The exclusive raw categories were:

| Category                     | Count |
| ---------------------------- | ----: |
| `access_policy`              |   621 |
| `confirmation_timeout`       |   131 |
| `project_command_policy`     |    84 |
| `authorization_save_failure` |    34 |
| `authorization_timeout`      |    20 |
| `policy_loader_failure`      |    17 |
| `authorization_denied`       |    11 |
| `authorized_flow_missing`    |    10 |
| `permission_denied`          |     4 |
| `sandbox_enforcement`        |     2 |
| `user_blocked`               |     1 |

The grouped policy outcomes were 578 sandbox or filesystem-containment results, 151 approval-interaction timeouts, 93 policy-subsystem failures, 87 non-interactive fail-closed denials, 16 expected authorization decisions, and 10 evidence-flow or scope failures.

The bounded implementation-defect candidate estimate was 103 results (2.12% of errors) from the policy-subsystem and evidence-flow groups.

The structured authorization results contained 358 records with `authFingerprint`, `policyId`, and `reusePolicyId`, and `reusePolicyId` was `never` in all 358.

The dominant exact policy message remained `Tool call blocked by access policy: read path could not be safely resolved.`, which appeared with both compact and structured variants.

The second-largest policy cluster was project-command confirmation timeouts, with 91 records of `Project command confirmation timed out`.

## Project command cache and timing telemetry

`bash-tools.project-command-invocation` and `bash-tools.project-command-summary` make the validation pipeline directly measurable.

The 30-day window contained 4,979 project-command invocation records across 394 sessions.

The cache decisions were 3,389 `ineligible`, 1,464 `forced`, 78 `miss`, and 48 `hit`.

The reuse outcomes were 48 `reused-cache-hit` and 2,064 records with `forced: true`.

Only 48 of 4,979 invocations, or 0.96%, reused a cached result.

Cache reuse therefore remains nearly absent even though the cache machinery is now observable.

The execution reasons were 2,596 `executed-cache-ineligible`, 1,991 `executed-forced-cache-bypass`, 145 `policy-failure`, 78 `executed-after-cache-miss`, 71 `resolution-failure`, 48 `reused-cache-hit`, 35 `preparation-failure`, 13 `lookup-failure`, and 2 `invalid-request`.

State drift was recorded on 144 invocations.

No invocation recorded concurrent execution above 1.

Repository state was present on 2,128 of 4,979 invocations.

The process statuses were 3,520 `success`, 1,154 `nonzero`, and 7 `timeout`.

The result categories were 3,498 `PASS`, 505 `TEST_FAILURE`, 269 `LINT_FAILURE`, 197 `FORMAT_FAILURE`, 172 `IMPLEMENTATION_FAILURE`, 84 `RESOLUTION_FAILURE`, 73 `BLOCKED`, 72 `POLICY_FAILURE`, 71 `TIMEOUT`, 36 `TYPE_CHECK_FAILURE`, and 2 `INVALID_REQUEST`.

The 30-day project-command wall time was 26,114,492 ms, or about 7.25 hours.

The recorded execution time was 11,095,465 ms, or about 3.08 hours.

That means 15,019,027 ms, or about 4.17 hours and 57.5% of project-command wall time, was spent outside command execution.

Reducing preparation, queue, and policy overhead is therefore worth as much as reducing command runtime.

The 837 project-command summaries recorded 3,270 `ineligible`, 1,461 `forced`, 73 `miss`, 43 `hit`, and 0 `invalidated` cache decisions.

The summaries recorded 43 repeated unchanged requests, 160 truncations, and 33,303,823 output bytes.

The invocation and summary cache counts agree closely, which increases confidence in both records.

### Publication, lookup, and verdict segmentation

The invocation records already carry publication, lookup, and verdict fields, which the previous report did not present.

| Segment              | 30 days | 7 days |
| -------------------- | ------: | -----: |
| Invocations          |   4,979 |  2,271 |
| Published refs       |      55 |     49 |
| Publication failures |       0 |      0 |
| Lookup attempts      |      55 |     55 |
| Lookup successes     |      42 |     42 |
| Lookup failures      |      13 |     13 |
| Aggregate runs       |     289 |    282 |
| Recorded refs        |     375 |    212 |
| Coercions            |      38 |     36 |

The `publication` block recorded 55 published `flow`-scoped refs across the 30 days with zero publication failures.

The `lookup` block recorded 55 attempts, 42 successes, and 13 failures, so lookup is the part of the publication path that fails.

The verdict distribution was 115 `incomplete`, 62 `passed`, and 33 `failed`, which is separate from the process exit status and gives a cleaner review signal.

`aggregate` runs identify the consolidated verify records, and there were 289 of them.

Verification refs (`ref`) appeared on 375 records, and argument coercions such as `paths:string-json-array` appeared 38 times, which indicates the tool is silently repairing caller mistakes rather than rejecting them.

No invocation recorded shared execution above zero, which matches the `sharedExecutionRuns: 0` result.

### Forced-bypass attribution

2,064 of 4,979 invocations forced a cache bypass.

They occurred across 137 sessions, so forced bypass is systemic rather than confined to a few workflows.

| Role        | Forced runs |
| ----------- | ----------: |
| `(none)`    |       1,994 |
| `worker`    |          42 |
| `validator` |          28 |

| Command             | Forced runs |
| ------------------- | ----------: |
| `node_test`         |         761 |
| `node_lint`         |         423 |
| `node_format`       |         380 |
| `node_project_info` |         114 |
| `node_typecheck`    |          99 |
| `verify`            |          67 |
| `node_build`        |          48 |
| `node_format_check` |          43 |

Most forced runs carry no orchestration role, which means the bypass is mostly requested by the caller's `force` argument rather than driven by a specific workflow role.

`node_test`, `node_lint`, and `node_format` alone account for 1,564 forced runs, so those three commands are the first place to check whether bypassing the cache is justified.

## Codegraph telemetry

`codegraph-runner.tool-inventory` now exposes index freshness and synchronization behavior.

The 30-day window contained 125 records across 47 sessions: 64 inventory records and 61 summary records.

The extension versions were 69 at `2.0.3`, 32 at `2.0.2`, 12 at `2.0.0`, and 12 at `2.0.1`.

The Codegraph package version was `1.6.0` in all 64 inventory records, and the artifact format version was `v1`.

Index freshness was recorded as `current` 24 times and was never recorded as stale in the collected summaries.

Synchronization recorded 101 checks, 41 executions, and 0 failures.

The recorded outcomes were 30 `ok`, 2 `not-found`, 1 `failed`, 1 `invalid-request`, and 1 `ready`.

The result byte totals were 286,616 total bytes, 109,386 returned bytes, and 301,805 stored bytes.

Nine truncations were recorded, and the recorded invocation duration summed to 11,069 ms.

Zero sync failures and non-stale freshness mean that the earlier "index state unavailable" limitation is now resolved for the sessions that emit this telemetry, though coverage is only 47 sessions.

## Tool usage

| Tool                 |  Calls | Errors | Error rate | Duplicate excess | Result tokens (est.) | Allocated cost |
| -------------------- | -----: | -----: | ---------: | ---------------: | -------------------: | -------------: |
| `read`               | 19,368 |    548 |       2.8% |              324 |           29,853,301 |         $35.81 |
| `edit`               |  8,104 |    819 |      10.1% |               59 |              226,552 |         $31.40 |
| `grep`               |  7,474 |    292 |       3.9% |               28 |           13,051,473 |         $18.57 |
| `project_command`    |  6,304 |  1,758 |      27.9% |            3,890 |            3,516,869 |         $13.47 |
| `bash`               |  2,769 |    331 |      12.0% |              475 |            3,173,813 |          $6.05 |
| `git_status`         |  1,625 |    381 |      23.4% |              653 |              612,885 |          $2.63 |
| `git_diff`           |  1,552 |    186 |      12.0% |              120 |            8,241,900 |          $2.48 |
| `find`               |  1,507 |     57 |       3.8% |               14 |              326,850 |          $2.58 |
| `codegraph_explore`  |  1,107 |      3 |       0.3% |                1 |            4,671,925 |          $3.48 |
| `subagent`           |    894 |     13 |       1.5% |               15 |            1,082,784 |          $9.58 |
| `ls`                 |    879 |     80 |       9.1% |               60 |               53,556 |          $1.99 |
| `write`              |    863 |     13 |       1.5% |                7 |               17,120 |          $6.17 |
| `verify`             |    450 |    132 |      29.3% |              101 |              326,466 |          $1.80 |
| `codegraph_sync`     |    425 |      0 |       0.0% |              362 |               15,549 |          $1.17 |
| `codegraph_callers`  |    365 |      0 |       0.0% |                1 |               23,524 |          $0.39 |
| `read_batch`         |    347 |      0 |       0.0% |                2 |            1,416,058 |          $1.87 |
| `codegraph_affected` |    253 |      1 |       0.4% |               16 |               39,792 |          $0.70 |
| `git_log`            |    245 |    135 |      55.1% |                1 |               30,948 |          $0.42 |
| `git_show`           |    211 |     23 |      10.9% |                1 |              181,725 |          $0.34 |
| `query-docs`         |    205 |      2 |       1.0% |                0 |              224,356 |          $0.51 |
| `move`               |    134 |     17 |      12.7% |               75 |                7,471 |          $0.24 |
| `delete`             |    121 |     46 |      38.0% |               11 |                3,986 |          $0.51 |
| `resolve-library-id` |     85 |      0 |       0.0% |                0 |               32,509 |          $0.20 |
| `codegraph_callees`  |     85 |      1 |       1.2% |                0 |               14,666 |          $0.07 |
| `codegraph_impact`   |     71 |      0 |       0.0% |                0 |               19,894 |          $0.10 |
| `environment`        |     43 |     11 |      27.5% |                3 |                1,044 |          $0.06 |
| `subagent_stats`     |     32 |      0 |       0.0% |                5 |                8,354 |          $0.16 |
| `playwright`         |     30 |      0 |       0.0% |               16 |                6,573 |          $0.31 |

`project_command` remains the worst combination of volume, error rate, and duplicate excess.

`codegraph_sync` produced 362 excess calls with zero errors, which indicates redundant synchronization rather than failed synchronization.

`read_batch` remained error-free with only 2 excess calls, continuing to look like a healthy direction.

`git_log` and `git_status` have unusually high error rates driven by request-schema problems, not by the underlying repository.

## Tool source attribution

Every `bash-tools.tool-inventory` entry carries `tools[].sourceInfo`, so calls can be attributed to the layer that actually owns the tool.

That separates builtin host tools from intercepted packages and project extensions instead of treating all calls as one cohort.

| Source                                        |  Calls | Errors | Error rate | Result tokens (est.) | Allocated cost |
| --------------------------------------------- | -----: | -----: | ---------: | -------------------: | -------------: |
| `builtin`                                     | 28,844 |  1,441 |       5.0% |           33,719,041 |         $73.69 |
| `npm:@ztc/bash-tools`                         |  8,030 |  1,940 |      24.2% |           10,710,668 |         $16.13 |
| `npm:@ztc/codegraph-runner`                   |  1,549 |      5 |       0.3% |            3,422,070 |          $3.15 |
| `../../work/git/pi-extensions/bash-tools`     |  1,531 |    339 |      22.1% |            1,458,889 |          $4.36 |
| `../../work/git/pi-extensions/subagent-herdr` |    447 |      8 |       1.8% |              251,833 |          $1.72 |
| `cli`                                         |    410 |     33 |       8.0% |              655,230 |          $1.80 |
| `npm:@ztc/subagent-herdr`                     |    345 |      1 |       0.3% |              596,258 |          $5.53 |
| `npm:@upstash/context7-pi`                    |    168 |      2 |       1.2% |              153,349 |          $0.45 |
| `npm:@ztc/lavish`                             |     23 |      3 |      13.0% |               64,481 |          $0.10 |

41,347 of 55,599 calls were attributed, and 14,252 were not.

The unattributed calls come from sessions that predate tool-inventory emission or from tool names that never appear in an inventory entry.

The most common unattributed tool names were `read` (5,163), `bash` (2,296), `edit` (1,865), `grep` (1,213), and `project_command` (980).

The 24.2% error rate on `npm:@ztc/bash-tools` is the single clearest reliability signal in the report, because those calls are our own interception surface rather than host behavior.

Two malformed tool names appeared, `ls drizzle</arg_value>` and `ls src src/lib src/lib/services src/actions src/lib/db 2>/dev/null</arg_value>`.

The analyzer now separates those into `malformedToolCalls` and `malformedTools`, so `unknownTools` lists only real tool names.

They are not an importer or analyzer defect: the raw Pi log for session `subagent-wN-worker-49.jsonl` contains `{"type":"toolCall","name":"ls ...</arg_value>","arguments":{}}`, so the malformed name is written upstream, and this repository contains no `arg_value` parsing.

In the latest 7 days, attribution is nearly complete (1 unattributed call), and the split is 11,344 builtin calls at 4.7% versus 2,921 `npm:@ztc/bash-tools` calls at 18.1%.

## Failure and error analysis

The normalized error categories over 30 days were:

| Category                          | Count |
| --------------------------------- | ----: |
| `command_execution`               | 1,136 |
| `other`                           | 1,131 |
| `schema_validation`               |   977 |
| `policy_denied`                   |   626 |
| `orchestration_budget`            |   302 |
| `stale_context`                   |   281 |
| `provider_timeout_or_unavailable` |   207 |
| `ambiguous_edit`                  |   141 |
| `authentication`                  |    17 |
| `missing_dependency`              |    15 |
| `cancelled_or_terminated`         |    14 |
| `no_op_edit`                      |    12 |

The analyzer now reports a first-class `orchestration_budget` category instead of burying those results in `other`.

That category captured 302 results: `Budget exhausted for role ...` messages and `Worker must make an implementation change before more discovery` messages.

The visible exact budget messages split into 75 for `worker`, 49 for `reviewer`, 24 for `planner`, 8 for `validator`, and 5 for `scout`, plus 116 discovery-block messages.

These are policy-driven workflow stops, not transient failures, and they are reported separately from genuine tool errors.

The five-way `failureTotals` rollup is intentionally unchanged and still reports 547 validation, 362 resolution, 1,222 execution, 385 policy, and 2,343 other.

The largest schema-validation clusters were:

| Count | Tool         | Message                                                                                      |
| ----: | ------------ | -------------------------------------------------------------------------------------------- |
|   171 | `git_status` | `path must not be empty; action: Correct the path field or request shape and retry.`         |
|   162 | `git_status` | `path must not be empty`                                                                     |
|    65 | `git_diff`   | `provide either path or paths, not both`                                                     |
|    53 | `git_log`    | `revision must not be empty`                                                                 |
|    32 | `git_log`    | `revision must not be empty; action: Correct the revision field or request shape and retry.` |
|     4 | `git_diff`   | `paths must not be empty`                                                                    |

Together, empty `git_status` paths, empty `git_log` revisions, and conflicting `git_diff` path arguments account for 487 errors that a typed preflight could eliminate.

The `edit` failure modes remain stable in the normalized view: 281 stale-context mismatches, 141 ambiguous or non-unique matches, and 12 no-op replacements.

The analyzer now counts structured failure codes from the result payloads, which is a more complete and machine-stable view than message normalization.

| Code                             | Count | Tools                         |
| -------------------------------- | ----: | ----------------------------- |
| `edit-no-match`                  |   507 | `edit`                        |
| `policy-path-resolution-failure` |   277 | `read`, `grep`, `ls`, `edit`  |
| `edit-ambiguous`                 |   222 | `edit`                        |
| `policy-denied`                  |   104 | `ls`, `find`, `read`, `grep`  |
| `policy-load-failure`            |    39 | `read`, `ls`, `edit`, `write` |
| `inapplicable-command`           |    25 | `project_command`, `bash`     |
| `confirmation-timeout`           |    17 | `ls`, `read`, `write`, `grep` |
| `edit-overlap`                   |    15 | `edit`                        |
| `missing-package-manifest`       |    14 | `project_command`             |
| `test-path-outside-workspace`    |    13 | `project_command`             |
| `invalid-test-parameters`        |    11 | `project_command`             |
| `missing-binary`                 |    10 | `project_command`, `bash`     |
| `policy-denied-once`             |     4 | `find`, `ls`                  |
| `edit-no-op`                     |     3 | `edit`                        |

The structured edit codes total 747, which is larger than the 434 normalized `stale_context`, `ambiguous_edit`, and `no_op_edit` results, because many edit failures were previously folded into `other`.

There is no `edit-stale-context` code in the logs; `edit-no-match` is the closest available signal, so an evidence-backed stale classification cannot yet be separated from a plain no-match.

Other notable exact messages were 34 `verify authorization failed: save`, 20 `verify authorization failed: timeout`, 13 `verify could not resolve the typecheck package script typecheck`, 12 `read Git show failed: fatal: bad revision 'HEAD'`, 11 `EISDIR: illegal operation on a directory, read`, 11 `rg: the literal "\n" is not allowed in a regex`, and 10 `Unable to load project command policy`.

### Dual error rate

The analyzer now reports both an inclusive tool-result error rate and a rate that excludes expected authorization and fail-closed outcomes.

| Window  | Inclusive | Excluding expected outcomes | Excluded | Breakdown                                                     |
| ------- | --------: | --------------------------: | -------: | ------------------------------------------------------------- |
| 30 days |     8.74% |                       7.05% |      942 | policy 626, orchestration budget 302, confirmation timeout 14 |
| 7 days  |     7.86% |                       5.92% |      323 | orchestration budget 173, policy 148, confirmation timeout 2  |

Expected outcomes are identified from structured policy codes (`policy-*`), `confirmation-timeout`, the normalized `policy_denied` category, and the `orchestration_budget` category.

The two rates must not be confused: the inclusive rate describes raw tool reliability, while the excluding rate describes avoidable failures.

Reclassifying confirmation timeouts is a real correction, because `Project command confirmation timed out` was previously normalized as a provider timeout.

## Duplicate work

Session-scoped exact-request duplication found 2,067 groups and 6,242 excess calls, or 11.23% of all calls.

Those duplicates produced 953 same-result repeats, approximately 3,719,674 repeated result tokens, and $15.89 of associated step cost.

The duplicate scopes were:

| Scope         | Groups | Excess calls | Same-result | Result tokens (est.) | Associated cost |
| ------------- | -----: | -----------: | ----------: | -------------------: | --------------: |
| Global        |  3,441 |       16,398 |       3,180 |           20,367,289 |          $29.85 |
| Same root     |  3,541 |       12,563 |       3,195 |           14,738,959 |          $22.14 |
| Cross session |  2,821 |       15,349 |       2,856 |           19,806,258 |          $27.00 |
| Cross child   |  2,189 |        7,177 |       2,361 |           11,197,454 |           $8.60 |

Cross-child duplication remains the clearest orchestration waste because those calls repeat across independent workers of the same root.

The largest cross-child groups were:

| Excess | Children | Calls | Same result | Tool              | Project            | Request                                                   |
| -----: | -------: | ----: | ----------: | ----------------- | ------------------ | --------------------------------------------------------- |
|     93 |       61 |    94 |           1 | `git_status`      | `indicatori`       | `{}`                                                      |
|     84 |       38 |    85 |           0 | `project_command` | `indicatori`       | `{"commandId":"node_test"}`                               |
|     81 |       34 |    82 |           4 | `git_status`      | `indicatori`       | `{"path":"."}`                                            |
|     71 |       72 |    72 |           0 | `read`            | `codegraph-runner` | `{"path":"/Users/.../flows/fe27fca1571d87666/ledger.md"}` |
|     65 |       20 |    66 |           0 | `project_command` | `indicatori`       | `{"commandId":"node_lint","force":true}`                  |
|     57 |       34 |    58 |           2 | `git_status`      | `bash-tools`       | `{"path":"."}`                                            |
|     57 |       23 |    58 |           0 | `project_command` | `codegraph-runner` | `{"commandId":"node_format"}`                             |
|     51 |       36 |    52 |           0 | `project_command` | `indicatori`       | `{"commandId":"node_format","variant":"check"}`           |
|     50 |       38 |    51 |           3 | `git_status`      | `indicatori`       | `{}`                                                      |
|     46 |       20 |    47 |           0 | `bash`            | `bash-tools`       | `{"command":"npm run lint","timeout":120}`                |
|     44 |       28 |    45 |           0 | `bash`            | `bash-tools`       | `{"command":"npm run format:check","timeout":120}`        |
|     43 |       16 |    44 |          34 | `bash`            | `bash-tools`       | `{"command":"npx tsc --noEmit","timeout":120}`            |

The same flow ledger was read 72 times across 72 children of one root.

That single pattern is the strongest concrete case for a shared evidence broker with ledger summaries and cursors.

Within single sessions, `project_command` dominated the duplicate examples: 99 excess `node_lint`, 71 excess forced `node_lint`, 64 excess `node_format`, 52 excess `node_test`, and 67 excess `codegraph_sync`.

State-aware duplication found 3,441 groups, and 1,404 calls carried a repository-state fingerprint.

The analyzer now pairs extension invocation entries to calls by session and command and only pairs when the call and entry counts match, so the merge stays conservative.

Of the 1,404 calls with state, 323 came from structured tool results and 1,081 came from 1,086 custom-entry pairings.

The state groups were 3,315 unknown with 12,161 excess calls, 113 changed with 4,216 excess calls, and 13 same-state with 21 excess calls.

The merge reclassified about 3,774 excess calls from `unknown` to `changed`, mostly in `project_command`, which means those repeated runs were executed against a changed workspace rather than being pure waste.

`project_command` now has 68 changed-state groups and 2 same-state groups, and `git_status` adds 2 changed-state groups.

The remaining 12,161 unknown-state excess calls must not be labeled waste because the workspace state is still unavailable for those calls.

The pairing remains an approximation because the importer does not yet persist the provider tool-call id, so calls whose command emitted no invocation entry are deliberately left unknown.

## Read and artifact repetition

The window contained 19,710 read-like calls and 2,750 distinct observed paths.

Those reads captured 125,099,667 result bytes with 12,342 unique result hashes and 11,914 changed read results.

`read` accounted for 19,363 calls and 119,436,163 bytes, while `read_batch` accounted for 347 calls and 5,663,504 bytes.

The most repeated artifacts were:

| Path                                       | Reads | Sessions | Roots | Result bytes | Unique hashes | Changed | Unchanged |
| ------------------------------------------ | ----: | -------: | ----: | -----------: | ------------: | ------: | --------: |
| `PLAN.md`                                  |   610 |      216 |    53 |    6,558,139 |           526 |     557 |        52 |
| `.../flows/fe27fca1571d87666/ledger.md`    |   136 |       73 |     1 |    4,485,861 |           136 |     135 |         0 |
| `src/tools/project-command/runner.ts`      |   318 |      105 |    18 |    3,019,389 |           275 |     296 |        21 |
| `.../pi-coding-agent/docs/extensions.md`   |    67 |       24 |    17 |    2,211,562 |            35 |      62 |         4 |
| `src/tools/verify/tool.ts`                 |   236 |       45 |     9 |    1,964,979 |           198 |     205 |        30 |
| `README.md`                                |   241 |      147 |    49 |    1,737,986 |           182 |     192 |        48 |
| `src/tools/project-command/tool.ts`        |   194 |      122 |    21 |    1,681,357 |           103 |     119 |        74 |
| `src/tools.ts`                             |   246 |       62 |    16 |    1,585,158 |           229 |     237 |         8 |
| `src/tools/project-command/definitions.ts` |   180 |       98 |    17 |    1,584,742 |           145 |     160 |        19 |
| `.../flows/f4a7c827e86180efe/ledger.md`    |    82 |       41 |     3 |    1,558,610 |            82 |      81 |         0 |
| `package.json`                             |   451 |      365 |    80 |      745,367 |           102 |     158 |       292 |

`package.json` is the clearest low-yield repeat: 451 reads across 365 sessions produced only 102 unique hashes and 292 unchanged reads.

`PLAN.md` was read 610 times across 216 sessions and changed between reads 557 times, so those reads carry real information but at very high cost.

The low ratio of content changes to repeated reads for `package.json`, `src/tools/project-command/tool.ts`, and `SUBAGENTS_GUIDE.md` supports hashing plus conditional or cached reads.

### Read-batch producer linking

`read-batch-invocation` records produced references directly, which makes the producer half of the `rr_` evidence chain observable.

| Metric          |   30 days |
| --------------- | --------: |
| Invocations     |         7 |
| Items           |        21 |
| Produced refs   |        21 |
| Unique refs     |        19 |
| Truncated items |         1 |
| Unchanged items |         2 |
| Scope           | `session` |

Every item produced a reference, and the two duplicate references are the same path served across invocations.

The consumer half remains unavailable because `read-batch-invocation` does not record `role` or `delegationId`, so the analyzer cannot say which child consumed an `rr_` ref.

## Git evidence reuse and truncation

Git results carry an `output` block with `truncated`, `totalBytes`, and `totalLines`, plus a `mode` for diff responses.

| Metric                                 |    30 days |    7 days |
| -------------------------------------- | ---------: | --------: |
| Result payloads                        |      2,908 |       964 |
| Total bytes                            | 38,264,376 | 7,964,301 |
| Total lines                            |    886,939 |   155,777 |
| Truncated results                      |        116 |        49 |
| `patch` responses                      |      1,083 |       325 |
| `summary` responses                    |        283 |       173 |
| Results with `head`/`dirtyFilesDigest` |          5 |         5 |

The `git-invocation` records add 51 invocations across 18 sessions (36 `git_diff`, 12 `git_status`, 2 `git_show`, 1 `git_log`) with 340,249 aggregate result bytes.

`unchanged` was `false` on all 51 invocation records, so the git reuse path was never exercised in this snapshot and there is no measured summary reuse to report.

Git results are a large context source: 38.26 million bytes over 30 days, and 116 results were truncated, which indicates the bounded-output path is doing real work.

The `head`/`dirtyFilesDigest` extension fields appear on only 5 results, so the claimed post-1.1.0 coverage widening is not yet material in this window.

## Orchestration

Subagent delegation remained the dominant orchestration mechanism.

There were 894 subagent calls, of which 725 were delegation calls and 169 were listing or status calls.

The role assignments were 267 `worker`, 228 `reviewer`, 154 `validator`, 72 `planner`, 43 `scout`, and 1 `none`.

There were 893 child sessions, 887 linked child sessions, 843 successful links, and 44 unknown-status links.

Child sessions contained 19,539 steps and $54.86 of computed cost with 1,229,943,589 cache-read tokens.

The fan-out distribution over roots with children had a median of 0, a p95 of 35, a p99 of 72, and a maximum of 76.

The largest fan-out root produced 76 children and 2,626 steps for $0.78, followed by a 72-child root, a 60-child root, and a 52-child root.

Fan-out did not decrease relative to the previous report; the maximum rose from 72 to 76.

Link metadata remains thin: `invocationName`, `description`, `promptExcerpt`, `requestedModel`, and `linkLabel` were missing on all 887 links.

`endedAt` was missing on 35 links, matching the 35 unknown-status links and 35 no-tool children.

Child terminal outcomes remain separable from link status: 837 children linked successfully and stopped normally, 24 stopped with unknown link status, 10 ended on `toolUse`, and 9 errored.

Subagent reuse remained failure-prone: 12 `completed`, 10 `invalid_mode`, 9 `completed_without_marker`, 2 `label_not_found`, and 1 `reuse_error`.

## Retry behavior

There were 4,859 failed calls and 854 failures with an exact retry within the next five calls.

Those retries succeeded 422 times and failed 432 times.

The retry distance was 3 at the median and 5 at the 95th percentile.

`project_command` accounted for 716 retries with 359 successes, `bash` for 73 with 52 successes, `git_diff` for 20 with 0 successes, `read` for 15 with 4 successes, and `edit` for 10 with 0 successes.

Retries are now split by whether the failed result carried a structured `retryable` flag.

There were 14 retryable targets, 7 non-retryable targets, and 833 with unknown retryability.

580 retries repeated the identical request with no intervening change, while 274 followed an intervening different request.

Only 7 of the unchanged retries followed an explicitly non-retryable error, and 561 followed errors with unknown retryability.

The zero-success retries for `git_diff` and `edit` are still the clearest candidates for blocking unchanged retries.

The `unchangedNonRetryableRetries` value is the small, high-confidence set the analyzer can currently prove; the 561 unknown-retryability unchanged retries show why persisting a retryability signal on every error would help.

## Latency

The overall measured latency was 34 ms at the median, 5,941 ms at p95, 120,129 ms at p99, and 21,252,262 ms at the maximum.

No calls were missing timestamps, and no negative latencies were recorded.

`subagent` remained the slowest tool at a 97,629 ms median, an 845,765 ms p95, and the 21,252,262 ms maximum.

`lavish_poll` had a 326,418 ms median.

`project_command` had a 1,244 ms median and a 25,701 ms p95, and `git_status` had a 95 ms median but an 856 ms p95.

The slowest calls were dominated by `subagent` invocations in `lavish` and `bash-tools` sessions, with the single slowest call taking about 5.9 hours.

## Cost reconciliation

The 30-day computed cost was $159.238856 and the reported cost was $157.137987, a delta of $2.100869, or 1.34%.

This is much closer than the previous report's $15.62 delta, but the latest 7 days reversed direction: computed $36.055636 versus reported $42.465483, a -$6.409847 delta, or -15.09%.

The reversal is concentrated in `opencode-go` models, where `glm-5.3-flash` and `deepseek-flash` reported cost above the catalog computation, and in `gpt-5.6-sol`, where the catalog computed $21.73 but the provider reported $17.19.

The largest provider-model rows were:

| Provider         | Model                |  Steps | Input tokens | Output tokens | Cache-read tokens | Computed | Reported |
| ---------------- | -------------------- | -----: | -----------: | ------------: | ----------------: | -------: | -------: |
| `github-copilot` | `gpt-5.6-luna`       | 26,253 |      126,793 |    13,700,522 |     2,206,093,101 |   $81.33 |   $77.54 |
| `cortecs`        | `qwen3.8-flash-next` |  6,989 |   14,296,292 |     5,851,087 |       519,239,104 |   $31.75 |   $31.52 |
| `github-copilot` | `gpt-5.6-sol`        |    264 |      394,736 |       195,727 |        25,293,506 |   $21.73 |   $17.19 |
| `github-copilot` | `kimi-k3`            |    114 |    1,612,764 |       158,915 |        10,765,303 |   $10.45 |   $10.45 |
| `cortecs`        | `glm-5.3-flash`      |  1,578 |   21,540,554 |       877,227 |        83,585,792 |    $8.93 |    $8.93 |
| `opencode-go`    | `glm-5.3-flash`      |  1,827 |   10,235,661 |       864,393 |       124,070,016 |    $2.85 |    $5.65 |
| `opencode-go`    | `deepseek-flash`     |  2,089 |    6,750,056 |     2,889,586 |       303,211,392 |    $0.00 |    $3.66 |

There were 4,206 steps without a computed cost: 2,020 `user` steps, 1,108 `thinking_level_switch` steps, 1,076 `model_switch` steps, and 2 `subagent` steps.

The analyzer now flags three provider-model pricing mismatches:

| Provider         | Model            | Kind                              | Computed | Reported |  Delta |
| ---------------- | ---------------- | --------------------------------- | -------: | -------: | -----: |
| `github-copilot` | `gpt-5.6-sol`    | `large_delta`                     |   $21.73 |   $17.19 | +$4.54 |
| `opencode-go`    | `deepseek-flash` | `zero_computed_positive_reported` |    $0.00 |    $3.66 | -$3.66 |
| `opencode-go`    | `glm-5.3-flash`  | `large_delta`                     |    $2.84 |    $5.65 | -$2.80 |

The `zero_computed_positive_reported` case means the catalog has no price for that model and the analyzer cannot compute a cost, so the reported provider cost is the only signal.

The non-cached input share also reveals a provider-accounting difference: `github-copilot` `gpt-5.6-luna` reports a share of 0.00006, meaning almost all of its context is billed as cache reads, while `cortecs` and `opencode-go` models report shares between 0.03 and 0.22.

The near-zero `inputTokens` in the residual and W1 buckets, combined with very large cache-read and output tokens, indicates that some records report input tokens in a way that the current accounting does not normalize consistently.

That accounting anomaly should be resolved before treating any single week's absolute cost as authoritative.

## Data quality and limits

`malformedArgumentCalls` was 0, which means every captured call had parseable arguments.

There were 32 unmatched tool calls, 0 missing message timestamps, 49 messages with truncation metadata, 0 messages marked truncated, and 0 `fullOutputPath` values.

No links were missing a status or child session.

The analyzer also flags steps with missing or implausible input tokens.

It found 2,184 steps with null `inputTokens` and 614 steps with `inputTokens <= 10`, `cacheReadTokens = 0`, and positive output tokens, all of them `github-copilot` `gpt-5.6-luna` (603) or `gpt-5.6-sol` (11).

Those counters make the provider token-accounting caveat above measurable instead of anecdotal.

The data-availability matrix now reports:

| Field                        | Status      | Source           | Observed | Eligible | Sessions |
| ---------------------------- | ----------- | ---------------- | -------: | -------: | -------: |
| `custom_entries`             | available   | custom entry     |    7,775 |    7,775 |      793 |
| `extension_version`          | available   | custom entry     |      957 |      957 |      793 |
| `session_fidelity`           | available   | dedicated column |    1,032 |    1,032 |    1,032 |
| `message_source_ref`         | available   | dedicated column |  173,458 |  173,458 |    1,024 |
| `step_raw_event_ref`         | available   | dedicated column |   40,464 |   40,464 |    1,032 |
| `schema_hash`                | available   | custom entry     |   20,381 |      957 |      793 |
| `repository_state`           | partial     | custom entry     |    1,404 |   55,599 |      210 |
| `policy_prompt_display`      | available   | custom entry     |      788 |      788 |       25 |
| `artifact_references`        | partial     | custom entry     |      396 |   63,374 |      122 |
| `artifact_consumer_tracking` | unavailable | none             |        0 |   55,599 |        0 |
| `codegraph_index_state`      | available   | custom entry     |      125 |      125 |       47 |

`policy_prompt_display` and `codegraph_index_state` moved from unavailable to available relative to the previous report, but both have narrow session coverage.

`artifact_consumer_tracking` remains unavailable because no record identifies the consumer of a produced artifact.

`repository_state` coverage rose from 318 to 1,404 of 55,599 calls after the custom-entry merge, but it is still too low to label the remaining unknown-state duplicates as waste.

## Data map verification

The `bash-tools` data map was checked against the captured records, and most of it is confirmed.

These claims did not match the current data and should not be built on as written:

- `repositoryStateStatus` does not exist on `project-command-invocation` (0 of 1,239 records). The available fields are `stateDrift`, `sharedExecution`, and `repositoryState.stateMatchesCurrent` / `repositoryState.readable`.
- The edit codes `edit-stale-context` and `edit-unchanged-retry` do not appear. The observed codes are `edit-no-match` (507), `edit-ambiguous` (222), `edit-overlap` (15), and `edit-no-op` (3), so the proposed evidence-backed stale separation is not yet available.
- Git results carry `output.{truncated,totalBytes,totalLines}` on 2,908 results and `mode` on 747, but `head` and `dirtyFilesDigest` appear on only 5 results in this snapshot, so the claimed 1.1.0 coverage widening is barely represented.
- `policyId` and `authFingerprint` are not on `authorization-outcome` (0 of 797). They live in tool-result payloads.
- `git-invocation.repositoryState` uses `repositoryId` and `dirtyDigest`, not `repositoryIdentity` and `dirtyFilesDigest`.
- Version is not always one per session: one session has 12 inventory entries with 2 distinct `extensionVersion` values, so multi-version sessions must stay excluded.

Confirmed claims that the analyzer now consumes:

- `tools[].sourceInfo` is present on 3,873 of 3,873 tool entries for `path`, `source`, `scope`, and `origin`, and on 2,897 for `baseDir`.
- `project-command-invocation` carries `publication` (29), `lookup` (41), `verdict` (120), `aggregate` (176), `role`/`delegationId`/`flowId` (419), `ref` (124), and `coercions` (36).
- `read-batch-invocation` carries `items[].ref` and `scope` but no `role`, `delegationId`, `publication`, or `lookup`, so only producer linking is possible today.
- `authorization-outcome` is missing `mode`, `flowId`, `policySource`, `role`, and `delegationId`.
- `git-invocation.unchanged` was `false` on all 51 records, so git summary reuse is not exercised yet.

Two more items were diagnosed rather than implemented:

- Git `mode` is absent on 2,161 of 2,908 result payloads, so a `(none)` mode bucket dominates and mode-based segmentation is only partially useful.
- The malformed tool names are not ours to fix. The raw Pi log already contains `{"type":"toolCall","name":"ls ...</arg_value>","arguments":{}}`, and this repository has no `arg_value` parsing. The upstream layer that turns a model's text-form tool call into a structured `toolCall` block produced the wrong `name`. The analyzer now isolates these under `malformedToolCalls`.

## Comparison with findings-0909

The windows differ by six days, so only rates and structural signals are compared.

The tool-error rate was 8.55% in the previous report and 8.74% in this 30-day window, but improved to 7.86% in the latest week.

The exact-duplicate excess rate was 9.93% in the previous report and 11.23% here, so duplicate churn worsened rather than improved.

Cross-child duplicate excess was 6.28% in the previous report's latest week and 7.66% in the latest week here.

The maximum fan-out was 72 in the previous report and 76 here.

Subagent p95 latency fell from 1,269,860 ms in the previous report to 845,765 ms over 30 days and 575,992 ms in the latest week.

The computed/reported cost delta fell from $15.62 to $2.10 over 30 days, but reversed to -$15.09% in the latest week.

`project_command` remained the largest failure and duplicate hotspot, with 3,890 excess calls and a 27.9% error rate.

The previously unavailable extension version, policy-prompt display, and Codegraph index state are now recorded, and the analyzer consumes them.

## Recommendations for the next iteration

1. Raise project-command cache reuse above the current 0.96%.
   Remove or justify the 2,064 forced bypasses, and key the cache on a workspace fingerprint that includes `repositoryState` `head` and `dirtyDigest`.
2. Cut the 57.5% non-execution project-command wall-time overhead.
   Instrument preparation, policy, and queue time per invocation and target the largest component.
3. Add a shared evidence broker for cross-child reads.
   The 72-child single-ledger read and the repeated `git_status` and `node_test` calls are the highest-value first targets.
4. Add typed validation preflight for `git_status`, `git_log`, and `git_diff`.
   Empty `path`, empty `revision`, and conflicting `path`/`paths` accounted for 487 errors.
5. Make `project_command` and `codegraph_sync` idempotent per workspace state.
   `codegraph_sync` produced 362 excess calls with zero errors, which is pure redundancy.
6. Distinguish budget-driven stops from tool failures in the analyzer.
   The 302 budget and discovery-block messages are now a first-class `orchestration_budget` category, so workflow policy can be tuned separately from tool reliability.
7. Improve `edit` reliability.
   Stale-context and ambiguous-match failures still account for 422 errors.
8. Serve `package.json`, `PLAN.md`, flow ledgers, and large source files through hashed or paginated reads.
   `package.json` produced only 102 unique hashes across 451 reads.
9. Treat authorization as automatic where the telemetry shows no prompt.
   The one 120-second prompt timeout should be reviewed to confirm it is not a blocking default.
10. Keep the `1.0.3` cohort as the baseline and re-run the weekly buckets after the next release to confirm the error-rate improvement holds.

## Analyzer implementation status

The analyzer was extended during this investigation so the new extension telemetry is machine-readable.

`versionAwareAnalysis` now emits `authorizationTelemetry`, `projectCommandTelemetry`, and `codegraphTelemetry`.

It also emits `customEntryFieldCoverage`, which lists per-custom-type field presence and exposes telemetry gaps such as null `status` values.

Tool source attribution is emitted under `sourceAttribution`, using inventory `sourceInfo` to separate builtin, package, project-extension, and CLI calls, and isolating malformed tool names into `malformedTools`.

Failure analysis now emits `errorAnalysis.structuredCodes`, which counts provider error codes directly instead of relying on message normalization.

Version cohorts now include error rate, duplicate excess, latency, cache decisions, and evidence-reuse counts.

`projectCommandTelemetry` now includes publications, publication failures, lookups, verdicts, aggregate runs, shared-execution runs, refs, coercions, and a `forcedBypass` breakdown by role and command.

`errorAnalysis.rates` now reports both the inclusive error rate and the rate excluding expected authorization and fail-closed outcomes.

`versionAwareAnalysis.gitTelemetry` reports git invocation reuse, result modes, truncation, and byte and line volume.

`versionAwareAnalysis.readBatchTelemetry` reports produced `rr_` references, truncation, and unchanged items, and marks consumer attribution as unavailable.

State-aware duplication now merges custom-entry repository state, which raised call state coverage from 323 to 1,404, and reports `stateSources` and `customStatePairs`.

Retry analysis now reports `retryTargets` and separates unchanged non-retryable retries from unchanged retries with unknown retryability.

Cost analysis now reports `nonCachedInputShare` and explicit pricing `mismatches`.

Data quality now reports `stepsWithMissingInputTokens` and `stepsWithImplausibleInputTokens`.

The `dataAvailability` matrix now marks `policy_prompt_display` and `codegraph_index_state` as available from custom entries and counts custom-entry `ref` values toward `artifact_references`.

Database custom entries are now filtered by their own event timestamp, which fixed a leak where a post-window inventory entry could become the reported latest version.

The analyzer test suite covers the new telemetry, source attribution, structured codes, cohort metrics, git and read-batch telemetry, dual error rates, and the window-filtering behavior and passes 18 tests.

Persisting the provider tool-call id on tool-call messages is the next enabler, because it would replace the approximate session-and-command pairing with an exact join.

The remaining analyzer gaps are artifact-consumer identity, broader repository-state coverage, and a durable same-child duplicate scope.

## Final conclusion

The latest data confirms the same workflow shape as the previous report: heavy cross-child validation, repeated context acquisition, and a validation pipeline that rarely reuses results.

What changed is observability.

The extension telemetry now makes authorization decisions, cache reuse, workspace drift, command wall time, and Codegraph freshness directly measurable.

The strongest evidence supports a workflow architecture centered on typed validation preflight, workspace-fingerprint evidence caching, shared cross-child artifacts, bounded retry policies, explicit orchestration budgets, and compact child contracts.

The immediate priorities for `subagent-herdr` and `bash-tools` are shared evidence caching, cached typed validation commands, artifact-oriented batch reads, bounded search and diff operations, and flow-ledger summaries with cursors.
