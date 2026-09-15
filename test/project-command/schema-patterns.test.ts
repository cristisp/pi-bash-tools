import { expect, it } from "vitest";

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

it("keeps every model-facing schema pattern free of lookaround constructs", () => {
  const schemas = [
    projectCommandInputSchema,
    createProjectCommandInputSchema(getProjectCommandDefinitions()),
    verifyInputSchema,
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
