import { mkdir, realpath, stat as fsStat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveProjectBinary,
  type ProjectResolutionFileSystem,
} from "../../../src/tools/project-command/resolution.ts";
import {
  createBinaryProject,
  createProjectDirectory,
  createResolutionTestScope,
  expectResolutionError,
} from "./test-fixtures.ts";

const scope = createResolutionTestScope();

function createMockBinaryFileSystem(
  stat: ProjectResolutionFileSystem["stat"],
): ProjectResolutionFileSystem {
  return {
    readFile: async () => "",
    realpath: async (path) => {
      if (path === "/project") return "/project";
      if (path === "/project/node_modules") return "/project/node_modules";
      if (path === "/project/node_modules/.bin/tool") {
        return "/project/node_modules/package/bin/tool";
      }
      return path;
    },
    stat,
    lstat: async () => {
      throw new Error("missing");
    },
  };
}

afterEach(scope.cleanup);

describe("project binary failure handling", () => {
  it("reports bounded nearest existing paths for missing binaries", async () => {
    const { directory, binDirectory } = await createBinaryProject(scope);
    const error = await resolveProjectBinary(directory, "missing").catch((value: unknown) => value);

    expect(error).toMatchObject({
      name: "ProjectCommandResolutionError",
      stage: "binary-resolution",
      code: "missing-binary",
      details: { nearestExistingPaths: expect.arrayContaining([await realpath(binDirectory)]) },
    });
  });

  it("fails closed for missing, dangling, escaping, and non-file binaries", async () => {
    const { directory, binDirectory } = await createBinaryProject(scope);
    await expectResolutionError(
      resolveProjectBinary(directory, "missing"),
      "binary-resolution",
      "missing-binary",
    );
    await symlink("../missing/tool", join(binDirectory, "dangling"));
    await expectResolutionError(
      resolveProjectBinary(directory, "dangling"),
      "binary-resolution",
      "dangling-binary",
    );

    const outside = await createProjectDirectory(scope);
    const outsideBinary = join(outside, "outside");
    await writeFile(outsideBinary, "outside");
    await symlink(outsideBinary, join(binDirectory, "escaping"));
    await expectResolutionError(
      resolveProjectBinary(directory, "escaping"),
      "binary-resolution",
      "binary-target-escape",
    );

    await mkdir(join(binDirectory, "directory"));
    await expectResolutionError(
      resolveProjectBinary(directory, "directory"),
      "binary-resolution",
      "binary-not-file",
    );
  });

  it("converts an invalid project path and cancellation-like filesystem error", async () => {
    const cancellation = Object.assign(new Error("operation cancelled"), { name: "AbortError" });
    const fileSystem: ProjectResolutionFileSystem = {
      readFile: async () => "",
      realpath: async () => {
        throw cancellation;
      },
      stat: async () => {
        throw new Error("unused");
      },
      lstat: async () => {
        throw new Error("unused");
      },
    };

    await expectResolutionError(
      resolveProjectBinary("/missing-project", "tool", fileSystem),
      "binary-resolution",
      "invalid-project-root",
    );
  });

  it("converts node_modules and target resolution filesystem failures", async () => {
    const baseFileSystem = {
      readFile: async () => "",
      stat: async () => fsStat(process.execPath),
      lstat: async () => {
        throw new Error("binary link missing");
      },
    };

    await expectResolutionError(
      resolveProjectBinary("/project", "tool", {
        ...baseFileSystem,
        realpath: async (path: string) => {
          if (path === "/project") return "/project";
          throw new Error("node_modules unavailable");
        },
      }),
      "binary-resolution",
      "missing-node-modules-root",
    );

    await expectResolutionError(
      resolveProjectBinary("/project", "tool", {
        ...baseFileSystem,
        realpath: async (path: string) => {
          if (path === "/project") return "/project";
          if (path === "/project/node_modules") return "/outside/node_modules";
          return path;
        },
      }),
      "binary-resolution",
      "node-modules-root-escape",
    );

    await expectResolutionError(
      resolveProjectBinary("/project", "tool", {
        ...baseFileSystem,
        realpath: async (path: string) => {
          if (path === "/project") return "/project";
          if (path === "/project/node_modules") return "/project/node_modules";
          throw new Error("binary target unavailable");
        },
      }),
      "binary-resolution",
      "missing-binary",
    );
  });

  it("rejects invalid binary names with a resolution error", async () => {
    const fileSystem: ProjectResolutionFileSystem = {
      readFile: async () => "",
      realpath: async (path) => path,
      stat: async () => fsStat(process.execPath),
      lstat: async () => {
        throw new Error("unused");
      },
    };

    await expectResolutionError(
      resolveProjectBinary("/project", "../tool", fileSystem),
      "binary-resolution",
      "invalid-binary-name",
    );
  });

  it("converts an invalid stat result and stat cancellation into resolution errors", async () => {
    await expectResolutionError(
      resolveProjectBinary(
        "/project",
        "tool",
        createMockBinaryFileSystem(async () => {
          throw new Error("invalid stat");
        }),
      ),
      "binary-resolution",
      "binary-stat-failed",
    );

    const cancellation = Object.assign(new Error("operation cancelled"), { name: "AbortError" });
    await expectResolutionError(
      resolveProjectBinary(
        "/project",
        "tool",
        createMockBinaryFileSystem(async () => {
          throw cancellation;
        }),
      ),
      "binary-resolution",
      "binary-stat-failed",
    );
  });
});
