# `dirtyFilesDigest` control: which tree changes does the key observe?

**Withdrawn as a defect.** `F8` was filed against `@ztc/bash-tools` as a P1 and it is wrong. The producer's key
behaves as documented. What the probe actually measured was an ignored path, and the record is kept in full because
the error is easy to repeat: a file can be edited all day, be visible in the editor and in the working tree, and not
be in the dirty path set at all.

Measured on this workspace (`/Users/cristian.spissack/work/git/pi-extensions/subagent-herdr`), head
`88a6ac46887f41f2f800bb1e1fffdc7b0474932d`, installed `@ztc/bash-tools` 0.11.4, one pi seat. Each row is one `verify`
mint reading `repositoryState.dirtyFilesDigest`.

| # | file edited | git state | change | `dirtyFilesDigest` |
| --- | --- | --- | --- | --- |
| 1 | `PLAN.md` | **ignored** by `.gitignore` | content, size | `4feea8e8...` unchanged |
| 2 | nothing at all | - | control for read noise | `4feea8e8...` unchanged |
| 3 | `PLAN.md` | **ignored** | content | `4feea8e8...` unchanged |
| 4 | created `analysis/F8_PROBE.md` | untracked | new path | `0a6b39ff...` moved |
| 5 | `analysis/F8_PROBE.md` | untracked | content and size | `7efdd549...` moved |
| 6 | `PLAN.md` | **ignored** | content | `7efdd549...` unchanged |
| 7 | `analysis/F8_PROBE.md` | untracked | one hex character, byte count fixed | `b9e30a7d...` moved |
| 8 | `analysis/BASH_TOOLS_FOLLOWUPS.md` | tracked, staged-added and worktree-modified | content | `12544556...` moved |
| 9 | `README.md` | **tracked, modified** | one appended sentence | `5cbe6f27...` moved from `e6545f77...` |
| 10 | `README.md` | tracked, modified | one word changed, byte count fixed | `4d0bff2e...` moved from `bed26e3b...` |
| 11 | `README.md` | tracked, modified | that word changed back to the original bytes | `bed26e3b...`, identical to the mint three steps earlier |

Row 1 to 3 and 6 were labelled "tracked-modified, content only" when they were written. They are not: `.gitignore`
lists `PLAN.md`, so it is absent from `git status` and absent from the digest's input. That single mislabel is the
whole defect, and it survived a demotion, a re-promotion and three prose audits because nobody in the chain checked
whether the file was tracked. Row 9 is the row that should have been written first, and it settles it: content in a
tracked-modified file moves the key.

## What the table shows once the label is corrected

The key reacts to writes on reported paths. A tracked-modified write moves it, both when the byte count changes (row
9) and when it does not (row 10, a one-word swap at identical length, mode, path set and status), so it is content in
the key rather than size and not merely timestamps. An untracked write moves it for the same reasons (rows 5 and 7).
Rows 1, 3 and 6 show ignored paths are not in the key at all, which is correct behaviour and worth stating in the docs
only because it is where I fell over.

Row 11 is the control that was not planned and is the most useful row here. Restoring the original bytes returned the
digest `bed26e3b...`, character-for-character the value recorded three mints earlier across unrelated edits to other
files. The key is a pure function of tree state, not a counter, not a timestamp, and not path-dependent, which is what
makes it usable as a cache key at all.

The reader is not memoised on path set, status, mode or size, since row 7 moved with none of those changed. A rewrite
also moves mtime and ctime, so row 7 is equally consistent with a key over content or over per-inode timestamps; the
producer's own source says `git hash-object` per dirty path, and row 9 is consistent with that, so this is a residual
precision rather than a live doubt. `reused: false` is not offered as evidence of a fresh read: that field attests the
phase executed, not how the state was computed.

## Reuse, measured rather than inferred

Rows 10 and 11 also close the question that `F8` was originally filed for, which is not whether the digest moves but
whether a cached verdict is served across a real edit. Both mints returned `reused: false` and executed the phase
after a tracked-modified write, and row 11 shows the pair is not noise because the digest came back identical once the
bytes were restored. So the reuse decision tracks tracked writes, and the `status: "unchanged"` with `reused: true`
observed earlier after editing `PLAN.md` was correct behaviour on an ignored file rather than a stale serve.

What is still not claimed is that `reused: false` proves how the state was computed; it attests that the phase ran. And
`F1` stands independently: there is no `force`, so a caller who wants a fresh execution of an unchanged tree cannot ask
for one.

## Four wrong turns, kept in order

First I claimed the key is content-sensitive on the strength of a mint sequence in which the tree was also gaining
files and changing staged state, which was confounded. Then I demoted the finding to unreproducible on the strength
of a repeat that was not controlled. Then I promoted it to "content-blind for tracked-modified files", the version
that reached a sibling producer as P1, and every row of that claim came from an ignored file. Then, having been told
correctly that the conclusions outran the rows, I ran the missing discriminators and still did not check whether the
file was tracked, because the label had been copied forward since the first measurement. The correction came from
`git status`, which listed every dirty path in the repository and `PLAN.md` was not among them.

The transferable rule is not "distrust digests". It is that a probe must confirm its subject is in the population
before it reports on the population, and a label written once and copied forward four times is not a measurement.

## Re-run recipe

Pick a file that `git status` lists, change one byte, mint, and expect the digest to move. Pick a file `.gitignore`
lists, and expect it not to. Anything else is a finding about the tool rather than about the tree.
