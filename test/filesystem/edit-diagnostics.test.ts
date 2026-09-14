import { describe, expect, it } from "vitest";

import {
  diagnoseFilesystemEdits,
  type FilesystemEditInput,
} from "../../src/tools/filesystem/edit-diagnostics.ts";

describe("edit diagnostics", () => {
  it("keeps the existing diagnostic hints byte-identical", () => {
    expect(diagnoseFilesystemEdits("target", [{ oldText: "", newText: "new" }])?.hint).toBe(
      "Provide non-empty oldText for the replacement.",
    );
    expect(diagnoseFilesystemEdits("file\n", [{ oldText: "missing", newText: "new" }])?.hint).toBe(
      "Provide a larger unique context that matches the file exactly.",
    );
    expect(
      diagnoseFilesystemEdits("target\n", [{ oldText: " target", newText: "new" }])?.hint,
    ).toBe(
      "The text differs only in whitespace; preserve indentation, line endings, and trailing spaces.",
    );
    expect(
      diagnoseFilesystemEdits("same\nsame\n", [{ oldText: "same", newText: "new" }])?.hint,
    ).toBe("Provide more surrounding context so oldText matches exactly one region.");
    expect(
      diagnoseFilesystemEdits("overlap\n", [
        { oldText: "overlap", newText: "new" },
        { oldText: "erlap", newText: "new2" },
      ])?.hint,
    ).toBe("Merge overlapping edits into one replacement or target disjoint regions.");
  });

  it("classifies a no-op replacement when oldText equals newText", () => {
    const diagnostic = diagnoseFilesystemEdits("target\n", [
      { oldText: "target", newText: "target" },
    ]);
    expect(diagnostic).toMatchObject({ code: "edit-no-op", editIndex: 0 });
    expect(diagnostic?.hint).toBe(
      "The replacement is a no-op because oldText and newText are identical.",
    );
  });

  it("reports the first no-op edit only after the empty-old-text check", () => {
    const diagnostic = diagnoseFilesystemEdits("target\n", [
      { oldText: "", newText: "new" },
      { oldText: "target", newText: "target" },
    ]);
    expect(diagnostic?.code).toBe("edit-empty-old-text");
    const next = diagnoseFilesystemEdits("target\n", [
      { oldText: "other", newText: "other" },
      { oldText: "target", newText: "target" },
    ]);
    expect(next).toMatchObject({ code: "edit-no-op", editIndex: 0 });
  });

  it("classifies a no-match as stale context when the observed hash differs", () => {
    const diagnostic = diagnoseFilesystemEdits(
      "current content\n",
      [{ oldText: "observed text", newText: "new" }],
      { fileFingerprint: "fingerprint-1", observedContentHash: "hash-observed" },
    );
    expect(diagnostic?.code).toBe("edit-stale-context");
    expect(diagnostic?.evidenceBacked).toBe(true);
    expect(diagnostic?.hint).toBe(
      "The file has changed since it was last observed; reread the file and rebase this edit on the current content.",
    );
  });

  it("keeps a plain no-match when the observed hash matches the current content", () => {
    const diagnostic = diagnoseFilesystemEdits(
      "current content\n",
      [{ oldText: "missing", newText: "new" }],
      { fileFingerprint: "hash-observed", observedContentHash: "hash-observed" },
    );
    expect(diagnostic?.code).toBe("edit-no-match");
    expect(diagnostic?.evidenceBacked).toBe(true);
    expect(diagnostic?.hint).toBe("Provide a larger unique context that matches the file exactly.");
  });

  it("keeps a plain no-match when no observed evidence exists", () => {
    const diagnostic = diagnoseFilesystemEdits("current content\n", [
      { oldText: "missing", newText: "new" },
    ]);
    expect(diagnostic?.code).toBe("edit-no-match");
    expect(diagnostic).not.toHaveProperty("evidenceBacked");
  });

  it("classifies stale context even when the mismatch is whitespace-only", () => {
    const diagnostic = diagnoseFilesystemEdits(
      "target\n",
      [{ oldText: " target", newText: "new" }],
      {
        fileFingerprint: "fingerprint-1",
        observedContentHash: "hash-observed",
      },
    );
    expect(diagnostic?.code).toBe("edit-stale-context");
  });

  it("attaches a bounded repair context when evidence is provided", () => {
    const diagnostic = diagnoseFilesystemEdits(
      "alpha\nbeta\n",
      [{ oldText: "missing", newText: "new" }],
      { fileFingerprint: "fingerprint-1", observedContentHash: "hash-observed" },
    );
    expect(diagnostic).toMatchObject({
      fileFingerprint: "fingerprint-1",
      contentLength: 11,
      lineCount: 3,
      nearestCandidates: [{ line: 1 }, { line: 2 }, { line: 3 }],
    });
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain("alpha");
    expect(serialized).not.toContain("beta");
  });

  it("omits fingerprint fields for callers without evidence context", () => {
    const diagnostic = diagnoseFilesystemEdits("target\n", [
      { oldText: "missing", newText: "new" },
    ]);
    expect(diagnostic).not.toHaveProperty("fileFingerprint");
    expect(diagnostic).not.toHaveProperty("contentLength");
    expect(diagnostic).not.toHaveProperty("lineCount");
    expect(diagnostic).not.toHaveProperty("evidenceBacked");
  });

  it("does not classify non-matching replacements as stale without a mismatch", () => {
    const inputs: readonly FilesystemEditInput[] = [{ oldText: "current", newText: "new" }];
    expect(
      diagnoseFilesystemEdits("current content\n", inputs, {
        fileFingerprint: "hash-observed",
        observedContentHash: "hash-observed",
      }),
    ).toBeUndefined();
  });
});
