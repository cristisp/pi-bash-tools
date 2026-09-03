# Orchestration measurement

Agent dir `/Users/cristian.spissack/.pi/agent`. Window 2026-07-13T15:15 .. 2026-09-03T19:22. 360 root sessions, 817 child sessions, 28 telemetry records. Report cutoff 2026-09-03T10:06.

## Delivered `subagent` result size (estimated tokens, chars / 4)

| window | n | avg | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| before cutoff | 1171 | 1514 | 1145 | 5294 | 8698 | 19559 |
| at or after cutoff | 32 | 410 | 535 | 794 | 1214 | 1214 |
| all | 1203 | 1485 | 1125 | 5132 | 8657 | 19559 |
| baseline 2026-08-26..09-02 | 285 | 1821 | 900 | - | 6099 | - |

## Report digest fidelity (telemetry turns carrying a report)

Delivered results joined to a telemetry report by report path: 5 / 20.

| role | turns | median full | median digest | digest/full | ledger | cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| worker | 11 | 1184 | 551 | 47% | 7/11 | $0.0829 |
| reviewer | 7 | 2354 | 511 | 22% | 7/7 | $0.2088 |
| planner | 1 | 2867 | 549 | 19% | 1/1 | $0.0817 |
| validator | 1 | 1481 | 543 | 37% | 1/1 | $0.0098 |

## Root report reads (the W3 Slice D signal)

These are root-session read requests targeting files under `flows/*/reports/*.md`; child session reads are excluded.

| window | report reads |
| --- | ---: |
| before cutoff | 0 |
| at or after cutoff | 15 |
| all | 15 |

## Root carry (the W3 target)

Carry is result tokens x the number of later assistant turns in the same root session, i.e. how often that text re-entered the model before the session ended.

| window | results | delegating roots | carry (token-times) | carry per root |
| --- | ---: | ---: | ---: | ---: |
| before cutoff | 1171 | 66 | 281,043,046 | 4,258,228 |
| at or after cutoff | 32 | 3 | 5,083,965 | 1,694,655 |
| all | 1203 | 68 | 286,095,661 | 4,207,289 |

Root sessions received 1,786,032 estimated tokens of subagent results in total.

Child sessions created since telemetry began (2026-09-03T09:14): 20, of which 0 have no telemetry record. Historic children cannot be attributed and are excluded.

Child spend recorded in telemetry: $0.4066 across 28 turns.
