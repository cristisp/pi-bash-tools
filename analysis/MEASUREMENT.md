# Orchestration measurement

Agent dir `/Users/cristian.spissack/.pi/agent`. Window 2026-07-13T15:15 .. 2026-09-05T16:36. 365 root sessions, 890 child sessions, 105 telemetry records. Report cutoff 2026-09-03T10:06.

## Delivered `subagent` result size (estimated tokens, chars / 4)

| window | n | avg | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| before cutoff | 1171 | 1514 | 1145 | 5294 | 8698 | 19559 |
| at or after cutoff | 119 | 558 | 592 | 1131 | 1966 | 2102 |
| all | 1290 | 1426 | 1013 | 4912 | 8657 | 19559 |
| baseline 2026-08-26..09-02 | 285 | 1821 | 900 | - | 6099 | - |

## Report digest fidelity (telemetry turns carrying a report)

Delivered results joined to a telemetry report by report path: 5 / 93.

| role | turns | median full | median digest | digest/full | ledger | cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| reviewer | 48 | 2433 | 637 | 26% | 46/48 | $2.1754 |
| worker | 33 | 2103 | 610 | 29% | 29/33 | $1.9533 |
| validator | 9 | 2083 | 766 | 37% | 9/9 | $0.1337 |
| planner | 3 | 2780 | 549 | 20% | 3/3 | $0.1143 |

## Root report reads (the W3 Slice D signal)

These are root-session read requests targeting files under `flows/*/reports/*.md`; child session reads are excluded.

| window | report reads |
| --- | ---: |
| before cutoff | 0 |
| at or after cutoff | 61 |
| all | 61 |

## Root carry (the W3 target)

Carry is result tokens x the number of later assistant turns in the same root session, i.e. how often that text re-entered the model before the session ended.

| window | results | delegating roots | carry (token-times) | carry per root |
| --- | ---: | ---: | ---: | ---: |
| before cutoff | 1171 | 66 | 281,043,046 | 4,258,228 |
| at or after cutoff | 119 | 5 | 30,130,870 | 6,026,174 |
| all | 1290 | 70 | 311,142,566 | 4,444,894 |

Root sessions received 1,839,316 estimated tokens of subagent results in total.

Child sessions created since telemetry began (2026-09-03T09:14): 93, of which 0 have no telemetry record. Historic children cannot be attributed and are excluded.

Child spend recorded in telemetry: $4.4002 across 105 turns.

## Validation evidence (the W7 target)

Per role and overall: delegations carrying a `verify` ref, refs minted, refs executed rather than reused, refs resolved by lookup, full validation passes charged, and executions per distinct repository-state digest. Deduplication means grouping records by `flowId`, counting the distinct `stateDigest` values across the refs minted in that flow, and dividing executed mints by that count, because a ratio above 1 is the duplicate execution this workstream exists to remove.

| scope | delegations | delegations with refs | refs minted | refs executed | refs reused | refs by lookup | full validation passes | distinct state digests | executions per digest |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| overall | 105 | 5 | 5 | 5 | 0 | 3 | 113 | 4 | 1.25 |
| reviewer | 51 | 1 | 0 | 0 | 0 | 1 | 1 | 0 | - |
| worker | 38 | 3 | 5 | 5 | 0 | 0 | 91 | 4 | 1.25 |
| validator | 13 | 1 | 0 | 0 | 0 | 2 | 21 | 0 | - |
| planner | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| baseline 2026-09-05 plan: 1,075 duplicate project_command calls, 49.7% of them | - | - | - | - | - | - | - | - | - |

Every ref counted here was minted by a delegated child seat, because root spend is not in telemetry. Minting works and is authorized per `verify` call shape, so a zero here after children ran the gate means the shape was refused (`F9` in `analysis/BASH_TOOLS_FOLLOWUPS.md`) rather than that validation was deduplicated.

## Guide reads and rendered size (the W8 target)

The `subagent` tool description and the child prompts now carry what used to require a guide read, so this counts root-session `read` requests whose path ends in `subagent_orchestration.md` or the retired `SUBAGENTS_GUIDE.md`, and prices the rendered guide itself with the same chars / 4 estimator. Child-session reads are excluded, just as flow-report reads are above.

| window | guide reads | reads per delegating root |
| --- | ---: | ---: |
| before cutoff | 80 | 1.21 |
| at or after cutoff | 12 | 2.40 |
| all | 92 | 1.31 |
| rendered guide (est. tokens) | 5722 | - |

Rendered guide source `agents/subagent_orchestration.md` at 22886 chars; the size reads `-` when that file is absent from the agent dir, which is a missing artifact rather than a cost of zero.
