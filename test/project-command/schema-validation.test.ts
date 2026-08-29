import { expect, it } from "vitest";
import { validateProjectCommandInput } from "../../src/tools/project-command/schema.ts";

it("accepts only the catalog command IDs and supported package-script options", () => {
  for (const commandId of [
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
    "fallow_list_entry_points",
    "fallow_list_boundaries",
  ]) {
    expect(validateProjectCommandInput({ commandId })).toEqual({ commandId });
  }
  expect(validateProjectCommandInput({ commandId: "fallow_audit", base: "HEAD~1" })).toEqual({
    commandId: "fallow_audit",
    base: "HEAD~1",
  });
  expect(validateProjectCommandInput({ commandId: "node_test", paths: ["src/index.ts"] })).toEqual({
    commandId: "node_test",
    paths: ["src/index.ts"],
  });
  expect(validateProjectCommandInput({ commandId: "node_test", paths: [] })).toEqual({
    commandId: "node_test",
  });
  expect(validateProjectCommandInput({ commandId: "node_test", variant: "coverage" })).toEqual({
    commandId: "node_test",
    variant: "coverage",
  });
  expect(validateProjectCommandInput({ commandId: "node_lint", variant: "errors:ci" })).toEqual({
    commandId: "node_lint",
    variant: "errors:ci",
  });
  expect(validateProjectCommandInput({ commandId: "node_format" })).toEqual({
    commandId: "node_format",
  });
  expect(validateProjectCommandInput({ commandId: "node_format", variant: "check" })).toEqual({
    commandId: "node_format",
    variant: "check",
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
    { commandId: "node_format", args: ["run", "format"] },
    { commandId: "fallow_audit" },
    { commandId: "fallow_audit", base: "" },
    { commandId: "fallow_audit", base: "--help" },
    { commandId: "fallow_audit", base: "HEAD:secret" },
    { commandId: "fallow_audit", base: "HEAD main" },
    { commandId: "fallow_audit", base: "HEAD", extra: true },
    { commandId: "node_test", executable: "/bin/sh" },
    { commandId: "node_test", paths: ["safe\u0080.ts"] },
    { commandId: "node_test", paths: ["../outside"] },
    { commandId: "node_test", paths: ["-leading"] },
    { commandId: "node_test", paths: ["src\\index.ts"] },
    { commandId: "node_test", paths: ["src/*.ts"] },
    { commandId: "node_test", paths: ["src/index.ts", "src/index.ts"] },
    { commandId: "node_lint", variant: "bad;command" },
    { commandId: "node_lint", variant: "../outside" },
    { commandId: "node_lint", variant: "-leading" },
    { commandId: "node_test", variant: "../outside" },
    { commandId: "node_format", variant: "-leading" },
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

it("reports a structured invalid request without execution", () => {
  try {
    validateProjectCommandInput({ commandId: "node_lint", variant: "-unsafe" });
    throw new Error("expected validation failure");
  } catch (error) {
    expect(error).toMatchObject({
      name: "ProjectCommandToolError",
      contract: {
        code: "invalid-request",
        category: "INVALID_REQUEST",
        explanation: expect.any(String),
        invalidField: "variant",
        retryable: false,
        executed: false,
      },
      details: {
        category: "INVALID_REQUEST",
        executed: false,
        suggestedAction: "Correct the invalid request field and retry the command.",
        error: {
          suggestedAction: "Correct the invalid request field and retry the command.",
          code: "invalid-request",
          category: "INVALID_REQUEST",
          invalidField: "variant",
          executed: false,
        },
      },
    });
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
