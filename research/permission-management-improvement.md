# Permission management improvement discussion

Status: discussion only, no implementation yet.

## Problem statement

The policy file at `getAgentDir()/bash-tools.json` is optimized for agents and for fail-closed validation, but it is hard for a human to manage.

Three pain points came out of a review session:

1. When a confirmation times out or an explicit deny rule is recorded, undoing the persisted decision requires hand-editing a JSON file full of fingerprints and canonical absolute paths.
2. Filesystem path permissions ignore the workspace root. Rules require full absolute qualification, so `coverage/` cannot be expressed and the project prefix must be repeated in every entry.
3. Project-command rules store only `commandId` plus a SHA-256 fingerprint, so a human cannot tell which command a rule actually authorizes.

The desired outcome is relative path support, readable command identification, and a small interactive TUI for viewing and editing global and active-workspace rules per category.

## Current implementation, for reference

The policy document is version 4 with three namespaces: `environment`, `projectCommands`, and `filesystem`.

Each namespace has a `global` scope plus a `projects` map keyed by canonical absolute project path.

The filesystem namespace has separate allow and deny lists per access kind: `allowRead`, `allowWrite`, `denyRead`, `denyWrite`, `allowMove`, `denyMove`, `allowDelete`, and `denyDelete`.

Precedence is global deny, project deny, global allow, project allow, and unknown.

Relevant source locations:

- Document shape and validation: `src/tools/policy/types.ts`, `src/tools/policy/format/`.
- Path validation: `validatePolicyPathInternal` in `src/tools/policy/format/validation.ts` rejects anything that is not a normalized absolute path, with no wildcards, no control characters, and no trailing separator.
- Decision logic: `src/tools/policy/decisions.ts`. Allow matching uses `isPathWithin(entry, path)`, deny matching uses overlap detection.
- Persistence: `src/tools/policy/storage.ts`. Writes use an exclusive lock with a five second timeout, a 0600 temporary file, and an atomic rename. Parsing is strict: unknown keys, duplicates, same-scope allow and deny conflicts, and invalid versions are rejected.
- Command identity fingerprint: `src/tools/project-command/definitions.ts`. The fingerprint is a SHA-256 over namespace, semantic command id, resolved executable, fingerprint args, and catalog metadata.
- Result fingerprint (cache reuse): `src/tools/project-command/fingerprint.ts`. This hashes the logical request plus a workspace state digest and a relevant-inputs manifest.
- Interactive confirmation: `src/tools/confirmation-prompt.ts` with a default timeout of 120 seconds from `confirmationTimeoutMs`.

A clarification on timeouts: a confirmation timeout denies the request fail-closed but does not persist anything. Only explicit selections such as "Deny for this project" are written. The cleanup pain is therefore about undoing persisted choices, not timeout artifacts, and the fix is to make removal easy rather than to change timeout semantics.

## Improvement 1: relative path permissions

Filesystem rules should support project-relative paths in project-scoped rules, resolved against the workspace root at decision time.

This is unambiguous because project scopes are already keyed by the absolute workspace root, so "relative to what" has a single answer: `loaded.projectPath`.

### Design decisions to settle

- Scope restriction: allow relative paths only inside `projects.*` scopes. A relative path in a `global` scope is meaningless at best and dangerous at worst, so the parser should reject it.
- Strictness: apply the same rules as absolute paths today. Normalized, no `..` traversal, no wildcards, no control characters, and a pinned decision on whether a leading `./` or a root-relative empty path is accepted.
- Symmetry: the tools resolve real paths before consulting policy. Resolving stored relative entries against the same project root at match time keeps allow and deny matching symmetric and prevents bypass through differently-resolved paths.
- Move and delete pairs: these carry a source and a destination. Relative-to-root for both is the obvious rule, but it should be pinned down explicitly.
- Storage choice: store the path relative in project scope. This is portable across clones and repository moves, which is arguably a feature, and it is much more human-manageable. The alternative of canonicalizing to absolute at write time loses both benefits.
- Migration: the strict parser means this is a document shape change. Either bump to version 5, or accept both forms in version 4 project scopes and emit whatever was written. A version bump with migration on save matches the existing version 1 to 2 to 4 pattern.

