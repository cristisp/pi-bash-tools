import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProjectPackageManager } from "../../../src/tools/project-command/resolution.ts";
import { createProjectDirectory, createResolutionTestScope } from "./test-fixtures.ts";

const scope = createResolutionTestScope();

afterEach(scope.cleanup);

describe("package manager project detection", () => {
  it("reads package.json and supported lockfiles without consulting PATH", async () => {
    const directory = await createProjectDirectory(scope);
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ packageManager: "yarn@4.2.0" }),
    );
    await writeFile(join(directory, "yarn.lock"), "ignored by explicit packageManager");
    await expect(
      detectProjectPackageManager(directory, {
        availability: { npm: true, pnpm: true, bun: true, yarn: false },
      }),
    ).rejects.toMatchObject({ stage: "detection", code: "package-manager-unavailable" });

    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fixture" }));
    await rm(join(directory, "yarn.lock"));
    await writeFile(join(directory, "package-lock.json"), "{}");
    expect(
      await detectProjectPackageManager(directory, {
        availability: { npm: true, pnpm: false, bun: false, yarn: false },
      }),
    ).toBe("npm");
    expect(await readFile(join(directory, "package.json"), "utf8")).toContain("fixture");
  });
});
