import { describe, expect, it } from "vitest";
import { isProjectCommandResolutionError } from "../../src/tools/project-command/resolution.ts";

describe("project command resolution facade", () => {
  it("does not classify unrelated errors as resolution errors", () => {
    expect(isProjectCommandResolutionError(new Error("unrelated"))).toBe(false);
  });
});
