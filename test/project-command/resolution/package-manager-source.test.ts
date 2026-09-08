import { afterEach, describe, expect, it } from "vitest";

import { detectPackageManagerDetails } from "../../../src/tools/project-command/resolution.ts";
import { availablePackageManagers, createResolutionTestScope } from "./test-fixtures.ts";

const scope = createResolutionTestScope();

afterEach(scope.cleanup);

describe("package manager source details", () => {
  it("returns source and exact version details from pure detection", () => {
    expect(
      detectPackageManagerDetails(
        { packageManager: "npm@10.2.3", lockfiles: ["yarn.lock"] },
        availablePackageManagers,
      ),
    ).toEqual({ manager: "npm", version: "10.2.3", source: "packageManager" });
    expect(
      detectPackageManagerDetails({ lockfiles: ["pnpm-lock.yaml"] }, availablePackageManagers),
    ).toEqual({ manager: "pnpm", version: undefined, source: "lockfile" });
  });
});
