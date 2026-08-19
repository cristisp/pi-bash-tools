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
      { "sh -c echo unsafe": "workspace_path" },
      { commandId: 1 },
      { commandId: undefined },
    ];
    for (const request of invalidRequests) {
      expect(() => validateProjectCommandInput(request)).toThrow(/invalid/iu);
    }
  });

  it("uses only enumerable commandId shape keys", () => {
    const nonEnumerable = { commandId: "workspace_path" };
    Object.defineProperty(nonEnumerable, "extra", { value: true, enumerable: false });
    expect(validateProjectCommandInput(nonEnumerable)).toEqual({ commandId: "workspace_path" });

    const inherited = Object.create({ commandId: "workspace_path" });
    expect(() => validateProjectCommandInput(inherited)).toThrow(/invalid/iu);

    const prototypePollution = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => validateProjectCommandInput(prototypePollution)).toThrow(/invalid/iu);
  });
});
