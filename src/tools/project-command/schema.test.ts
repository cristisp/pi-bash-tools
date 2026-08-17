import { describe, expect, it } from "vitest";
import { validateProjectCommandInput } from "./schema.ts";

describe("project command request contract", () => {
  it("accepts only the two semantic command IDs", () => {
    expect(validateProjectCommandInput({ commandId: "workspace_path" })).toEqual({
      commandId: "workspace_path",
    });
    expect(validateProjectCommandInput({ commandId: "node_version" })).toEqual({
      commandId: "node_version",
    });
  });

  it("rejects arbitrary command fields and inline execution forms", () => {
    const invalidRequests: unknown[] = [
      {},
      { commandId: "unknown" },
      { commandId: "workspace_path", args: [] },
      { commandId: "workspace_path", executable: "/bin/sh" },
      { commandId: "workspace_path", cwd: "/tmp" },
      { commandId: "workspace_path", shell: true },
      { commandId: "workspace_path", env: {} },
      { commandId: "workspace_path", timeout: 1 },
      { commandId: "workspace_path", script: "node -e process.env.SECRET" },
      { commandId: "node -e process.env.SECRET" },
      { commandId: "python", args: ["-c", "print(1)"] },
      { commandId: "sh -c echo unsafe" },
      { commandId: "workspace_path", [Symbol("extra")]: true },
      Object.assign(Object.create(null), { commandId: "workspace_path", extra: true }),
    ];
    for (const request of invalidRequests) {
      expect(() => validateProjectCommandInput(request)).toThrow(/invalid/iu);
    }
  });

  it("rejects accessors and non-plain objects", () => {
    const accessor = {} as { commandId?: string };
    Object.defineProperty(accessor, "commandId", {
      configurable: true,
      enumerable: true,
      get: () => "workspace_path",
    });
    expect(() => validateProjectCommandInput(accessor)).toThrow(/invalid/iu);
    expect(() => validateProjectCommandInput(new String("workspace_path"))).toThrow(/invalid/iu);
  });
});
