# Orchestration measurement

Agent dir `/Users/cristian.spissack/.pi/agent`. Window 2026-07-13T15:15 .. 2026-09-18T12:08. 438 root sessions, 1473 child sessions, 1151 telemetry records. Report cutoff 2026-09-03T10:06.

## Delivered `subagent` result size (estimated tokens, chars / 4)

| window | n | avg | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| before cutoff | 1171 | 1514 | 1145 | 5294 | 8698 | 19559 |
| at or after cutoff | 725 | 565 | 584 | 1128 | 1523 | 2102 |
| all | 1896 | 1151 | 746 | 3655 | 7841 | 19559 |
| baseline 2026-08-26..09-02 | 285 | 1821 | 900 | - | 6099 | - |

## Report digest fidelity (telemetry turns carrying a report)

Delivered results joined to a telemetry report by report path: 5 / 258.

| role | turns | median full | median digest | digest/full | ledger | cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| worker | 117 | 1154 | 446 | 39% | 110/117 | $5.3465 |
| reviewer | 85 | 2355 | 603 | 26% | 83/85 | $3.7517 |
| validator | 44 | 785 | 320 | 41% | 40/44 | $0.4098 |
| planner | 9 | 2048 | 450 | 22% | 9/9 | $0.3543 |
| scout | 3 | 2636 | 446 | 17% | 3/3 | $0.0942 |

## Root report reads (the W3 Slice D signal)

These are root-session read requests targeting files under `flows/*/reports/*.md`; child session reads are excluded.

| window | report reads |
| --- | ---: |
| before cutoff | 0 |
| at or after cutoff | 362 |
| all | 362 |

## Root carry (the W3 target)

Carry is result tokens x the number of later assistant turns in the same root session, i.e. how often that text re-entered the model before the session ended.

| window | results | delegating roots | carry (token-times) | carry per root |
| --- | ---: | ---: | ---: | ---: |
| before cutoff | 1171 | 66 | 281,043,046 | 4,258,228 |
| at or after cutoff | 725 | 49 | 155,146,001 | 3,166,245 |
| all | 1896 | 114 | 436,157,697 | 3,825,945 |

Root sessions received 2,182,487 estimated tokens of subagent results in total.

Child sessions created since telemetry began (2026-09-03T09:14): 676, of which 416 have no telemetry record. Historic children cannot be attributed and are excluded.

Child spend recorded in telemetry: $10.0093 across 279 ordinary delegation turns.

## Composition policy events

Typed composition events: 67 (67 warnings, 0 refusals).
By rule: R1:15, R2:3, R3:6, R4:43.
By policy: warn:67.
By per-call override: warn:18, none:49.
Composition events are excluded from ordinary delegation, validation, and child-spend metrics.

## Validation evidence (the W7 target)

Per role, flow, and overall: delegations carrying a `verify` ref, refs minted, refs executed rather than reused, refs resolved by lookup, failed lookups, reuse rate, full validation passes charged, and executions per distinct repository-state digest. Deduplication means grouping records by `flowId`, counting the distinct `stateDigest` values across the refs minted in that flow, and dividing executed mints by that count, because a ratio above 1 is the duplicate execution this workstream exists to remove. When the producer invocation stream is present, its one-record-per-call execution decision refines the consumer-side telemetry; otherwise the report says only what the extension observed.

Producer invocation stream: unavailable; producer execution columns are not zero-event evidence.

| scope | delegations | delegations with refs | refs minted | refs executed | refs reused | refs by lookup | full validation passes | distinct state digests | executions per digest |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| overall | 279 | 58 | 50 | 50 | 0 | 14 | 324 | 32 | 1.56 |
| worker | 130 | 32 | 36 | 36 | 0 | 0 | 257 | 20 | 1.80 |
| reviewer | 88 | 12 | 0 | 0 | 0 | 12 | 1 | 0 | - |
| validator | 49 | 14 | 14 | 14 | 0 | 2 | 66 | 13 | 1.08 |
| planner | 9 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| scout | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |

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
| flow:f6613dc19f808aaf8 | 0 | - | 0% | 0 | 0 | 0 | 1 |
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

