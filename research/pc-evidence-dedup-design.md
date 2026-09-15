# pc_ evidence record deduplication design (design only, not implemented)

Status: design for PLAN.md "P1: Simplify evidence infrastructure" Batch 3 item 2.
No src changes are proposed in this document; it is the coordination contract for a
follow-up implementation batch.

## Current duplication (verified against source)

The `pc_` record type (`src/tools/project-command/evidence.ts:32-57`) carries three
encodings of the same truth:

1. Producer identity, twice:
   - top-level `producerScope` / `flowId` / `producerRole` / `producerDelegationId`
     (`evidence.ts:51-54`), written in `createProjectCommandEvidenceRecord`
     (`evidence.ts:137-142`);
   - the `provenance` object (`ProjectCommandEvidenceProvenance`, `evidence.ts:15-23`)
     with `scope` / `flowId` / `producerInvocationId` / `producerSessionId` /
     `producerRole` / `producerDelegationId`, written by the producer
     (`runner.ts:1074-1090` always passes `provenance`).
2. Repository state, twice:
   - top-level raw `repositoryState` (`repositoryIdentity` / `head` /
     `dirtyFilesDigest`), kept model-facing (`runner.ts:1059-1066`,
     `runner.ts:1755-1763` copy it into `details.repositoryState` and
     `details.recordedRepositoryState`, and `runner.ts:1738` compares it for
     `repositoryStateStatus`);
   - the envelope `workspace` block (`repositoryId` digest / `head` / `dirtyDigest` /
     `status`), derived at `evidence.ts:129-131` via `sharedWorkspaceBlock`. No pc
     reader consumes it: the only `workspace` consumer in the package is
     `filesystem/read-evidence-lookup.ts:126-128`, which reads `rr_` records.
3. Scope, twice: the envelope `scope` field (`evidence.ts:122`,
   `mapEvidenceScope(options.producerScope)`) duplicates `provenance.scope` after the
   root-to-session mapping.

Validation mirrors the duplication:
`evidence/record-validation.ts:219-233` (`isEvidenceRecordProducer`) validates the
four top-level duplicates, `isEvidenceRecordEnvelopeFields` (line 221) validates the
`workspace` block, and `isEvidenceRecordScope` (lines 235-244) ties `provenance`
to the flow scope key.

Writers that re-establish both encodings:
`evidence/store.ts:62-79` (`createPublishedEvidenceRecord`) sets `producerScope:
"flow"`, `flowId`, `provenance`, and `publication` on the published record; a
published legacy record therefore keeps both encodings too.

Readers of the top-level duplicates inside the package:
`runner.ts:1738-1757` (`executeEvidenceLookup`) rebuilds a provenance object from
`record.producerScope` / `flowId` / `producerRole` / `producerDelegationId` only when
`record.provenance` is absent.

## Analyzer-consumed surface (coordination evidence)

The analyzer consumes tool-result details (session entries) and
`project-command-invocation` records, not durable `pc_` disk records.
`research/findings-1409.md:756-772` documents the field-level mismatches: the
analyzer expects `repositoryStateStatus`, which does not exist on
`project-command-invocation` (the emitted fields are
`repositoryState.stateMatchesCurrent` and `repositoryState.readable`), and expects
`policySource` on `authorization-outcome`, which is emitted as `decisionSource`
(`docs/artifacts.md:201`). Those mismatches live on invocation and authorization
records, not on the `pc_` record: the duplicated top-level evidence fields and the
`workspace` block are not read by the analyzer today. The known mismatch is therefore
out of scope for this design and must not be silently "fixed" here.

## Field disposition table

| Record field                                                       | Disposition     | Canonical carrier                                    | Rationale                                                                                          |
| ------------------------------------------------------------------ | --------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `provenance` (all six fields)                                      | Keep            | itself                                               | Complete producer identity, always written by the producer                                         |
| top-level `producerScope`                                          | Drop            | `provenance.scope`                                   | Duplicate                                                                                          |
| top-level `flowId`                                                 | Drop            | `provenance.flowId`                                  | Duplicate                                                                                          |
| top-level `producerRole`                                           | Drop            | `provenance.producerRole`                            | Duplicate                                                                                          |
| top-level `producerDelegationId`                                   | Drop            | `provenance.producerDelegationId`                    | Duplicate                                                                                          |
| top-level `repositoryState`                                        | Keep            | itself                                               | Model-facing details need the raw `repositoryIdentity`; digests are lossy for the state comparison |
| envelope `workspace` block                                         | Drop            | derived from `repositoryState` on demand             | Digest-only duplicate with zero pc readers                                                         |
| envelope `scope`                                                   | Drop            | derived from `provenance.scope` at consumers         | Duplicate                                                                                          |
| envelope `requestHash` / `contentHash`                             | Keep            | themselves                                           | Envelope identity                                                                                  |
| `evidenceFormatVersion`                                            | Bump `1` -> `2` | constant in `evidence.ts` and `record-validation.ts` | Shape change marker                                                                                |
| `key` / `ref` / `details` / `covers` / `createdAt` / `publication` | Keep            | themselves                                           | Identity and model-facing surface                                                                  |

