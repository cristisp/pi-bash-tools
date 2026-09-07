# Orchestration measurement

Agent dir `/Users/cristian.spissack/.pi/agent`. Window 2026-07-13T15:15 .. 2026-09-07T15:37. 383 root sessions, 924 child sessions, 144 telemetry records. Report cutoff 2026-09-03T10:06.

## Delivered `subagent` result size (estimated tokens, chars / 4)

| window | n | avg | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| before cutoff | 1171 | 1514 | 1145 | 5294 | 8698 | 19559 |
| at or after cutoff | 182 | 499 | 541 | 960 | 1966 | 2102 |
| all | 1353 | 1378 | 955 | 4712 | 8559 | 19559 |
| baseline 2026-08-26..09-02 | 285 | 1821 | 900 | - | 6099 | - |

## Report digest fidelity (telemetry turns carrying a report)

Delivered results joined to a telemetry report by report path: 5 / 129.

| role | turns | median full | median digest | digest/full | ledger | cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| reviewer | 62 | 2451 | 635 | 26% | 60/62 | $2.8480 |
| worker | 47 | 1639 | 581 | 35% | 43/47 | $3.0137 |
| validator | 14 | 1566 | 589 | 38% | 13/14 | $0.1614 |
| planner | 5 | 2353 | 484 | 21% | 5/5 | $0.1532 |
| scout | 1 | 2636 | 600 | 23% | 1/1 | $0.0243 |

## Root report reads (the W3 Slice D signal)

These are root-session read requests targeting files under `flows/*/reports/*.md`; child session reads are excluded.

| window | report reads |
| --- | ---: |
| before cutoff | 0 |
| at or after cutoff | 90 |
| all | 90 |

## Root carry (the W3 target)

Carry is result tokens x the number of later assistant turns in the same root session, i.e. how often that text re-entered the model before the session ended.

| window | results | delegating roots | carry (token-times) | carry per root |
| --- | ---: | ---: | ---: | ---: |
| before cutoff | 1171 | 66 | 281,043,046 | 4,258,228 |
| at or after cutoff | 182 | 13 | 41,357,280 | 3,181,329 |
| all | 1353 | 78 | 322,368,976 | 4,132,936 |

Root sessions received 1,863,781 estimated tokens of subagent results in total.

Child sessions created since telemetry began (2026-09-03T09:14): 127, of which 0 have no telemetry record. Historic children cannot be attributed and are excluded.

Child spend recorded in telemetry: $6.2240 across 144 turns.

## Validation evidence (the W7 target)

Per role, flow, and overall: delegations carrying a `verify` ref, refs minted, refs executed rather than reused, refs resolved by lookup, failed lookups, reuse rate, full validation passes charged, and executions per distinct repository-state digest. Deduplication means grouping records by `flowId`, counting the distinct `stateDigest` values across the refs minted in that flow, and dividing executed mints by that count, because a ratio above 1 is the duplicate execution this workstream exists to remove. When the producer invocation stream is present, its one-record-per-call execution decision refines the consumer-side telemetry; otherwise the report says only what the extension observed.

Producer invocation stream: `/tmp/bash-tools-child-invocations.jsonl` (8 verify records).

| scope | delegations | delegations with refs | refs minted | refs executed | refs reused | refs by lookup | full validation passes | distinct state digests | executions per digest |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| overall | 144 | 16 | 6 | 6 | 0 | 2 | 147 | 5 | 1.20 |
| reviewer | 65 | 5 | 0 | 0 | 0 | 2 | 1 | 2 | 0.00 |
| worker | 55 | 6 | 3 | 3 | 0 | 0 | 120 | 3 | 1.00 |
| validator | 18 | 5 | 3 | 3 | 0 | 0 | 26 | 3 | 1.00 |
| planner | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| scout | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |

Per-flow reuse and lookup outcomes:

| scope | lookup failures | failure classes | reuse rate | producer invocations | producer executions | state drift | max concurrent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| flow:- | 0 | - | - | 0 | 0 | 0 | 1 |
| flow:f09091d37c4540e11 | 0 | - | 33% | 6 | 4 | 1 | 1 |
| flow:f24b7aa13a9fddecf | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:f4a7c827e86180efe | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:f5c2642cf9a782025 | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:f65373a6532523635 | 0 | - | 0% | 1 | 1 | 0 | 1 |
| flow:f66830a6253edf355 | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:f747a9848ce3654b8 | 0 | - | 0% | 1 | 1 | 0 | 1 |
| flow:f780b529fc311e206 | 0 | - | 38% | 0 | 0 | 0 | 0 |
| flow:f85f194e1b61c28e3 | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:f87aead9c5444bde2 | 0 | - | 0% | 0 | 0 | 0 | 1 |
| flow:fc9799eb401af8d25 | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:fecffe2687f7928ba | 0 | - | - | 0 | 0 | 0 | 1 |
| flow:ff8106728ab056c4b | 0 | - | 100% | 0 | 0 | 0 | 0 |
| baseline 2026-09-05 plan: 1,075 duplicate project_command calls, 49.7% of them | - | - | - | - | - | - | - | - | - |

## Repository write lock contention (S2)

Counts consumer-enforced refusals while a sibling held the repository write lock. The validation table includes state-drift and concurrency diagnostics from all producer command records, not only verify calls; producer diagnostics remain unavailable when the stream is absent.

| scope | lock refusals |
| --- | ---: |
| overall | 0 |
| reviewer | 0 |
| worker | 0 |
| validator | 0 |
| planner | 0 |
| scout | 0 |
| flow:- | 0 |
| flow:f09091d37c4540e11 | 0 |
| flow:f24b7aa13a9fddecf | 0 |
| flow:f4a7c827e86180efe | 0 |
| flow:f5c2642cf9a782025 | 0 |
| flow:f65373a6532523635 | 0 |
| flow:f66830a6253edf355 | 0 |
| flow:f747a9848ce3654b8 | 0 |
| flow:f780b529fc311e206 | 0 |
| flow:f85f194e1b61c28e3 | 0 |
| flow:f87aead9c5444bde2 | 0 |
| flow:fc9799eb401af8d25 | 0 |
| flow:fecffe2687f7928ba | 0 |
| flow:ff8106728ab056c4b | 0 |

Every ref counted here was minted by a delegated child seat, because root spend is not in telemetry. Minting works and is authorized per `verify` call shape, so a zero here after children ran the gate means the shape was refused (`F9` in `analysis/BASH_TOOLS_FOLLOWUPS.md`) rather than that validation was deduplicated.

## Guide reads and rendered size (the W8 target)

The `subagent` tool description and the child prompts now carry what used to require a guide read, so this counts root-session `read` requests whose path ends in `subagent_orchestration.md` or the retired `SUBAGENTS_GUIDE.md`, and prices the rendered guide itself with the same chars / 4 estimator. Child-session reads are excluded, just as flow-report reads are above.

| window | guide reads | reads per delegating root |
| --- | ---: | ---: |
| before cutoff | 80 | 1.21 |
| at or after cutoff | 21 | 1.62 |
| all | 101 | 1.29 |
| rendered guide (est. tokens) | 5819 | - |

Rendered guide source `agents/subagent_orchestration.md` at 23277 chars; the size reads `-` when that file is absent from the agent dir, which is a missing artifact rather than a cost of zero.