Read evidence refs, structured lookup outcomes, and codegraph index states:

| scope | read minted | read reused | read lookups | lookup outcomes | codegraph results | index ids |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| overall | 0 | 0 | 0 | - | 0 | 0 |
| worker | 0 | 0 | 0 | - | 0 | 0 |
| reviewer | 0 | 0 | 0 | - | 0 | 0 |
| validator | 0 | 0 | 0 | - | 0 | 0 |
| planner | 0 | 0 | 0 | - | 0 | 0 |
| scout | 0 | 0 | 0 | - | 0 | 0 |
| flow:f09091d37c4540e11 | 0 | 0 | 0 | - | 0 | 0 |
| flow:f16669aa7f2438a52 | 0 | 0 | 0 | - | 0 | 0 |
| flow:f20f50475abc7acad | 0 | 0 | 0 | - | 0 | 0 |
| flow:f24b7aa13a9fddecf | 0 | 0 | 0 | - | 0 | 0 |
| flow:f31c8fe9cb5d4dec4 | 0 | 0 | 0 | - | 0 | 0 |
| flow:f337ad2fbb0e26406 | 0 | 0 | 0 | - | 0 | 0 |
| flow:f4a7c827e86180efe | 0 | 0 | 0 | - | 0 | 0 |
| flow:f5c2642cf9a782025 | 0 | 0 | 0 | - | 0 | 0 |
| flow:f5e81af71dca45d34 | 0 | 0 | 0 | - | 0 | 0 |
| flow:f65373a6532523635 | 0 | 0 | 0 | - | 0 | 0 |
| flow:f6613dc19f808aaf8 | 0 | 0 | 0 | - | 0 | 0 |
| flow:f66830a6253edf355 | 0 | 0 | 0 | - | 0 | 0 |
| flow:f7308b0f341bb4075 | 0 | 0 | 0 | - | 0 | 0 |
| flow:f747a9848ce3654b8 | 0 | 0 | 0 | - | 0 | 0 |
| flow:f780b529fc311e206 | 0 | 0 | 0 | - | 0 | 0 |
| flow:f85f194e1b61c28e3 | 0 | 0 | 0 | - | 0 | 0 |
| flow:f87aead9c5444bde2 | 0 | 0 | 0 | - | 0 | 0 |
| flow:f925c085324674d3f | 0 | 0 | 0 | - | 0 | 0 |
| flow:fa8b7d2bc8ba5e61a | 0 | 0 | 0 | - | 0 | 0 |
| flow:fac2339cdccb79935 | 0 | 0 | 0 | - | 0 | 0 |
| flow:fada4ffe1f42949b8 | 0 | 0 | 0 | - | 0 | 0 |
| flow:fb880c07ca4f96ec0 | 0 | 0 | 0 | - | 0 | 0 |
| flow:fc5b4d20cb2c6f2e4 | 0 | 0 | 0 | - | 0 | 0 |
| flow:fc9799eb401af8d25 | 0 | 0 | 0 | - | 0 | 0 |
| flow:fcb7b5447b11b875a | 0 | 0 | 0 | - | 0 | 0 |
| flow:fcee3a892487e3206 | 0 | 0 | 0 | - | 0 | 0 |
| flow:fd8404bb9633d5631 | 0 | 0 | 0 | - | 0 | 0 |
| flow:fe112d2ad387834db | 0 | 0 | 0 | - | 0 | 0 |
| flow:fecffe2687f7928ba | 0 | 0 | 0 | - | 0 | 0 |
| flow:ff0a1a4ae1003aed1 | 0 | 0 | 0 | - | 0 | 0 |
| flow:ff8106728ab056c4b | 0 | 0 | 0 | - | 0 | 0 |

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
| flow:f6613dc19f808aaf8 | 0 |
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
| before cutoff | 80 | 1.21 |
| at or after cutoff | 63 | 1.29 |
| all | 143 | 1.25 |
| rendered guide (est. tokens) | 5459 | - |

Rendered guide source `agents/subagent_orchestration.md` at 21835 chars; the size reads `-` when that file is absent from the agent dir, which is a missing artifact rather than a cost of zero.
