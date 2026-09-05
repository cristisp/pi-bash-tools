import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectBinary } from "../../../src/tools/project-command/resolution.ts";
import {
  createBinaryProject,
  createProjectDirectory,
  createResolutionTestScope,
  expectResolutionError,
} from "./test-fixtures.ts";

const scope = createResolutionTestScope();

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
});
