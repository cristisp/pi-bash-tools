import { expect, it } from "vitest";
import { createGitDiffTool } from "../../../src/tools/git/diff/tool.ts";
import type { GitExec } from "../../../src/tools/git/execution.ts";
import type { GitToolContext } from "../../../src/tools/git/tool.ts";

const cwd = process.cwd();
const context: GitToolContext = { cwd, signal: undefined };
const result = (stdout = "", stderr = "", code = 0) => ({ stdout, stderr, code, killed: false });

function successfulExec(stdout = ""): { exec: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GitExec = async (_command, args) => {
    calls.push([...args]);
    return args[3] === "rev-parse" ? result(`${cwd}\n`) : result(stdout);
  };
  return { exec, calls };
}

it("supports staged diffs and paths containing spaces", async () => {
  const { exec, calls } = successfulExec("diff --git a/file name.txt b/file name.txt\n");
  const response = await createGitDiffTool(exec).execute(
    "1",
    { staged: true, paths: ["src", "README.md"], maxBytes: 1024 },
    undefined,
    undefined,
    context,
  );
  expect(calls[1]).toEqual([
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--cached",
    "--",
    "src",
    "README.md",
  ]);
  expect(response.details.patch).toContain("file name.txt");
  expect(response.details.output).toEqual({
    truncated: false,
    totalBytes: Buffer.byteLength("diff --git a/file name.txt b/file name.txt\n"),
    totalLines: 1,
  });
});

it("exposes strict, mutually exclusive path schema variants", () => {
  type SchemaVariant = {
    readonly additionalProperties?: boolean;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
  const schema = createGitDiffTool(successfulExec().exec).parameters as {
    readonly anyOf?: readonly SchemaVariant[];
  };
  const variants = schema.anyOf ?? [];

  expect(variants).toHaveLength(3);
  expect(variants.every((variant) => variant.additionalProperties === false)).toBe(true);
  expect(variants.map((variant) => Object.keys(variant.properties ?? {}).sort())).toEqual([
    ["maxBytes", "staged"],
    ["maxBytes", "path", "staged"],
    ["maxBytes", "paths", "staged"],
  ]);
  expect(variants.map((variant) => [...(variant.required ?? [])].sort())).toEqual([
    ["maxBytes"],
    ["maxBytes", "path"],
    ["maxBytes", "paths"],
  ]);

  const pathsVariant = variants[2];
  expect(pathsVariant?.properties?.paths).toMatchObject({
    type: "array",
    items: { type: "string" },
    description: expect.stringMatching(/paths: \["file"\]/u),
  });
  expect(
    variants.some((variant) =>
      ["maxBytes", "path", "paths", "staged"].every((key) =>
        Object.hasOwn(variant.properties ?? {}, key),
      ),
    ),
  ).toBe(false);
});

it("supports omitted, single, and multiple path filters", async () => {
  const wholeRepository = successfulExec();
  await createGitDiffTool(wholeRepository.exec).execute(
    "whole",
    { maxBytes: 1024 },
    undefined,
    undefined,
    context,
  );
  expect(wholeRepository.calls[1].slice(-1)).toEqual(["--"]);

  const onePath = successfulExec();
  await createGitDiffTool(onePath.exec).execute(
    "one",
    { paths: ["src"], maxBytes: 1024 },
    undefined,
    undefined,
    context,
  );
  expect(onePath.calls[1].slice(-2)).toEqual(["--", "src"]);

  const multiplePaths = successfulExec();
  await createGitDiffTool(multiplePaths.exec).execute(
    "multiple",
    { paths: ["src", "README.md"], maxBytes: 1024 },
    undefined,
    undefined,
    context,
  );
  expect(multiplePaths.calls[1].slice(-3)).toEqual(["--", "src", "README.md"]);
});

it("preserves legacy single-path execution compatibility", async () => {
  const { exec, calls } = successfulExec("legacy diff\n");
  const response = await createGitDiffTool(exec).execute(
    "legacy",
    { path: "src", staged: true, maxBytes: 1024 },
    undefined,
    undefined,
    context,
  );

  expect(calls[1]).toEqual([
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--cached",
    "--",
    "src",
  ]);
  expect(response.details.patch).toBe("legacy diff\n");
});

it("bounds output", async () => {
  const long = successfulExec("0123456789abcdef");
  const response = await createGitDiffTool(long.exec).execute(
    "1",
    { maxBytes: 5 },
    undefined,
    undefined,
    context,
  );
  expect(response.details.patch).toBe("01234");
  expect(response.details.output).toEqual({ truncated: true, totalBytes: 16, totalLines: 1 });
});

it("returns empty and binary-safe representations", async () => {
  const empty = successfulExec("");
  const emptyResponse = await createGitDiffTool(empty.exec).execute(
    "1",
    { maxBytes: 100 },
    undefined,
    undefined,
    context,
  );
  expect(emptyResponse.details).toEqual({
    patch: "",
    output: { truncated: false, totalBytes: 0, totalLines: 0 },
  });

  const binary = successfulExec("Binary files a/x and b/x differ\n");
  const binaryResponse = await createGitDiffTool(binary.exec).execute(
    "1",
    { maxBytes: 100 },
    undefined,
    undefined,
    context,
  );
  expect(binaryResponse.details.patch).toContain("Binary files");
});
