# Orchestration measurement

Agent dir `/Users/cristian.spissack/.pi/agent`. Window 2026-07-13T15:15 .. 2026-09-03T12:39. 358 root sessions, 803 child sessions, 13 telemetry records. Report cutoff 2026-09-03T10:06.

## Delivered `subagent` result size (estimated tokens, chars / 4)

| window | n | avg | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| before cutoff | 1171 | 1514 | 1145 | 5294 | 8698 | 19559 |
| at or after cutoff | 7 | 433 | 472 | 1214 | 1214 | 1214 |
| all | 1178 | 1508 | 1143 | 5294 | 8698 | 19559 |
| baseline 2026-08-26..09-02 | 285 | 1821 | 900 | - | 6099 | - |

## Report digest fidelity (telemetry turns carrying a report)

Delivered results joined to a telemetry report by report path: 5 / 6.

| role | turns | median full | median digest | digest/full | ledger | cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| worker | 6 | 2625 | 551 | 21% | 2/6 | $0.0237 |

## Root carry (the W3 target)

Carry is result tokens x the number of later assistant turns in the same root session, i.e. how often that text re-entered the model before the session ended.

| window | results | delegating roots | carry (token-times) | carry per root |
| --- | ---: | ---: | ---: | ---: |
| before cutoff | 1171 | 66 | 279,970,142 | 4,241,972 |
| at or after cutoff | 7 | 1 | 416,829 | 416,829 |
| all | 1178 | 66 | 280,355,621 | 4,247,812 |

Root sessions received 1,775,932 estimated tokens of subagent results in total.

Child sessions created since telemetry began (2026-09-03T09:14): 6, of which 0 have no telemetry record. Historic children cannot be attributed and are excluded.

Child spend recorded in telemetry: $0.0398 across 13 turns.
