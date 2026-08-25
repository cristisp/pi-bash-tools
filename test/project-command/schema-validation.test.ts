import { expect, it } from "vitest";
import { validateProjectCommandInput } from "../../src/tools/project-command/schema.ts";

it("accepts only the catalog command IDs and the supported test options", () => {
  for (const commandId of [
    "workspace_path",
    "node_version",
    "node_project_info",
    "node_deps_list",
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
  expect(
    validateProjectCommandInput({
      commandId: "node_e2e",
      paths: ["e2e/login.spec.ts"],
      grep: "login",
      projects: ["chromium", "firefox"],
      workers: 2,
      retries: 1,
      headed: false,
      list: true,
    }),
  ).toEqual({
    commandId: "node_e2e",
    paths: ["e2e/login.spec.ts"],
    grep: "login",
    projects: ["chromium", "firefox"],
    workers: 2,
    retries: 1,
    headed: false,
    list: true,
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
    { commandId: "node_lint_fix", args: ["run", "lint:fix"] },
    { commandId: "fallow_audit" },
    { commandId: "fallow_audit", base: "" },
    { commandId: "fallow_audit", base: "--help" },
    { commandId: "fallow_audit", base: "HEAD:secret" },
    { commandId: "fallow_audit", base: "HEAD main" },
    { commandId: "fallow_audit", base: "HEAD", extra: true },
    { commandId: "node_test", executable: "/bin/sh" },
    { commandId: "node_e2e", grep: "-unsafe" },
    { commandId: "node_e2e", projects: ["chromium", "chromium"] },
    { commandId: "node_e2e", workers: 0 },
    { commandId: "node_e2e", retries: 11 },
    { commandId: "node_e2e", headed: "yes" },
    { commandId: "node_e2e", list: 1 },
    { commandId: "node_e2e", unknown: true },
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

it("uses only enumerable commandId shape keys", () => {
  const nonEnumerable = { commandId: "workspace_path" };
  Object.defineProperty(nonEnumerable, "extra", { value: true, enumerable: false });
  expect(validateProjectCommandInput(nonEnumerable)).toEqual({ commandId: "workspace_path" });

  const inherited = Object.create({ commandId: "workspace_path" });
  expect(() => validateProjectCommandInput(inherited)).toThrow(/invalid/iu);

  const prototypePollution = JSON.parse('{"__proto__":{"polluted":true}}');
  expect(() => validateProjectCommandInput(prototypePollution)).toThrow(/invalid/iu);
});
