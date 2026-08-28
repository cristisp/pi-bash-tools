import { expect, it } from "vitest";
import type { ProjectCommandDefinition } from "../../src/tools/project-command/definitions.ts";
import {
  NODE_E2E_GREP_MAX_LENGTH,
  NODE_E2E_PROJECT_MAX_LENGTH,
  NODE_E2E_GREP_PATTERN,
  NODE_E2E_PROJECT_PATTERN,
  PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
  PROJECT_COMMAND_MAX_PATH_LENGTH,
} from "../../src/tools/project-command/parameters.ts";
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
    "node_test_coverage",
    "node_e2e",
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
      paths: {
        type: "array",
        maxItems: PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
        items: { type: "string", maxLength: PROJECT_COMMAND_MAX_PATH_LENGTH },
      },
    },
  });
  expect(variants[5]).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: { commandId: { const: "node_test_coverage" } },
  });
  expect(variants[6]).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: { const: "node_e2e" },
      paths: {
        type: "array",
        maxItems: PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
        items: { type: "string", maxLength: PROJECT_COMMAND_MAX_PATH_LENGTH },
      },
      grep: { type: "string", maxLength: NODE_E2E_GREP_MAX_LENGTH },
      projects: {
        type: "array",
        maxItems: PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
        items: { type: "string", maxLength: NODE_E2E_PROJECT_MAX_LENGTH },
      },
      workers: { type: "integer" },
      retries: { type: "integer" },
      headed: { type: "boolean" },
      list: { type: "boolean" },
    },
  });
  expect(variants[9]).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: { commandId: { const: "node_lint_fix" } },
  });
  expect(variants[11]).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: { commandId: { const: "node_format_check" } },
  });
  expect(variants[12]).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: { commandId: { const: "node_format_write" } },
  });
  expect(variants[16]).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: { const: "fallow_audit" },
      base: { type: "string" },
    },
    required: ["commandId", "base"],
  });
  expect(variants).toHaveLength(19);
  expect(variants.every((variant) => !variant.additionalProperties)).toBe(true);
  expect(variants.every((variant) => JSON.stringify(variant).includes('"force"'))).toBe(true);
});

it("keeps E2E schema patterns aligned with runtime text restrictions", () => {
  const variants = schemaVariants(projectCommandInputSchema);
  const e2e = variants.find((variant) => variant.properties.commandId.const === "node_e2e");
  if (
    e2e === undefined ||
    e2e.properties.grep === undefined ||
    e2e.properties.projects === undefined
  ) {
    throw new Error("missing node_e2e schema variant");
  }
  expect(e2e.properties.grep.pattern).toBe(NODE_E2E_GREP_PATTERN);
  expect(e2e.properties.projects.items.pattern).toBe(NODE_E2E_PROJECT_PATTERN);
  for (const character of ["\u2028", "\u2029"]) {
    expect(new RegExp(NODE_E2E_GREP_PATTERN, "u").test(`safe${character}text`)).toBe(false);
    expect(new RegExp(NODE_E2E_PROJECT_PATTERN, "u").test(`safe${character}text`)).toBe(false);
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