## Format-version mechanics

- `PROJECT_COMMAND_EVIDENCE_FORMAT_VERSION` becomes `2` in
  `src/tools/project-command/evidence.ts` and
  `src/tools/project-command/evidence/record-validation.ts` (both must move together;
  they are currently duplicated constants, a pre-existing hazard worth collapsing in
  the same change).
- Strict v2 validation: `isEvidenceRecord` requires
  `evidenceFormatVersion === 2`, requires `provenance` to be present and valid, and
  stops checking `producerScope` / `flowId` / `producerRole` /
  `producerDelegationId`, `workspace`, and envelope `scope` (the fields are simply
  absent from the type).
- Tolerant read: `getByRef` accepts a v1 record by normalizing it in memory to the v2
  view (top-level identity fields mapped into `provenance` when `provenance` is
  absent; `workspace` ignored). Normalization is never persisted, mirroring the
  tolerant read added for `vr_` records in `src/tools/verify/cache/validation.ts`
  (legacy alias read, current-only write).
- Fail-closed semantics: v1 records that lack both `provenance` and all top-level
  identity fields, or whose normalization does not produce a valid `provenance`,
  miss. Corrupt records miss unchanged. Publish of a legacy source normalizes first
  and writes a strict v2 record; if normalization fails, publish fails with its
  existing fail-closed `false` return and unchanged wording
  ("Evidence publication was not available from the producer scope.").
- Disk key layout is unchanged: pc records are already written once, keyed by their
  ref (`evidence/flow-store.ts` `writeFlowRecord`), so the same ref location is
  reused across the version bump and an old record is overwritten on the next
  identical request (the ref is content-derived, so an unchanged command result
  regenerates the same ref and heals its own entry).

## In-package reader changes

- `runner.ts:1738-1757`: the provenance fallback branch reads `record.provenance`
  directly; for v2 records it is always present, so the fallback survives only as
  the tolerant v1 read path inside the store/validator layer, not in the runner.
- `evidence/store.ts:62-79`: `createPublishedEvidenceRecord` sets only `provenance`
  and `publication` (plus `details.publication`); no top-level identity rewrite.
- `runner.ts` `storeEvidence` (lines 1074-1090): stops passing
  `producerScope` / `flowId` / `producerRole` / `producerDelegationId` as top-level
  options; keeps the single `provenance` object.
- `evidence.ts:118-142`: `createProjectCommandEvidenceRecord` keeps `provenance` and
  `publication`, drops the top-level identity options, the `workspace` block, and
  the envelope `scope` mapping.

## Analyzer coordination contract

1. Before implementation: the analyzer owner confirms with one read that no analyzer
   path consumes pc-record-level `producerScope` / `flowId` / `producerRole` /
   `producerDelegationId`, `workspace`, or envelope `scope` (bash-tools evidence:
   `research/findings-1409.md:756-772` shows the analyzer's data map keys off
   invocation records and tool results).
2. The analyzer makes no change for this dedup: dropping the duplicated fields
   removes nothing it reads, and the model-facing `details` shape is untouched, so
   session-entry payloads are byte-compatible.
3. The `policySource` / `decisionSource` and `repositoryStateStatus` /
   `stateMatchesCurrent` mismatches stay on the analyzer's own backlog; they are
   invocation-record and authorization-record concerns and this design neither fixes
   nor worsens them.
4. If the analyzer later wants the record-level provenance, it reads
   `provenance` as the single source after the version bump; no field re-introduction.

## Migration and rollout order

1. Add the v2 validator with tolerant v1 read plus tests: strict v2 record round
   trip; v1 fixture (top-level fields, no `provenance`) resolves via `getByRef`
   normalized and is rejected for direct `set` without normalization; a corrupt or
   unnormalizable record misses fail-closed.
2. Switch the producer (`runner.ts` `storeEvidence`) and
   `createProjectCommandEvidenceRecord` to the canonical-only shape; the same-run
   overwrite heals old entries at the same ref location.
3. Switch `evidence/store.ts` publication to provenance-only.
4. Simplify the runner's lookup provenance construction and remove
   `isEvidenceRecordProducer`.
5. Update `docs/artifacts.md` ("Producers keep their own record version fields") to
   `evidenceFormatVersion: 2` and drop any wording that pins the removed fields.
6. Run the full gate: format, lint, tests, fallow dead-code (the removed validator
   and fields must not leave dead code), fallow audit against base HEAD.

## Expected impact

Roughly 150-250 bytes per persisted record (four identity strings plus the
`workspace` digest block and envelope `scope`) and, more importantly, one writer
path, one validator path, and one identity truth per record. No request-shape change
(`schema/validation.ts` touches only `ref` / `flowId` / `publish` / `covers` request
fields, lines 190-360), no model-facing change, no disk-key change.
