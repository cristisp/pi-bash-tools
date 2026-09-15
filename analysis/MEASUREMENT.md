# Orchestration measurement

Agent dir `/Users/cristian.spissack/.pi/agent`. Window 2026-07-13T15:15 .. 2026-09-08T23:14. 401 root sessions, 1047 child sessions, 290 telemetry records. Report cutoff 2026-09-08T22:59.

## Delivered `subagent` result size (estimated tokens, chars / 4)

| window | n | avg | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| before cutoff | 1468 | 1306 | 856 | 4480 | 8512 | 19559 |
| at or after cutoff | 6 | 317 | 330 | 549 | 549 | 549 |
| all | 1474 | 1302 | 849 | 4480 | 8512 | 19559 |
| baseline 2026-08-26..09-02 | 285 | 1821 | 900 | - | 6099 | - |

## Report digest fidelity (telemetry turns carrying a report)

Delivered results joined to a telemetry report by report path: 5 / 248.

| role | turns | median full | median digest | digest/full | ledger | cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| worker | 115 | 1151 | 444 | 39% | 108/115 | $5.0001 |
| reviewer | 82 | 2354 | 608 | 26% | 80/82 | $3.5108 |
| validator | 41 | 675 | 257 | 38% | 37/41 | $0.3475 |
| planner | 8 | 2293 | 484 | 21% | 8/8 | $0.2548 |
| scout | 2 | 2636 | 600 | 23% | 2/2 | $0.0671 |

## Root report reads (the W3 Slice D signal)

These are root-session read requests targeting files under `flows/*/reports/*.md`; child session reads are excluded.

| window | report reads |
| --- | ---: |
| before cutoff | 140 |
| at or after cutoff | 1 |
| all | 141 |

## Root carry (the W3 target)

Carry is result tokens x the number of later assistant turns in the same root session, i.e. how often that text re-entered the model before the session ended.

| window | results | delegating roots | carry (token-times) | carry per root |
| --- | ---: | ---: | ---: | ---: |
| before cutoff | 1468 | 95 | 329,575,601 | 3,469,217 |
| at or after cutoff | 6 | 2 | 70,430 | 35,215 |
| all | 1474 | 95 | 329,614,681 | 3,469,628 |

Root sessions received 1,918,428 estimated tokens of subagent results in total.

Child sessions created since telemetry began (2026-09-03T09:14): 250, of which 0 have no telemetry record. Historic children cannot be attributed and are excluded.

Child spend recorded in telemetry: $9.2330 across 269 ordinary delegation turns.

## Composition policy events

Typed composition events: 2 (2 warnings, 0 refusals).
By rule: R1:1, R4:1.
By policy: warn:2.
By per-call override: none:2.
Composition events are excluded from ordinary delegation, validation, and child-spend metrics.

## Validation evidence (the W7 target)

Per role, flow, and overall: delegations carrying a `verify` ref, refs minted, refs executed rather than reused, refs resolved by lookup, failed lookups, reuse rate, full validation passes charged, and executions per distinct repository-state digest. Deduplication means grouping records by `flowId`, counting the distinct `stateDigest` values across the refs minted in that flow, and dividing executed mints by that count, because a ratio above 1 is the duplicate execution this workstream exists to remove. When the producer invocation stream is present, its one-record-per-call execution decision refines the consumer-side telemetry; otherwise the report says only what the extension observed.

A second validation table covers `read_batch` evidence and codegraph index states per role, flow, and overall: read refs minted, read refs reused unchanged, read refs resolved by lookup, the structured lookup-outcome distribution (`success`, `not-found`, `unauthorized-flow`, `corrupt`), the number of codegraph results carrying a producer index-state block, and the count of distinct codegraph `indexId` values. Read refs are cross-turn `read_batch` reuse (the producer digest only covers same-session repeats), and the outcome distribution distinguishes a missing ref from a denied or corrupt lookup. This sample predates read-ref capture, so those columns are zero-event only until `read_batch` runs under a build that records them.

Producer invocation stream: unavailable; producer execution columns are not zero-event evidence.

| scope | delegations | delegations with refs | refs minted | refs executed | refs reused | refs by lookup | full validation passes | distinct state digests | executions per digest |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| overall | 269 | 56 | 47 | 47 | 0 | 14 | 302 | 30 | 1.57 |
| worker | 128 | 32 | 36 | 36 | 0 | 0 | 249 | 20 | 1.80 |
| reviewer | 85 | 12 | 0 | 0 | 0 | 12 | 1 | 0 | - |
| validator | 46 | 12 | 11 | 11 | 0 | 2 | 52 | 11 | 1.00 |
| planner | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| scout | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |

Per-flow reuse and lookup outcomes:

