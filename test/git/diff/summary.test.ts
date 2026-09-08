import { expect, it } from "vitest";

import { parseDiffHunkHeaders } from "../../../src/tools/git/diff/summary.ts";

it("decodes quoted Git path headers and octal UTF-8 escapes", () => {
  const paths = [
    {
      encoded: String.raw`caf\303\251 \"draft\"\\notes.txt`,
      decoded: `café "draft"\\notes.txt`,
    },
    {
      encoded: String.raw`control\001.txt`,
      decoded: "control\u0001.txt",
    },
  ];
  const diff = paths
    .flatMap(({ encoded }, index) => [
      `diff --git "a/${encoded}" "b/${encoded}"`,
      `+++ "b/${encoded}"`,
      `@@ -${index + 1} +${index + 1} @@`,
    ])
    .join("\n");

  expect(parseDiffHunkHeaders(diff)).toEqual(
    paths.map(({ decoded }, index) => ({
      path: decoded,
      header: `@@ -${index + 1} +${index + 1} @@`,
    })),
  );
});

it("keeps normal paths when a deleted file uses /dev/null", () => {
  expect(
    parseDiffHunkHeaders(
      [
        "diff --git a/deleted.txt b/deleted.txt",
        "--- a/deleted.txt",
        "+++ /dev/null",
        "@@ -1 +0 @@",
      ].join("\n"),
    ),
  ).toEqual([{ path: "deleted.txt", header: "@@ -1 +0 @@" }]);
});
