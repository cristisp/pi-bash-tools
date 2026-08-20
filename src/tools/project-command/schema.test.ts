import { describe, expect, it } from "vitest";
import type { ProjectCommandDefinition } from "./definitions.ts";
import {
  createProjectCommandInputSchema,
  projectCommandInputSchema,
  validateProjectCommandInput,
} from "./schema.ts";

type SchemaVariant = {
  readonly additionalProperties: boolean;
  readonly properties: {
    readonly commandId: { readonly const: string };
    readonly paths?: { readonly type: string; readonly items: { readonly type: string } };
  };
  readonly type: string;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isSchemaCommandId(value: unknown): value is { readonly const: string } {
  return isRecord(value) && typeof value.const === "string";
}

function isSchemaPaths(
  value: unknown,
): value is { readonly type: string; readonly items: { readonly type: string } } | undefined {
  return (
    value === undefined ||
    (isRecord(value) &&
      value.type === "array" &&
      isRecord(value.items) &&
      value.items.type === "string")
  );
}

function isSchemaVariant(value: unknown): value is SchemaVariant {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    value.additionalProperties === false &&
    isRecord(value.properties) &&
    isSchemaCommandId(value.properties.commandId) &&
    isSchemaPaths(value.properties.paths)
  );
}

function schemaVariants(schema: unknown): readonly SchemaVariant[] {
  if (!isRecord(schema) || !isUnknownArray(schema.anyOf) || !schema.anyOf.every(isSchemaVariant)) {
    throw new Error("Project command schema does not contain valid variants");
  }
  return schema.anyOf.filter(isSchemaVariant);
}

describe("project command request contract", () => {
  it("generates a strict discriminated union with one literal variant per command", () => {
    const variants = schemaVariants(projectCommandInputSchema);
    expect(variants.map((variant) => variant.properties.commandId.const)).toEqual([
      "workspace_path",
      "node_version",
      "node_project_info",
      "node_deps_list",
      "node_test",
      "node_build",
      "node_lint",
      "node_typecheck",
      "node_format_check",
      "node_format_write",
      "fallow_dead_code",
      "fallow_dupes",
      "fallow_health",
      "fallow_audit",
      "fallow_list_entry_points",
      "fallow_list_boundaries",
    ]);
    expect(variants[0]).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        commandId: {
          const: "workspace_path",
          description:
            "Report the canonical project directory. Use when the user asks where the project workspace is located.",
        },
      },
    });
    expect(variants[4]).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        commandId: { const: "node_test" },
        paths: { type: "array", items: { type: "string" } },
      },
    });
    expect(variants[8]).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { commandId: { const: "node_format_check" } },
    });
    expect(variants[9]).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { commandId: { const: "node_format_write" } },
    });
    expect(variants[13]).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        commandId: { const: "fallow_audit" },
        base: { type: "string" },
      },
      required: ["commandId", "base"],
    });
    expect(variants).toHaveLength(16);
    expect(variants.every((variant) => !variant.additionalProperties)).toBe(true);
  });

  it("accepts only the catalog command IDs and the optional test paths", () => {
    for (const commandId of [
      "workspace_path",
      "node_version",
      "node_project_info",
      "node_deps_list",
      "node_build",
      "node_lint",
      "node_typecheck",
      "node_format_check",
      "node_format_write",
      "fallow_dead_code",
      "fallow_dupes",
      "fallow_health",
      "fallow_list_entry_points",
      "fallow_list_boundaries",
    ]) {
      expect(validateProjectCommandInput({ commandId })).toEqual({ commandId });
    }
    expect(validateProjectCommandInput({ commandId: "fallow_audit", base: "HEAD~1" })).toEqual({
      commandId: "fallow_audit",
      base: "HEAD~1",
    });
    expect(
      validateProjectCommandInput({ commandId: "node_test", paths: ["src/index.ts"] }),
    ).toEqual({
      commandId: "node_test",
      paths: ["src/index.ts"],
    });
    expect(validateProjectCommandInput({ commandId: "node_test", paths: [] })).toEqual({
      commandId: "node_test",
    });
  });

  it("rejects arbitrary command fields and inline execution forms", () => {
    const invalidRequests: unknown[] = [
      {},
      { commandId: "unknown" },
      { commandId: "node_deps_install" },
      { commandId: "fallow" },
      { commandId: "workspace_path", args: [] },
      { commandId: "node_build", paths: [] },
      { commandId: "node_format_check", paths: [] },
      { commandId: "node_format_write", args: ["run", "format"] },
      { commandId: "fallow_audit" },
      { commandId: "fallow_audit", base: "" },
      { commandId: "fallow_audit", base: "--help" },
      { commandId: "fallow_audit", base: "HEAD:secret" },
      { commandId: "fallow_audit", base: "HEAD main" },
      { commandId: "fallow_audit", base: "HEAD", extra: true },
      { commandId: "node_test", executable: "/bin/sh" },
      { commandId: "node_test", paths: ["../outside"] },
      { commandId: "node_test", paths: ["-leading"] },
      { commandId: "node_test", paths: ["src\\index.ts"] },
      { commandId: "node_test", paths: ["src/*.ts"] },
      { commandId: "node_test", paths: ["src/index.ts", "src/index.ts"] },
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
