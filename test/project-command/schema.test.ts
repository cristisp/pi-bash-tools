import { expect, it } from "vitest";
import type { ProjectCommandDefinition } from "../../src/tools/project-command/definitions.ts";
import { schemaVariants } from "./schema-test-fixtures.ts";
import {
  createProjectCommandInputSchema,
  projectCommandInputSchema,
  validateProjectCommandInput,
} from "../../src/tools/project-command/schema.ts";

it("generates one literal schema variant per command", () => {
  const variants = schemaVariants(projectCommandInputSchema);
  expect(variants.map((variant) => variant.properties.commandId.const)).toEqual([
    "workspace_path",
    "node_version",
    "node_project_info",
    "node_deps_list",
    "node_test",
    "node_build",
    "node_lint",
    "node_lint_fix",
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
});

it("keeps schema variants strict and preserves command-specific fields", () => {
  const variants = schemaVariants(projectCommandInputSchema);
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
  expect(variants[7]).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: { commandId: { const: "node_lint_fix" } },
  });
  expect(variants[9]).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: { commandId: { const: "node_format_check" } },
  });
  expect(variants[10]).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: { commandId: { const: "node_format_write" } },
  });
  expect(variants[14]).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: { const: "fallow_audit" },
      base: { type: "string" },
    },
    required: ["commandId", "base"],
  });
  expect(variants).toHaveLength(17);
  expect(variants.every((variant) => !variant.additionalProperties)).toBe(true);
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
