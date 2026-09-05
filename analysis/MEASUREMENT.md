# Orchestration measurement

Agent dir `/Users/cristian.spissack/.pi/agent`. Window 2026-07-13T15:15 .. 2026-09-05T09:55. 361 root sessions, 856 child sessions, 68 telemetry records. Report cutoff 2026-09-03T10:06.

## Delivered `subagent` result size (estimated tokens, chars / 4)

| window | n | avg | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| before cutoff | 1171 | 1514 | 1145 | 5294 | 8698 | 19559 |
| at or after cutoff | 81 | 500 | 585 | 763 | 1214 | 1214 |
| all | 1252 | 1449 | 1056 | 5118 | 8657 | 19559 |
| baseline 2026-08-26..09-02 | 285 | 1821 | 900 | - | 6099 | - |

## Report digest fidelity (telemetry turns carrying a report)

Delivered results joined to a telemetry report by report path: 5 / 59.

| role | turns | median full | median digest | digest/full | ledger | cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| reviewer | 33 | 2229 | 590 | 26% | 33/33 | $1.4377 |
| worker | 19 | 1422 | 551 | 39% | 15/19 | $0.4458 |
| validator | 4 | 1566 | 589 | 38% | 4/4 | $0.0493 |
| planner | 3 | 2780 | 549 | 20% | 3/3 | $0.1143 |

## Root report reads (the W3 Slice D signal)

These are root-session read requests targeting files under `flows/*/reports/*.md`; child session reads are excluded.

| window | report reads |
| --- | ---: |
| before cutoff | 0 |
| at or after cutoff | 46 |
| all | 46 |

## Root carry (the W3 target)

Carry is result tokens x the number of later assistant turns in the same root session, i.e. how often that text re-entered the model before the session ended.

| window | results | delegating roots | carry (token-times) | carry per root |
| --- | ---: | ---: | ---: | ---: |
| before cutoff | 1171 | 66 | 281,043,046 | 4,258,228 |
| at or after cutoff | 81 | 3 | 22,884,757 | 7,628,252 |
| all | 1252 | 68 | 303,896,453 | 4,469,065 |

Root sessions received 1,813,370 estimated tokens of subagent results in total.

Child sessions created since telemetry began (2026-09-03T09:14): 59, of which 0 have no telemetry record. Historic children cannot be attributed and are excluded.

Child spend recorded in telemetry: $2.0706 across 68 turns.