| scope | lookup failures | failure classes | reuse rate | producer invocations | producer executions | state drift | max concurrent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| flow:f09091d37c4540e11 | 0 | - | 33% | 0 | 0 | 1 | 1 |
| flow:f16669aa7f2438a52 | 0 | - | 0% | 0 | 0 | 1 | 1 |
| flow:f20f50475abc7acad | 1 | not-found:1 | 25% | 0 | 0 | 0 | 1 |
| flow:f24b7aa13a9fddecf | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:f31c8fe9cb5d4dec4 | 0 | - | 0% | 0 | 0 | 0 | 1 |
| flow:f337ad2fbb0e26406 | 0 | - | 0% | 0 | 0 | 0 | 1 |
| flow:f4a7c827e86180efe | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:f5c2642cf9a782025 | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:f5e81af71dca45d34 | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:f65373a6532523635 | 0 | - | 0% | 0 | 0 | 0 | 1 |
| flow:f66830a6253edf355 | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:f7308b0f341bb4075 | 0 | - | 0% | 0 | 0 | 0 | 1 |
| flow:f747a9848ce3654b8 | 0 | - | 0% | 0 | 0 | 0 | 1 |
| flow:f780b529fc311e206 | 0 | - | 38% | 0 | 0 | 0 | 0 |
| flow:f85f194e1b61c28e3 | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:f87aead9c5444bde2 | 0 | - | 0% | 0 | 0 | 0 | 1 |
| flow:f925c085324674d3f | 0 | - | 0% | 0 | 0 | 0 | 1 |
| flow:fa8b7d2bc8ba5e61a | 0 | - | 0% | 0 | 0 | 0 | 1 |
| flow:fac2339cdccb79935 | 0 | - | - | 0 | 0 | 0 | 1 |
| flow:fada4ffe1f42949b8 | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:fb880c07ca4f96ec0 | 0 | - | 0% | 0 | 0 | 0 | 1 |
| flow:fc5b4d20cb2c6f2e4 | 1 | not-found:1 | 33% | 0 | 0 | 1 | 1 |
| flow:fc9799eb401af8d25 | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:fcb7b5447b11b875a | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:fcee3a892487e3206 | 1 | not-found:1 | 50% | 0 | 0 | 0 | 0 |
| flow:fd8404bb9633d5631 | 1 | not-found:1 | 30% | 0 | 0 | 0 | 1 |
| flow:fe112d2ad387834db | 0 | - | - | 0 | 0 | 0 | 0 |
| flow:fecffe2687f7928ba | 0 | - | - | 0 | 0 | 0 | 1 |
| flow:ff0a1a4ae1003aed1 | 0 | - | 0% | 0 | 0 | 0 | 1 |
| flow:ff8106728ab056c4b | 0 | - | 100% | 0 | 0 | 0 | 0 |
| baseline 2026-09-05 plan: 1,075 duplicate project_command calls, 49.7% of them | - | - | - | - | - | - | - | - | - |

## Repository write lock contention (S2)

Counts consumer-enforced refusals while a sibling held the repository write lock. The validation table includes state-drift and concurrency diagnostics from all producer command records, not only verify calls; producer diagnostics remain unavailable when the stream is absent.

| scope | lock refusals |
| --- | ---: |
| overall | 1 |
| worker | 1 |
| reviewer | 0 |
| validator | 0 |
| planner | 0 |
| scout | 0 |
| flow:f09091d37c4540e11 | 0 |
| flow:f16669aa7f2438a52 | 0 |
| flow:f20f50475abc7acad | 0 |
| flow:f24b7aa13a9fddecf | 0 |
| flow:f31c8fe9cb5d4dec4 | 0 |
| flow:f337ad2fbb0e26406 | 0 |
| flow:f4a7c827e86180efe | 0 |
| flow:f5c2642cf9a782025 | 0 |
| flow:f5e81af71dca45d34 | 0 |
| flow:f65373a6532523635 | 0 |
| flow:f66830a6253edf355 | 0 |
| flow:f7308b0f341bb4075 | 0 |
| flow:f747a9848ce3654b8 | 0 |
| flow:f780b529fc311e206 | 0 |
| flow:f85f194e1b61c28e3 | 0 |
| flow:f87aead9c5444bde2 | 0 |
| flow:f925c085324674d3f | 0 |
| flow:fa8b7d2bc8ba5e61a | 0 |
| flow:fac2339cdccb79935 | 0 |
| flow:fada4ffe1f42949b8 | 0 |
| flow:fb880c07ca4f96ec0 | 0 |
| flow:fc5b4d20cb2c6f2e4 | 0 |
| flow:fc9799eb401af8d25 | 0 |
| flow:fcb7b5447b11b875a | 0 |
| flow:fcee3a892487e3206 | 0 |
| flow:fd8404bb9633d5631 | 0 |
| flow:fe112d2ad387834db | 0 |
| flow:fecffe2687f7928ba | 0 |
| flow:ff0a1a4ae1003aed1 | 1 |
| flow:ff8106728ab056c4b | 0 |

Every ref counted here was minted by a delegated child seat, because root spend is not in telemetry. Minting works and is authorized per `verify` call shape, so a zero here after children ran the gate means the shape was refused (the `F9` authorization boundary) rather than that validation was deduplicated.

## Guide reads and rendered size (the W8 target)

The `subagent` tool description and the child prompts now carry what used to require a guide read, so this counts root-session `read` requests whose path ends in `subagent_orchestration.md` or the retired `SUBAGENTS_GUIDE.md`, and prices the rendered guide itself with the same chars / 4 estimator. Child-session reads are excluded, just as flow-report reads are above.

| window | guide reads | reads per delegating root |
| --- | ---: | ---: |
| before cutoff | 116 | 1.22 |
| at or after cutoff | 1 | 0.50 |
| all | 117 | 1.23 |
| rendered guide (est. tokens) | 5819 | - |

Rendered guide source `agents/subagent_orchestration.md` at 23277 chars; the size reads `-` when that file is absent from the agent dir, which is a missing artifact rather than a cost of zero.
