import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  detectProjectPackageManager,
  isProjectCommandResolutionError,
  ProjectCommandResolutionError,
} from "../../../src/tools/project-command/resolution.ts";
import {
  availablePackageManagers,
  createProjectDirectory,
  createResolutionTestScope,
  expectResolutionError,
} from "./test-fixtures.ts";

const scope = createResolutionTestScope();

afterEach(scope.cleanup);

describe("project command resolution errors", () => {
  it("exposes stable stage errors without raw error details", async () => {
    const error = new ProjectCommandResolutionError("detection", "invalid-package-manager", {
      manager: "npm",
    });
    expect(isProjectCommandResolutionError(error)).toBe(true);
    expect(error.stage).toBe("detection");
    expect(error.code).toBe("invalid-package-manager");
    expect(error.details).toEqual({
      stage: "detection",
      code: "invalid-package-manager",
      manager: "npm",
    });

    const directory = await createProjectDirectory(scope);
    await writeFile(join(directory, "package.json"), "not-json: secret manifest");
    await expectResolutionError(
      detectProjectPackageManager(directory, { availability: availablePackageManagers }),
      "detection",
      "invalid-package-manifest",
    );
    await expect(
      detectProjectPackageManager(directory, { availability: availablePackageManagers }),
    ).rejects.not.toMatchObject({ details: expect.stringContaining("secret") });
    expect(JSON.stringify(error)).not.toContain("secret");
  });
});
