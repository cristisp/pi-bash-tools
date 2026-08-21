import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
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
