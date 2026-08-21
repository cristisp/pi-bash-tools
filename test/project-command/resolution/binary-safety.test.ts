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

describe("project binary safety", () => {
  it("rejects a node_modules root escape and invalid names without PATH or npx lookup", async () => {
    const directory = await createProjectDirectory(scope);
    const outside = await createProjectDirectory(scope);
    await mkdir(join(outside, ".bin"), { recursive: true });
    await writeFile(join(outside, ".bin", "tool"), "outside");
    await symlink(outside, join(directory, "node_modules"));
    await expectResolutionError(
      resolveProjectBinary(directory, "tool"),
      "binary-resolution",
      "node-modules-root-escape",
    );

    const binaryProject = await createBinaryProject(scope);
    await Promise.all(
      ["", "../tool", "tool/name", "/bin/sh", "..", ".", "tool\0name"].map((name) =>
        expectResolutionError(
          resolveProjectBinary(binaryProject.directory, name),
          "binary-resolution",
          "invalid-binary-name",
        ),
      ),
    );
    await expectResolutionError(
      resolveProjectBinary(binaryProject.directory, "sh"),
      "binary-resolution",
      "missing-binary",
    );
  });
});