### Existing behavior note

Read and write access inside the workspace root is already implicitly allowed: `findFilesystemPolicyDecision` falls back to `allow-project` for read and write within `projectPath`. The real use cases for relative rules are therefore deny rules inside the project (for example denying writes to `.env` or `secrets/`) and explicit allows for paths that need grants. UI copy and documentation should avoid suggesting redundant in-project allow rules.

## Improvement 2: showing the command behind a project-command fingerprint

There are two distinct fingerprints and they should not be conflated.

The identity fingerprint is the authorization artifact. It is persisted in `projectCommands` entries and shown in tool output metadata. It is a deterministic recomputation from the current command definitions, so it can be resolved back to a readable command at display time.

The result fingerprint is cache key material. It encodes the logical request plus the workspace state snapshot, so it legitimately cannot be replaced by a readable command. It should stay opaque but could be labeled more clearly in output, for example as a cache fingerprint.

### Options for readable commands

- Enrich the persisted entry with a bounded display field such as the resolved argv. The strict two-property schema makes this a schema change via a version bump or an allowlisted field. Bounded, definition-derived data in the user's own policy file is acceptable, but it grows the file and duplicates state that is recomputable.
- Resolve at display time, which is the preferred option. A UI or an authorization prompt maps `commandId` plus fingerprint back to the resolved command line for every known definition. Entries whose fingerprint no longer matches any current definition render as stale. This requires no schema change, avoids duplicated data, and staleness detection falls out for free because stale rules are dead weight and good cleanup candidates.
- For tool output, adding the resolved command as additive metadata next to the fingerprint is compatible with the bounded-output rules as long as the value is length-capped and contains the resolved argv rather than raw user input.

## Improvement 3: TUI management UI

The pi extension API supports this directly: `pi.registerCommand("permissions", ...)` plus `ctx.ui.select`, `ctx.ui.confirm`, and `ctx.ui.input` for simple flows, and `ctx.ui.custom()` for a full custom component with keyboard input. The handler must be guarded on `ctx.mode === "tui"` or `ctx.hasUI` because print and JSON modes have no UI.

The proposed scope is global rules plus active-workspace rules only, per category. This keeps the surface bounded, avoids the UI becoming a browser over every project that ever touched the machine, and matches day-to-day management needs.

### Sketch

- `/permissions` shows a category list: environment, project commands, and filesystem.
- Each category shows global rules and `ctx.cwd`-scoped rules.
- Project-command entries render with resolved commands and flag stale fingerprints.
- Per rule: remove. Per category: add. Environment variables and paths are entered via input; commands are picked from current known definitions.
- Non-TUI fallback: print a pointer to the file and the rule path, or nothing. Management is a user-initiated convenience, not an authorization path, so failing soft is acceptable.

### Hard constraint

The UI must never edit the file directly. All mutations go through the same policy store path: lock, atomic write, strict validation.

Today the store only has add-decision operations (`apply*PolicyDecision`). A removal capability is needed, and it is the same primitive that the undo-a-deny workflow needs, so it is the core enabler for everything in this document.

### Open questions

- Whether the UI snapshots on open with an explicit refresh action, or polls. Snapshot on open is simpler and avoids surprising live mutation under the cursor.
- The store lock already handles concurrency with a parallel agent session recording decisions, so coexistence is safe.
- Whether the interactive authorization prompt should also offer a manage affordance. Keep it simple initially.

Fail-closed rules remain intact throughout: the UI reads via the same secure-open path, writes fail like any other policy write, and an invalid UI state produces a policy error rather than a silent mutation.

## Suggested sequencing

1. Removal support in the policy store. Foundational for manual cleanup and the UI alike.
2. Relative project-scope paths. Schema bump plus resolution at match time.
3. Display-time fingerprint resolution plus resolved command in tool output. No schema change.
4. The `/permissions` TUI on top of the previous three.

Nothing has been implemented. The next step is to firm up the open decisions above, in particular the exact relative-path validation rules and the version 5 document shape, before committing to a plan.
