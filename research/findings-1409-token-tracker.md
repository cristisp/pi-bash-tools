# Bash-tools context pack and requested changes (data through 2026-09-14)

Analysis of Pi sessions in the token-tracker telemetry, focused on the
bash-tools extension (`@ztc/bash-tools`). All numbers are measured from
captured tool results and custom entries, not inferred. The 7-day window is
`2026-09-07` through `2026-09-14` unless stated otherwise.

## TL;DR

1. `read_batch` collapsed from 9 percent of read calls to under 2 percent on
   09-10 because the tool stopped being active in sessions, not because the
   model stopped wanting it. Availability, not willingness.
2. Children never get the tool at all (0 of 264 child sessions), yet children
   do 59 percent of all file reads. That is the largest adoption lever.
3. The `unchanged` ref mechanism works correctly (zero false-unchanged flags)
   but fired on 6 of 508 repeat reads because files churn between reads.
   Add digest-on-repeat keyed off the existing refs.
4. The tool has two small producer leaks: 13.9 percent of items are duplicate
   paths inside one call, and 16 outside-repository requests return silent
   empty results with no error flag.
5. On the same extension: default `git_diff` to summary mode (median 6.5 KB
   versus 9.6 KB for patch), and tighten grep default context. Both are
   pre-measured, multi-MB levers.
6. `read-batch-invocation` custom entries are emitted for only 7 of 314
   tool results (2 percent), so the analyzer cannot see most invocations.

## read_batch: what the data says

Scale in 7d: 314 calls, 873 items, 2.8 items per call, 4.81 MB of results,
versus 5,677 plain `read` results (38.86 MB).

Adoption by day (batch share of all read-shaped calls):

| Day   | Plain read | read_batch | Batch share |
| ----- | ---------: | ---------: | ----------: |
| 09-05 |      1,369 |         27 |        1.9% |
| 09-06 |        196 |          8 |        3.9% |
| 09-07 |        948 |         75 |        7.3% |
| 09-08 |      1,065 |        106 |        9.1% |
| 09-09 |      1,181 |        117 |        9.0% |
| 09-10 |      1,795 |          3 |        0.2% |
| 09-11 |        687 |         13 |        1.9% |
| 09-14 |      1,478 |          4 |        0.3% |

The collapse tracks availability exactly. Sessions with the tool active fell
from 15, 17, and 6 (09-07 through 09-09) to 8, 1, and 4 (09-10, 09-11, 09-14).
Where the tool was available, usage rates stayed constant throughout (25 to
100 percent of available sessions, averaging about half). The same extension
versions appear in some sessions with `read_batch` active and in others
without it, so the gate is configuration, not version.

### Children cannot use it

- Root sessions: 48 of 50 in the 7d window have `read_batch` active.
- Child sessions: 0 of 264.
- Children load the same `@ztc/bash-tools` extension (47 tool entries per
  child inventory) with a 15-tool active set that drops `read_batch`, `bash`,
  `subagent*`, `codegraph_sync`, and `lavish_*`.

Children are the heavy readers: 3,361 plain reads (59 percent) and 25.39 MB
of read bytes. At the observed peak behavior (9 percent of read calls batched,
2.8 items per call), enabling children would compress about 3,059 read
round-trips per week into roughly 300 batch calls.

### It is a round-trip win, not a byte win

873 items arrived in 314 calls, saving 559 round-trips (64 percent). But
batch items cost the same context bytes as plain reads: item content p50 is
3.5 KB versus 3.9 KB for plain reads (p90 10.6 KB versus 15.9 KB). Batch
requests carry tighter explicit ranges (limits of 45 to 500 lines) while
plain reads usually fetch whole files (805 of 5,677 with no limit). Do not
sell read_batch as a context reducer; it is latency and bookkeeping.

### The unchanged mechanism is correct but idle

Of 508 batch items that re-read a path already batch-read earlier in the same
session:

- 6 were flagged `unchanged`.
- 435 had genuinely changed content (the agent edited the file between
  reads), so re-shipping is correct.
- 53 re-shipped byte-identical content (0.20 MB wasted).
- Zero false-unchanged flags: the ref and hash plumbing works.

Files churn between reads in active development, so a flag-only dedup will
never pay off. The useful version is digest-on-repeat: when the recomputed
hash matches the ref's hash, replace `content` with a short digest line and
keep the `ref`, so the model can still request the diff since the last read.

### Enumerated producer leaks

- Intra-call duplicates: 87 of 314 calls contain the same path twice
  (121 items, 13.9 percent of items). Dedupe within a call or reject with an
  error line per duplicate.
- Silent empty results: 16 requested items resolved to
  `<outside-repository>` and returned empty `output` with no error flag, so
  the model cannot distinguish a failed fetch from an empty file. Mark
  unresolvable paths as errors with the reason.
- Self-redundancy: 154 of 873 items re-read a path a plain `read` had fetched
  within the previous ten reads. A per-path digest from the extension would
  let the model skip these without a round-trip.
