import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  normalizeNodeTestParameters,
  PROJECT_COMMAND_MAX_FORWARDED_ARGUMENT_BYTES,
  PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
  PROJECT_COMMAND_MAX_PATH_LENGTH,
  validateNodeTestPaths,
  validateProjectCommandRevision,
  validateWorkspacePathParameter,
} from "../../src/tools/project-command/parameters.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("project command parameters", () => {
  it("accepts omitted and empty test paths and rejects unsafe path forms", () => {
    expect(validateNodeTestPaths(undefined)).toEqual([]);
    expect(validateNodeTestPaths([])).toEqual([]);
    for (const value of [
      "",
      "-test.ts",
      "../test.ts",
      "src/../test.ts",
      "src/./test.ts",
      "src\\test.ts",
      "src/*.ts",
      "/tmp/test.ts",
      "C:/tmp/test.ts",
      "test\n.ts",
      "test\u2028.ts",
      "test\u2029.ts",
    ]) {
      expect(() => validateWorkspacePathParameter(value)).toThrow();
    }
    expect(() => validateNodeTestPaths(["src/test.ts", "src/test.ts"])).toThrow();
  });

  it("bounds path values and forwarded arguments", () => {
    expect(() =>
      validateWorkspacePathParameter("a".repeat(PROJECT_COMMAND_MAX_PATH_LENGTH + 1)),
    ).toThrow();
    expect(
      validateWorkspacePathParameter("a".repeat(PROJECT_COMMAND_MAX_PATH_LENGTH)),
    ).toHaveLength(PROJECT_COMMAND_MAX_PATH_LENGTH);

    const paths = Array.from(
      { length: PROJECT_COMMAND_MAX_PARAMETER_ITEMS },
      (_, index) => `${index}-${"a".repeat(2035)}`,
    );
    expect(() => validateNodeTestPaths(paths)).toThrow();
    expect(PROJECT_COMMAND_MAX_FORWARDED_ARGUMENT_BYTES).toBeGreaterThan(0);
  });

  it("rejects C1 controls and line separators in project command text at runtime", () => {
    for (const character of ["\u0080", "\u009b", "\u009f", "\u2028", "\u2029"]) {
      expect(() => validateWorkspacePathParameter(`safe${character}.ts`)).toThrow();
      expect(() => validateProjectCommandRevision(`HEAD${character}`)).toThrow();
    }
  });

  it("validates safe Fallow audit revisions", () => {
    for (const revision of [
      "H",
      "HEAD",
      "HEAD~1",
      "HEAD^{commit}",
      "origin/main",
      "refs/heads/main@{upstream}",
      "v1.2.3-rc+1",
      "feature/name",
    ] as const) {
      expect(validateProjectCommandRevision(revision)).toBe(revision);
    }
    for (const revision of [
      undefined,
      null,
      42,
      "",
      "-",
      "--help",
      "HEAD--parent",
      "HEAD:secret",
      "HEAD main",
      "HEAD\tmain",
      "HEAD*",
      "HEAD?",
      "HEAD[0]",
      "HEAD\\n",
      "HEAD!",
      "HEAD\u2028main",
      "HEAD\u2029main",
    ]) {
      expect(() => validateProjectCommandRevision(revision)).toThrow();
    }
  });

  it("accepts workspace-relative path boundaries and rejects every unsafe form", () => {
    expect(validateWorkspacePathParameter("test.ts")).toBe("test.ts");
    expect(validateWorkspacePathParameter("packages/tool/test.spec.ts")).toBe(
      "packages/tool/test.spec.ts",
    );
    expect(validateNodeTestPaths(["test.ts", "packages/tool/test.spec.ts"])).toEqual([
      "test.ts",
      "packages/tool/test.spec.ts",
    ]);

    for (const value of [
      undefined,
      null,
      42,
      "",
      "-test.ts",
      "../test.ts",
      "src/../test.ts",
      "src/./test.ts",
      "src//test.ts",
      "src/test.ts/",
      "src\\test.ts",
      "src/*.ts",
      "src/{unit}.ts",
      "/tmp/test.ts",
      "C:/tmp/test.ts",
      "test\u0000.ts",
      "test\u007f.ts",
    ]) {
      expect(() => validateWorkspacePathParameter(value)).toThrow();
    }
    expect(() =>
      validateNodeTestPaths(Array(PROJECT_COMMAND_MAX_PARAMETER_ITEMS + 1).fill("test.ts")),
    ).toThrow();
  });

  it("normalizes existing paths and rejects symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-tools-parameters-"));
    directories.push(root);
    const canonical = await realpath(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "test.ts"), "test");
    expect(await normalizeNodeTestParameters(["src/test.ts"], canonical)).toEqual({
      paths: ["src/test.ts"],
    });

    const outside = await mkdtemp(join(tmpdir(), "bash-tools-parameters-outside-"));
    directories.push(outside);
    await writeFile(join(outside, "secret.ts"), "secret");
    await symlink(join(outside, "secret.ts"), join(root, "escape.ts"));
    await expect(normalizeNodeTestParameters(["escape.ts"], canonical)).rejects.toMatchObject({
      stage: "probe",
      code: "test-path-outside-workspace",
    });
  });
});
