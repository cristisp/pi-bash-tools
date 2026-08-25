import { expect, it } from "vitest";
import {
  PROJECT_COMMAND_NAMESPACE,
  getProjectCommandDefinitions,
} from "../../src/tools/project-command/definitions.ts";

it("contains the extension-owned command catalog in stable order", () => {
  const definitions = getProjectCommandDefinitions();
  expect(definitions.map((definition) => definition.commandId)).toEqual([
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
  expect(
    definitions.every((definition) => definition.namespace === PROJECT_COMMAND_NAMESPACE),
  ).toBe(true);
});

it("describes the built-in command execution policies", () => {
  const definitions = getProjectCommandDefinitions();
  expect(definitions[0]).toMatchObject({
    commandId: "workspace_path",
    description:
      "Report the canonical project directory. Use when the user asks where the project workspace is located.",
    executable: "/bin/pwd",
    args: [],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "minimal-static-v1",
  });
  expect(definitions[1]).toMatchObject({
    commandId: "node_version",
    description:
      "Report the Node.js runtime version. Use when the user asks which Node.js version is active.",
    executable: process.execPath,
    args: ["--version"],
  });
});

it("describes the built-in Node command policies", () => {
  const definitions = getProjectCommandDefinitions();
  expect(definitions.slice(2, 13)).toMatchObject([
    { commandId: "node_project_info", risk: "observe", globalSafe: true },
    {
      commandId: "node_deps_list",
      args: [],
      risk: "observe",
      globalSafe: true,
      executionKind: "process",
      applicability: "node-dependency-list",
      bindsRepoContent: false,
      acceptedExitCodes: [1],
      truncationDirection: "head",
      parameters: [],
    },
    {
      commandId: "node_test",
      risk: "project-code",
      globalSafe: false,
      fixedScriptKey: "test",
      truncationDirection: "tail",
      environmentProfile: "node-v1",
    },
    {
      commandId: "node_test_coverage",
      description: "Run the exact package.json test:coverage script.",
      args: ["run", "test:coverage"],
      risk: "project-code",
      globalSafe: false,
      fixedScriptKey: "test:coverage",
    },
    {
      commandId: "node_e2e",
      description: "Run the exact package.json test:e2e script with optional test runner options.",
      args: ["run", "test:e2e"],
      risk: "project-code",
      globalSafe: false,
      parameters: [
        { name: "paths", kind: "workspace-paths", required: false },
        { name: "grep", kind: "text", required: false },
        { name: "projects", kind: "text-list", required: false },
        { name: "workers", kind: "positive-integer", required: false },
        { name: "retries", kind: "non-negative-integer", required: false },
        { name: "headed", kind: "boolean", required: false },
        { name: "list", kind: "boolean", required: false },
      ],
      fixedScriptKey: "test:e2e",
    },
    { commandId: "node_build", fixedScriptKey: "build" },
    { commandId: "node_lint", fixedScriptKey: "lint" },
    {
      commandId: "node_lint_fix",
      description: "Run the exact package.json lint:fix script to write lint fixes.",
      executable: "",
      args: ["run", "lint:fix"],
      cwdStrategy: "canonical-project",
      sanitizedEnvironmentProfile: "node-v1",
      environmentProfile: "node-v1",
      processTimeoutMs: 30_000,
      outputLimitBytes: 50 * 1024,
      risk: "project-code",
      globalSafe: false,
      applicability: "node-script",
      bindsRepoContent: true,
      scriptBinding: "package-script",
      parameters: [],
      argvTemplate: ["<package-manager>", "run", "lint:fix"],
      fixedScriptKey: "lint:fix",
      truncationDirection: "tail",
    },
    { commandId: "node_typecheck", fixedScriptKey: "typecheck" },
    {
      commandId: "node_format_check",
      args: ["run", "format:check"],
      risk: "project-code",
      globalSafe: false,
      fixedScriptKey: "format:check",
    },
    {
      commandId: "node_format_write",
      args: ["run", "format"],
      risk: "project-code",
      globalSafe: false,
      fixedScriptKey: "format",
    },
  ]);
});

it("describes the built-in Fallow command policies", () => {
  const definitions = getProjectCommandDefinitions();
  expect(definitions.slice(13)).toMatchObject([
    {
      commandId: "fallow_dead_code",
      executable: process.execPath,
      args: ["dead-code", "--format", "json", "--quiet"],
      risk: "project-code",
      globalSafe: false,
      applicability: "fallow-binary",
      binaryName: "fallow",
      acceptedExitCodes: [1],
      truncationDirection: "tail",
    },
    {
      commandId: "fallow_dupes",
      args: ["dupes", "--format", "json", "--quiet"],
    },
    {
      commandId: "fallow_health",
      args: ["health", "--format", "json", "--quiet"],
    },
    {
      commandId: "fallow_audit",
      args: ["audit", "--format", "json", "--quiet"],
      parameters: [{ name: "base", kind: "revision", required: true, mapping: "flag-value" }],
    },
    {
      commandId: "fallow_list_entry_points",
      args: ["list", "--entry-points", "--format", "json", "--quiet"],
    },
    {
      commandId: "fallow_list_boundaries",
      args: ["list", "--boundaries", "--format", "json", "--quiet"],
    },
  ]);
});

it("uses a stable Fallow launcher template without runtime audit parameters", () => {
  const definitions = getProjectCommandDefinitions().filter(
    (definition) => definition.applicability === "fallow-binary",
  );
  expect(definitions).toHaveLength(6);
  expect(
    definitions.every((definition) => definition.argvTemplate?.[0] === "<fallow-launcher>"),
  ).toBe(true);
  expect(
    definitions.find((definition) => definition.commandId === "fallow_audit")?.argvTemplate,
  ).toEqual(["<fallow-launcher>", "audit", "--format", "json", "--quiet"]);
  expect(
    definitions.every((definition) => !JSON.stringify(definition.argvTemplate).includes("<base>")),
  ).toBe(true);
});
