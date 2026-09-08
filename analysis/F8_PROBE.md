# F8 digest boundary

F8 is withdrawn as a producer defect.
The original probe mislabelled ignored `PLAN.md` as a tracked dirty path.
The surviving discovery is that ignored paths are excluded from `dirtyFilesDigest`.

`dirtyFilesDigest` fingerprints paths reported by Git, including their content, mode, size, and status.
It is a fingerprint of the reported repository state, not of every visible file in the working directory.

## Relevant observations

| observation | path | Git state | result |
| --- | --- | --- | --- |
| ignored edit | `PLAN.md` | excluded by `.gitignore` | digest unchanged |
| content edit | `README.md` | tracked, modified | digest moved |
| same-size content edit | `README.md` | tracked, modified | digest moved |
| restore original bytes | `README.md` | tracked, modified | earlier digest returned |
| content edit | untracked probe file | reported by Git | digest moved |

The digest therefore reacts to content changes on reported tracked and untracked paths.
Restoring the original bytes restores the corresponding digest, which is consistent with a pure tree-state fingerprint.

## Consumer rule

A validation ref attests to the recorded repository state at mint time.
It is not a content lock.
A role that edits the tree must mint new evidence, while an edit to an ignored path is outside this fingerprint by design.

The one documentation sentence this probe leaves behind is:

> Paths excluded by `.gitignore` are not included in `dirtyFilesDigest`.
