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
  expect(
    definitions.every((definition) => definition.namespace === PROJECT_COMMAND_NAMESPACE),
  ).toBe(true);
});

it("defines a result-reuse policy for every built-in command", () => {
  const definitions = getProjectCommandDefinitions();
  expect(definitions.every((definition) => definition.reusePolicy !== undefined)).toBe(true);
  expect(definitions.map((definition) => definition.reusePolicy)).toEqual([
    "static",
    "static",
    ...Array.from({ length: 13 }, () => "never"),
  ]);
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
  expect(definitions.slice(2, 9)).toMatchObject([
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
      scriptVariantFamily: "test",
      truncationDirection: "tail",
      environmentProfile: "node-v1",
    },
    { commandId: "node_build", fixedScriptKey: "build" },
    { commandId: "node_lint", fixedScriptKey: "lint", scriptVariantFamily: "lint" },
    { commandId: "node_typecheck", fixedScriptKey: "typecheck" },
    {
      commandId: "node_format",
      risk: "project-code",
      globalSafe: false,
      fixedScriptKey: "format",
      scriptVariantFamily: "format",
      mutatesWorkspace: true,
    },
  ]);
});

it("describes the built-in Fallow command policies", () => {
  const definitions = getProjectCommandDefinitions();
  expect(definitions.slice(9)).toMatchObject([
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
