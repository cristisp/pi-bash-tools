import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  detectProjectPackageManager,
  type PackageManager,
} from "../../../src/tools/project-command/resolution.ts";
import {
  createProjectDirectory,
  createResolutionTestScope,
  expectResolutionError,
} from "./test-fixtures.ts";

const scope = createResolutionTestScope();

afterEach(scope.cleanup);

describe("package manager detection options", () => {
  it("defaults empty project detection options to npm and preserves unavailable checks", async () => {
    const directory = await createProjectDirectory(scope);
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fixture" }));

    expect(await detectProjectPackageManager(directory, {})).toBe("npm");
    await expectResolutionError(
      detectProjectPackageManager(directory, new Set<PackageManager>()),
      "detection",
      "package-manager-unavailable",
    );
    await expectResolutionError(
      detectProjectPackageManager(directory, { npm: false }),
      "detection",
      "package-manager-unavailable",
    );
  });
});
