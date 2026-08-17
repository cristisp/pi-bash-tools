# Bash Tools

## Fallow

`npm run fallow` runs Fallow's default human-readable analysis.

Before committing AI-generated changes, run `npm run fallow:audit`.

The audit compares the current changes with a Git base branch.

If Fallow cannot detect the base branch, pass one explicitly with `npm run fallow -- audit --base <ref> --format json --quiet`.

Use `npm run fallow:dead-code` to check for unused files, exports, dependencies, unresolved imports, and related dead-code issues.

Use `npm run fallow:dupes` to check for duplicated code.

Use `npm run fallow:health` to check complexity, maintainability, hotspots, and other code-health metrics.

Use `npm run fallow:list:entry-points` to inspect the files Fallow treats as entry points.

Use `npm run fallow:list:boundaries` to inspect configured architectural boundaries and rules.

The Fallow scripts emit quiet JSON so their output can be consumed by automation or reviewed without human-readable progress output.

Use `npm run fallow -- <command> <options>` for one-off Fallow commands that do not have a dedicated script.

## Source and tests

Production source files belong in `src/`.

Keep source-specific tests next to their source file using the `*.test.ts` suffix.

Keep broader cross-cutting or integration tests in `test/`.

## Pi tool boundaries

Pi already provides `read`, `write`, `edit`, `grep`, `find`, `ls`, and `bash`.

Do not implement duplicate tools or register replacements for those built-ins by default.

Use pi's current context and path handling instead of adding a redundant working-directory tool.
