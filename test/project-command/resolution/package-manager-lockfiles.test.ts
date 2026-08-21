import { afterEach, describe, expect, it } from "vitest";
import { detectPackageManager } from "../../../src/tools/project-command/resolution.ts";
import { availablePackageManagers, createResolutionTestScope } from "./test-fixtures.ts";

const scope = createResolutionTestScope();

afterEach(scope.cleanup);

describe("package manager lockfile detection", () => {
  it("detects supported lockfiles, defaults away from Yarn, and rejects conflicts", () => {
    expect(
      detectPackageManager({ lockfiles: ["package-lock.json"] }, availablePackageManagers),
    ).toBe("npm");
    expect(
      detectPackageManager({ lockfiles: ["npm-shrinkwrap.json"] }, availablePackageManagers),
    ).toBe("npm");
    expect(detectPackageManager({ lockfiles: ["pnpm-lock.yaml"] }, availablePackageManagers)).toBe(
      "pnpm",
    );
    expect(detectPackageManager({ lockfiles: ["bun.lock"] }, availablePackageManagers)).toBe("bun");
    expect(detectPackageManager({ lockfiles: ["bun.lockb"] }, availablePackageManagers)).toBe(
      "bun",
    );
    expect(() =>
      detectPackageManager({ lockfiles: ["yarn.lock"] }, availablePackageManagers),
    ).toThrowError(
      expect.objectContaining({ stage: "detection", code: "ambiguous-yarn-lockfile" }),
    );
    expect(detectPackageManager({ lockfiles: [] }, availablePackageManagers)).toBe("npm");
    expect(() =>
      detectPackageManager(
        { lockfiles: ["package-lock.json", "pnpm-lock.yaml"] },
        availablePackageManagers,
      ),
    ).toThrowError(expect.objectContaining({ stage: "detection", code: "conflicting-lockfiles" }));
    expect(() =>
      detectPackageManager({ lockfiles: ["pnpm-lock.yaml", "bun.lock"] }, availablePackageManagers),
    ).toThrowError(expect.objectContaining({ stage: "detection", code: "conflicting-lockfiles" }));
    expect(() => detectPackageManager({ lockfiles: [] }, { npm: false })).toThrowError(
      expect.objectContaining({ stage: "detection", code: "package-manager-unavailable" }),
    );
  });
});
