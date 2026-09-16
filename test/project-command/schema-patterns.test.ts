import { expect, it } from "vitest";

import { readBatchParameters } from "../../src/tools/filesystem/read-batch-tool.ts";
import { getProjectCommandDefinitions } from "../../src/tools/project-command/definitions.ts";
import {
  FALLOW_REVISION_PATTERN,
  NODE_TEST_PATH_PATTERN,
  validateProjectCommandRevision,
  validateWorkspacePathParameter,
} from "../../src/tools/project-command/parameters.ts";
import {
  createProjectCommandInputSchema,
  projectCommandInputSchema,
} from "../../src/tools/project-command/schema.ts";
import { verifyInputSchema } from "../../src/tools/verify/schema.ts";

const LOOKAROUND_PATTERN = /\(\?<?[=!]/u;

function isSchemaNode(schema: unknown): schema is {
  readonly type?: unknown;
  readonly anyOf?: readonly unknown[];
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly unknown[];
} {
  return typeof schema === "object" && schema !== null && !Array.isArray(schema);
}

function admitsNull(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(admitsNull);
  if (!isSchemaNode(schema)) return false;
  if (schema.type === "null") return true;
  return Array.isArray(schema.anyOf) && schema.anyOf.some(admitsNull);
}

function optionalPropertyNames(schema: unknown): string[] {
  if (!isSchemaNode(schema)) return [];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  return Object.keys(schema.properties ?? {}).filter((key) => !required.has(key));
}

it("admits explicit null for every optional top-level property in the strict-decoder schemas", () => {
  const schemas = [
    ["project_command", projectCommandInputSchema],
    ["verify", verifyInputSchema],
    ["read_batch", readBatchParameters],
  ] as const;
  for (const [name, schema] of schemas) {
    const optional = optionalPropertyNames(schema);
    const properties: Readonly<Record<string, unknown>> = isSchemaNode(schema)
      ? (schema.properties ?? {})
      : {};
    expect(optional.length).toBeGreaterThan(0);
    for (const key of optional) {
      const property = properties[key];
      expect(admitsNull(property), `${name}.${key} must admit explicit null`).toBe(true);
    }
  }
});

function collectSchemaPatterns(value: unknown, patterns: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaPatterns(item, patterns);
    return patterns;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key === "pattern" && typeof item === "string") patterns.push(item);
      else collectSchemaPatterns(item, patterns);
    }
  }
  return patterns;
}

it("reports the read_batch flow shape used by runtime validation", () => {
  const schema = readBatchParameters;
  const properties: Readonly<Record<string, unknown>> = isSchemaNode(schema)
    ? (schema.properties ?? {})
    : {};
  const flowId = properties.flowId;
  const flowIdVariants = isSchemaNode(flowId) ? (flowId.anyOf ?? []) : [];
  expect(flowIdVariants[0]).toMatchObject({
    type: "string",
    pattern: "^[A-Za-z0-9_-]{1,64}$",
    description: expect.stringContaining("Lookup-only"),
  });
  const covers = properties.covers;
  const coversVariants = isSchemaNode(covers) ? (covers.anyOf ?? []) : [];
  expect(coversVariants[0]).toMatchObject({
    type: "array",
    description: expect.stringContaining("acceptance-criteria"),
  });
  const publish = properties.publish;
  const publishVariants = isSchemaNode(publish) ? (publish.anyOf ?? []) : [];
  expect(publishVariants[0]).toMatchObject({
    type: "object",
    description: expect.stringContaining("Execution-only"),
  });
  expect(schema).toMatchObject({
    type: "object",
    additionalProperties: false,
    description: expect.stringContaining("lookup uses ref"),
  });
  expect(Object.keys(properties).sort()).toEqual(["covers", "flowId", "paths", "publish", "ref"]);
});

it("keeps every model-facing schema pattern free of lookaround constructs", () => {
  const schemas = [
    projectCommandInputSchema,
    createProjectCommandInputSchema(getProjectCommandDefinitions()),
    verifyInputSchema,
    readBatchParameters,
  ];
  const patterns = schemas.flatMap((schema) => collectSchemaPatterns(schema));
  expect(patterns.length).toBeGreaterThan(0);
  expect(patterns).toContain(NODE_TEST_PATH_PATTERN);
  expect(patterns).toContain(FALLOW_REVISION_PATTERN);
  for (const pattern of patterns) {
    expect(pattern).not.toMatch(LOOKAROUND_PATTERN);
  }
});

it("aligns the test-path pattern with workspace-path runtime semantics", () => {
  const accepted = [
    "src/index.ts",
    "a",
    "a-b",
    "a/b",
    "a:b",
    "ab:c",
    ":x",
    "1x",
    "a.x",
    "...",
    "....",
    "a/-b",
    "a..b",
    "C:x",
    "C:.",
    "x-",
    "a.b.c",
  ];
  const rejected = [
    "-x",
    "/x",
    "",
    "x/",
    "a//b",
    ".",
    "..",
    "./a",
    "a/.",
    "a/..",
    "a/../b",
    "C:/x",
    "C:\\x",
    "a:/x",
    "a:/",
    "a*b",
    "a?b",
    "a[b]",
    "a\\b",
    "a\u0001b",
    "a\u2028b",
    "a\u009fb",
  ];
  const tightened = ["C:", "a:"];
  expect(NODE_TEST_PATH_PATTERN).not.toMatch(LOOKAROUND_PATTERN);
  for (const flags of ["u", ""]) {
    const pattern = new RegExp(NODE_TEST_PATH_PATTERN, flags);
    for (const value of accepted) {
      expect(pattern.test(value), `accept ${JSON.stringify(value)} flags "${flags}"`).toBe(true);
      expect(validateWorkspacePathParameter(value)).toBe(value);
    }
    for (const value of rejected) {
      expect(pattern.test(value), `reject ${JSON.stringify(value)} flags "${flags}"`).toBe(false);
      expect(() => validateWorkspacePathParameter(value)).toThrow();
    }
    for (const value of tightened) {
      expect(pattern.test(value), `reject ${JSON.stringify(value)} flags "${flags}"`).toBe(false);
    }
  }
});

it("keeps the Fallow revision pattern lookaround-free with the same accepted set", () => {
  const accepted = [
    "HEAD",
    "HEAD~1",
    "a-b",
    "a-b-c",
    "abc-",
    "x-",
    "a.b",
    "v1.2.3",
    "a{}b",
    "a.b@c",
    "~",
    "{}",
    "+=,",
  ];
  const rejected = [
    "",
    "-",
    "-x",
    "a--b",
    "a--",
    "--",
    "a:b",
    "a b",
    "a*b",
    "a[b]",
    "a\\b",
    "a\tb",
  ];
  expect(FALLOW_REVISION_PATTERN).not.toMatch(LOOKAROUND_PATTERN);
  for (const flags of ["u", ""]) {
    const pattern = new RegExp(FALLOW_REVISION_PATTERN, flags);
    for (const value of accepted) {
      expect(pattern.test(value), `accept ${JSON.stringify(value)} flags "${flags}"`).toBe(true);
      expect(validateProjectCommandRevision(value)).toBe(value);
    }
    for (const value of rejected) {
      expect(pattern.test(value), `reject ${JSON.stringify(value)} flags "${flags}"`).toBe(false);
      expect(() => validateProjectCommandRevision(value)).toThrow();
    }
  }
});
