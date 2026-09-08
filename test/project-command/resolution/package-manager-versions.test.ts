import { afterEach, describe, expect, it } from "vitest";

import {
  detectPackageManager,
  detectPackageManagerDetails,
} from "../../../src/tools/project-command/resolution.ts";
import { availablePackageManagers, createResolutionTestScope } from "./test-fixtures.ts";

const scope = createResolutionTestScope();

afterEach(scope.cleanup);

describe("package manager versions", () => {
  it("accepts supported exact versions and rejects malformed explicit values", () => {
    const validVersions = [
      { packageManager: "npm@0.0.0", manager: "npm", version: "0.0.0" },
      { packageManager: "pnpm@1.2.3-0", manager: "pnpm", version: "1.2.3-0" },
      {
        packageManager: "bun@10.20.30-rc.1+build.7",
        manager: "bun",
        version: "10.20.30-rc.1+build.7",
      },
      {
        packageManager: "yarn@1.2.3-alpha.1+build.01",
        manager: "yarn",
        version: "1.2.3-alpha.1+build.01",
      },
    ] as const;
    for (const valid of validVersions) {
      expect(
        detectPackageManagerDetails(
          { packageManager: valid.packageManager, lockfiles: [] },
          availablePackageManagers,
        ),
      ).toEqual({ manager: valid.manager, version: valid.version, source: "packageManager" });
    }

    const malformedVersions = [
      ...["\n", "\r", "\r\n", "\u2028", "\u2029"].map(
        (lineTerminator) => `npm@1.2.3${lineTerminator}`,
      ),
      "npm@1.2.3-01",
      "pnpm@1.2.3-rc.01",
      "bun@1.2.3-1.0.01",
    ];
    for (const packageManager of malformedVersions) {
      expect(() =>
        detectPackageManager({ packageManager, lockfiles: [] }, availablePackageManagers),
      ).toThrowError(
        expect.objectContaining({ stage: "detection", code: "invalid-package-manager" }),
      );
    }
  });
});
