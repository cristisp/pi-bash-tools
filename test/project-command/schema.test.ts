import { expect, it } from "vitest";

import {
  PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
  PROJECT_COMMAND_MAX_PATH_LENGTH,
  PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
  PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN,
} from "../../src/tools/project-command/parameters.ts";
import { projectCommandInputSchema } from "../../src/tools/project-command/schema.ts";
import { schemaVariants } from "./schema-test-fixtures.ts";

it("generates one canonical schema variant per command and aliases for script variants", () => {
  const variants = schemaVariants(projectCommandInputSchema);
  expect(variants.slice(0, 15).map((variant) => variant.properties.commandId.const)).toEqual([
    "workspace_path",
    "node_version",
    "node_project_info",
    "node_deps_list",
    "node_test",
    "node_build",
    "node_lint",
    "node_typecheck",
    "node_format",
    "fallow_dead_code",
    "fallow_dupes",
    "fallow_health",
    "fallow_audit",
    "fallow_list_entry_points",
    "fallow_list_boundaries",
  ]);
  expect(variants.slice(15).map((variant) => variant.properties.commandId.pattern)).toEqual([
    expect.stringContaining("^node_test:"),
    expect.stringContaining("^node_lint:"),
    expect.stringContaining("^node_format:"),
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
        anyOf: [
          {
            type: "array",
            maxItems: PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
            items: { type: "string", maxLength: PROJECT_COMMAND_MAX_PATH_LENGTH },
          },
          { type: "string" },
        ],
      },
    },
  });
  expect(variants[6]).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: { const: "node_lint" },
      variant: {
        type: "string",
        pattern: PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN,
        maxLength: PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
      },
    },
  });
  expect(variants[8]).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: { const: "node_format" },
      variant: {
        type: "string",
        pattern: PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN,
        maxLength: PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
      },
    },
  });
  expect(variants[12]).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: { const: "fallow_audit" },
      base: { type: "string" },
    },
    required: ["commandId", "base"],
  });
  expect(variants).toHaveLength(18);
  expect(variants.every((variant) => !variant.additionalProperties)).toBe(true);
  expect(JSON.stringify(projectCommandInputSchema)).toContain(
    '"description":"Lookup-only evidence reference.',
  );
  expect(JSON.stringify(projectCommandInputSchema)).toContain('"pattern":"^[A-Za-z0-9_-]{1,64}$"');
  expect(variants.every((variant) => JSON.stringify(variant).includes('"force"'))).toBe(true);
  expect(variants.every((variant) => JSON.stringify(variant).includes('"true"'))).toBe(true);
});