- Post-batch re-reads: 180 plain reads of just-batched paths within the next
  ten reads. Geometry: 31 fully inside the batch window (pure waste), 42
  continuations beyond the window (legitimate), 104 partial overlaps. The
  21 percent headline is mostly windowed reading, not duplication.

### Requested producer fields on `read-batch-invocation`

Additive under `invocationFormatVersion: 1`, best-effort inside the existing
recorder try/catch, never gated on role:

- `availability` (or the reason the tool is not in the inventory): the
  analyzer needs to distinguish "tool absent" from "model chose not to use
  it". This is the field that would have diagnosed the 09-10 collapse on its
  own.
- `role` / `delegationId` (consumer identity; today the consumer half of the
  `rr_` ref join is `'unavailable'`).
- `publication` block (same semantics as project-command-invocation).
- Per-item `unchangedCount` (or per-item flags): only 6 of about 880 items
  fired; the analyzer wants the count per call.
- `digestOnRepeat` marker (or a `mode` field) so adoption of digest-on-repeat
  is measurable.
- Emit the record for every invocation: currently 7 records against 314 tool
  results, so 98 percent of invocations are invisible to telemetry.

## Git evidence: two pre-measured levers

7d: 511 `git_diff` results (6.62 MB), patch median 9.6 KB versus summary
median 6.5 KB. Defaulting to summary mode saves roughly 0.6 MB per week on
diff alone and keeps the diff answer shorter than capping would.

Reuse is never exercised: `git-invocation.unchanged` is false on all 51
records in the window, and `head` / `dirtyFilesDigest` appear on only 5
results. Either the reuse key is too strict or callers do not send matching
signatures; the `mode` / `maxBytes` / `truncated` fields on
`git-invocation` would make the branch measurable.

Also requested (already on the list): `preparationMs` / `authorizationMs` /
`queueMs` on `project-command-invocation` to split the 57.5 percent
non-execution wall-time headline, and `mode` (`tui|rpc|print`), `flowId`,
`policySource`, `role`, `delegationId` on `authorization-outcome`.

## Result verbosity caps (context channel)

7d tool-result channel: 80.76 MB across 17,188 results, about 20M tokens
against 33.1M non-cached input tokens.

- An 8 KB result cap saves 32.8 MB per week (4 KB saves 47.7 MB, 16 KB saves
  17.3 MB). Saturation is rare (1.4 percent of reads, 2.4 percent of grep,
  2.8 percent of bash exceed 50 KB), so a cap mostly hits the tail.
- `read` is the largest channel (5,677 results, 38.89 MB, p95 23.2 KB) and
  repeats are the bigger half: 80 percent of reads are repeat reads, and
  repeat bytes after an 8 KB cap total 20.54 MB. Caps alone miss this; the
  per-path digest-on-repeat is the 66 percent-of-channel lever (8 KB caps
  plus digest-on-repeat saves 53.3 MB per week).
- `grep` context defaults: `context >= 2` carries 14.7 MB of the 16.79 MB
  grep total, while `context: 0` has a median result of 627 B. The
  limit-100 and limit-200 groups carry 7.38 MB. Defaulting context to 0 and
  tightening limit saves roughly 10 MB per week with no tool change.
- `project_command` results are fine (2,097 results, 2.50 MB, p95 2.2 KB) -
  no cap needed there.

## Error accounting

`Project command confirmation timed out` results carry no structured code and
were historically misclassified as provider timeouts; the analyzer now
classifies them separately (30-day dual error rate: 8.74 percent inclusive
versus 7.05 percent excluding policy, orchestration-budget, and
confirmation-timeout outcomes). If bash-tools can emit a structured code for
confirmation timeouts and forced bypasses, the analyzer can stop inferring
them from message text.

Forced bypass context: 2,064 forced runs across 137 sessions, with roles
`(none)` 1,994, worker 42, validator 28, and top commands node_test 761,
node_lint 423, node_format 380. Bypass is caller-driven, not role-driven, so
the fix belongs to the callers and the policy layer, not the tool.

## Constraints for the producer fields

From the project conventions:

- Additive and optional under `invocationFormatVersion: 1`; bump the version
  only if shapes change.
- Best-effort inside the recorder try/catch; telemetry must never break the
  tool call.
- Never gate tool behavior on role or workflow policy.
- Respect the existing 8 KiB cap for custom-entry payloads.
- No file paths, file content, environment values, or raw policy blobs in the
  records.

## Suggested order of work

1. Restore `read_batch` availability (the 09-10 regression) and add the
   availability reason field.
2. Expose `read_batch` to child sessions (59 percent of reads, zero current
   access).
3. Digest-on-repeat keyed off existing `rr_` refs, with per-item
   `unchangedCount` telemetry.
4. Intra-call dedupe and error flags for unresolvable paths.
5. Default `git_diff` to summary mode; report `mode` / `maxBytes` /
   `truncated` on `git-invocation`.
6. Default grep context to 0 and consider limit 50 (measured saving about
   10 MB per week).
7. Emit `read-batch-invocation` for every invocation so the analyzer sees
   more than 2 percent of them.
8. Structured codes for confirmation timeouts on project commands.
