import { afterEach, describe, expect, it } from "vitest";
import { detectPackageManager } from "../../../src/tools/project-command/resolution.ts";
import {
  nodeDependencyListArgs,
  supportsNodeDependencyList,
} from "../../../src/tools/project-command/package-manager.ts";
import { availablePackageManagers, createResolutionTestScope } from "./test-fixtures.ts";

const scope = createResolutionTestScope();

afterEach(scope.cleanup);

describe("package manager declarations", () => {
  it("applies explicit package manager precedence and strict availability", () => {
    expect(
      detectPackageManager(
        { packageManager: "pnpm@9.1.0", lockfiles: ["package-lock.json", "pnpm-lock.yaml"] },
        availablePackageManagers,
      ),
    ).toBe("pnpm");
    expect(() =>
      detectPackageManager(
        { packageManager: "npm@^10.0.0", lockfiles: [] },
        availablePackageManagers,
      ),
    ).toThrowError(
      expect.objectContaining({ stage: "detection", code: "invalid-package-manager" }),
    );
    expect(() =>
      detectPackageManager(
        { packageManager: "deno@1.0.0", lockfiles: [] },
        availablePackageManagers,
      ),
    ).toThrowError(
      expect.objectContaining({ stage: "detection", code: "invalid-package-manager" }),
    );
    expect(() =>
      detectPackageManager({ packageManager: "bun@1.0.0", lockfiles: [] }, { npm: true }),
    ).toThrowError(
      expect.objectContaining({ stage: "detection", code: "package-manager-unavailable" }),
    );
  });

  it("exposes manager-specific dependency-list helpers", () => {
    expect(supportsNodeDependencyList("npm", "10.0.0")).toBe(true);
    expect(nodeDependencyListArgs("npm", "10.0.0")).toEqual(["ls", "--depth=0"]);
  });
});
