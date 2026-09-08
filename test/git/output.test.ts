import { describe, expect, it } from "vitest";

import {
  countStatusRecords,
  parseLog,
  parseStatus,
  truncateUtf8,
} from "../../src/tools/git/output.ts";

const renameStatus = "R  new name.txt\0old name.txt\0?? untracked file.txt\0";

describe("Git output helpers", () => {
  it("parses porcelain status including renamed paths and spaces", () => {
    expect(countStatusRecords(renameStatus)).toBe(2);
    expect(parseStatus(renameStatus)).toEqual([
      {
        path: "new name.txt",
        indexStatus: "R",
        worktreeStatus: " ",
        renamedFrom: "old name.txt",
      },
      { path: "untracked file.txt", indexStatus: "?", worktreeStatus: "?" },
    ]);
  });

  it("parses NUL-delimited log entries", () => {
    expect(
      parseLog(
        "a\0Alice\x002024-01-01T00:00:00Z\0subject\0b\0Bob\x002024-01-02T00:00:00Z\0second\0",
      ),
    ).toEqual([
      { id: "a", author: "Alice", date: "2024-01-01T00:00:00Z", subject: "subject" },
      { id: "b", author: "Bob", date: "2024-01-02T00:00:00Z", subject: "second" },
    ]);
  });

  it("handles Git's implicit newline record terminators", () => {
    expect(
      parseLog(
        "a\0Alice\x002024-01-01T00:00:00Z\0subject\0\nb\0Bob\x002024-01-02T00:00:00Z\0second\0\n",
      ),
    ).toEqual([
      { id: "a", author: "Alice", date: "2024-01-01T00:00:00Z", subject: "subject" },
      { id: "b", author: "Bob", date: "2024-01-02T00:00:00Z", subject: "second" },
    ]);
  });

  it("truncates by UTF-8 bytes without splitting a character", () => {
    const result = truncateUtf8("a😀b", 3);
    expect(result.text).toBe("a");
    expect(result.output).toEqual({ truncated: true, totalBytes: 6, totalLines: 1 });
  });
});
