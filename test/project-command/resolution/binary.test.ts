import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveProjectBinary } from "../../../src/tools/project-command/resolution.ts";
import { createBinaryProject, createResolutionTestScope } from "./test-fixtures.ts";

const scope = createResolutionTestScope();

afterEach(scope.cleanup);

describe("project binary paths", () => {
  it("resolves a regular binary and an in-root symlink to its realpath", async () => {
    const { directory, nodeModules, binDirectory } = await createBinaryProject(scope);
    const packageBinary = join(nodeModules, "package", "bin", "tool");
    await mkdir(join(nodeModules, "package", "bin"), { recursive: true });
    await writeFile(packageBinary, "#!/bin/sh\nprintf tool\n");
    const direct = join(binDirectory, "direct");
    await writeFile(direct, "regular");
    expect(await resolveProjectBinary(directory, "direct")).toBe(await realpath(direct));
    const linked = join(binDirectory, "tool");
    await symlink("../package/bin/tool", linked);
    expect(await resolveProjectBinary(directory, "tool")).toBe(await realpath(packageBinary));
  });
});
