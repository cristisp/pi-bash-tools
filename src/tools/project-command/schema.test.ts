import { describe, expect, it } from "vitest";
import type { ProjectCommandDefinition } from "./definitions.ts";
import {
  createProjectCommandInputSchema,
  projectCommandInputSchema,
  validateProjectCommandInput,
} from "./schema.ts";

describe("project command request contract", () => {
  it("generates strict literal schemas from definition metadata", () => {
    expect(projectCommandInputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        commandId: {
          anyOf: [
            {
              type: "string",
              const: "workspace_path",
              description:
                "Report the canonical project directory. Use when the user asks where the project workspace is located.",
            },
            {
              type: "string",
              const: "node_version",
              description:
                "Report the Node.js runtime version. Use when the user asks which Node.js version is active.",
            },
          ],
        },
      },
    });
  });

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

  it("uses the supplied definitions for schema and validation", () => {
    const customDefinition = {
      namespace: "bash-tools.project-command",
      commandId: "custom_command",
      description: "Run the custom command.",
      executable: "/bin/echo",
      args: ["custom"],
      cwdStrategy: "canonical-project",
      sanitizedEnvironmentProfile: "minimal-static-v1",
      processTimeoutMs: 30_000,
      outputLimitBytes: 50 * 1024,
      risk: "workspace-observation",
      globalSafe: true,
    } satisfies ProjectCommandDefinition<"custom_command">;
    const definitions = [customDefinition] as const;
    const schema = createProjectCommandInputSchema(definitions);

    expect(JSON.stringify(schema)).toContain('"const":"custom_command"');
    expect(JSON.stringify(schema)).toContain("Run the custom command.");
    expect(validateProjectCommandInput({ commandId: "custom_command" }, definitions)).toEqual({
      commandId: "custom_command",
    });
    expect(() => validateProjectCommandInput({ commandId: "workspace_path" }, definitions)).toThrow(
      /invalid/iu,
    );
    expect(() => validateProjectCommandInput({ commandId: "custom_command" })).toThrow(/invalid/iu);
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
