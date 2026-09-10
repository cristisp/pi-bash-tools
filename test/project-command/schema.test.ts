import { expect, it } from "vitest";

import {
  FALLOW_REVISION_PATTERN,
  PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
  PROJECT_COMMAND_MAX_PATH_LENGTH,
  PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
  PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN,
} from "../../src/tools/project-command/parameters.ts";
import { projectCommandInputSchema } from "../../src/tools/project-command/schema.ts";

type FlatSchema = {
  readonly type?: string;
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly description?: string;
};

type CommandIdVariant = {
  readonly const?: string;
  readonly description?: string;
  readonly pattern?: string;
};

function flatSchema(): FlatSchema {
  return projectCommandInputSchema as FlatSchema;
}

function properties(): Readonly<Record<string, unknown>> {
  return flatSchema().properties ?? {};
}

it("flattens the model-facing schema into a single strict object", () => {
  const schema = flatSchema();
  expect(schema.type).toBe("object");
  expect(schema.additionalProperties).toBe(false);
  expect(schema.required).toBeUndefined();
  expect(Object.keys(properties()).sort()).toEqual([
    "base",
    "commandId",
    "covers",
    "flowId",
    "force",
    "paths",
    "publish",
    "ref",
    "variant",
  ]);
  expect(schema.description).toContain("Execution requests require commandId");
  expect(schema.description).toContain("Provide either commandId or ref, never both.");
});

it("lists every command ID and the legacy variant aliases in the commandId schema", () => {
  const commandId = properties().commandId as {
    readonly anyOf?: readonly CommandIdVariant[];
  };
  const variants = commandId.anyOf ?? [];

  expect(variants.slice(0, 15).map((variant) => variant.const)).toEqual([
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
  expect(variants.slice(15).map((variant) => variant.pattern)).toEqual([
    expect.stringContaining("^node_test:"),
    expect.stringContaining("^node_lint:"),
    expect.stringContaining("^node_format:"),
  ]);
  expect(variants[0]).toMatchObject({
    description:
      "Report the canonical project directory. Use when the user asks where the project workspace is located.",
  });
});

it("preserves command-specific field schemas and evidence options", () => {
  const schemaProperties = properties();

  expect(schemaProperties.paths).toMatchObject({
    anyOf: [
      {
        type: "array",
        maxItems: PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
        items: { type: "string", maxLength: PROJECT_COMMAND_MAX_PATH_LENGTH },
      },
      { type: "string" },
    ],
  });
  expect(schemaProperties.variant).toMatchObject({
    type: "string",
    pattern: PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN,
    maxLength: PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
  });
  expect(schemaProperties.base).toMatchObject({
    type: "string",
    pattern: FALLOW_REVISION_PATTERN,
  });
  expect(schemaProperties.ref).toMatchObject({
    type: "string",
    pattern: "^[A-Za-z0-9_-]{8,128}$",
  });
  expect(schemaProperties.flowId).toMatchObject({
    type: "string",
    pattern: "^[A-Za-z0-9_-]{1,64}$",
  });
  expect(schemaProperties.publish).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: { flowId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" } },
  });
  expect(schemaProperties.covers).toMatchObject({
    type: "array",
    maxItems: 64,
    items: { type: "string", minLength: 1, maxLength: 512 },
  });

  expect(JSON.stringify(projectCommandInputSchema)).toContain(
    '"description":"Lookup-only evidence reference.',
  );
  expect(JSON.stringify(projectCommandInputSchema)).toContain('"force"');
  expect(JSON.stringify(projectCommandInputSchema)).toContain('"true"');
});
