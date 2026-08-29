import { readFile, realpath, stat } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import {
  fingerprintProjectCommandDefinition,
  getProjectCommandDefinition,
  type ProjectCommandDefinition,
} from "../../../src/tools/project-command/definitions.ts";
import {
  readNodeProjectInfo,
  resolveNodeProjectCommand,
} from "../../../src/tools/project-command/node.ts";
import { nodePackageScriptKey } from "../../../src/tools/project-command/node/package-script.ts";
import { createNodeProjectRelevantInputDiscovery } from "../../../src/tools/project-command/node/relevant-inputs.ts";
import { createNodeProject, createNodeTestScope } from "./test-fixtures.ts";

const scope = createNodeTestScope();

afterEach(scope.cleanup);

function definition(commandId: string): ProjectCommandDefinition {
  const result = getProjectCommandDefinition(commandId);
  if (result === undefined) throw new Error(`missing ${commandId} definition`);
  return result;
}

const resolutionFileSystem = {
  fileSystem: {
    readFile,
    stat,
    realpath: async (path: string) => await realpath(path),
  },
};

async function createScriptProject(scripts: Record<string, string>): Promise<string> {
  return await createNodeProject(scope, {
    packageManager: "npm@10.0.0",
    scripts,
  });
}

it("maps node_lint variant compact to the exact lint:compact package script", async () => {
  const directory = await createScriptProject({
    lint: "node lint.js",
    "lint:compact": "node lint.js --compact",
  });
  const resolved = await resolveNodeProjectCommand(
    definition("node_lint"),
    directory,
    { commandId: "node_lint", variant: "compact" },
    resolutionFileSystem,
  );
  expect(resolved.args).toEqual(["run", "lint:compact"]);
  expect(resolved.scriptKey).toBe("lint:compact");
  expect(resolved.script).toBe("node lint.js --compact");
});

it("reports family commands when only validated variant scripts exist", async () => {
  const directory = await createScriptProject({
    "lint:errors": "node lint.js --errors",
    "test:unit:ci": "node test.js --unit --ci",
    "format:check:ci": "node format.js --check --ci",
  });
  await expect(readNodeProjectInfo(directory)).resolves.toMatchObject({
    applicableCommands: expect.arrayContaining(["node_lint", "node_test", "node_format"]),
  });
});

it("maps arbitrary validated family variants to their exact package scripts", async () => {
  const directory = await createScriptProject({
    "lint:errors": "node lint.js --errors",
    "test:unit:ci": "node test.js --unit --ci",
    "format:check:ci": "node format.js --check --ci",
  });
  const lint = await resolveNodeProjectCommand(
    definition("node_lint"),
    directory,
    { commandId: "node_lint", variant: "errors" },
    resolutionFileSystem,
  );
  const test = await resolveNodeProjectCommand(
    definition("node_test"),
    directory,
    { commandId: "node_test", variant: "unit:ci" },
    resolutionFileSystem,
  );
  const format = await resolveNodeProjectCommand(
    definition("node_format"),
    directory,
    { commandId: "node_format", variant: "check:ci" },
    resolutionFileSystem,
  );
  expect(lint.scriptKey).toBe("lint:errors");
  expect(test.scriptKey).toBe("test:unit:ci");
  expect(format.scriptKey).toBe("format:check:ci");
});

it("maps node_test variant unit to the exact test:unit package script", async () => {
  const directory = await createScriptProject({
    test: "node test.js",
    "test:unit": "node test.js --unit",
  });
  const resolved = await resolveNodeProjectCommand(
    definition("node_test"),
    directory,
    { commandId: "node_test", variant: "unit" },
    resolutionFileSystem,
  );
  expect(resolved.args).toEqual(["run", "test:unit"]);
  expect(resolved.scriptKey).toBe("test:unit");
});

it("resolves bare and validated format package scripts", async () => {
  const directory = await createScriptProject({
    format: "node format.js",
    "format:check": "node format.js --check",
    "format:check:ci": "node format.js --check --ci",
  });
  const nodeFormat = definition("node_format");

  const bare = await resolveNodeProjectCommand(nodeFormat, directory, {
    commandId: "node_format",
  });
  expect(bare.args).toEqual(["run", "format"]);
  const check = await resolveNodeProjectCommand(
    nodeFormat,
    directory,
    { commandId: "node_format", variant: "check" },
    resolutionFileSystem,
  );
  expect(check.args).toEqual(["run", "format:check"]);

  const resolved = await resolveNodeProjectCommand(
    nodeFormat,
    directory,
    { commandId: "node_format", variant: "check:ci" },
    resolutionFileSystem,
  );
  expect(resolved.args).toEqual(["run", "format:check:ci"]);
  expect(resolved.scriptKey).toBe("format:check:ci");
});

it("accepts project-defined specialized suffixes through generic variant paths", async () => {
  const directory = await createScriptProject({
    lint: "node lint.js",
    "lint:fix": "node lint-fix.js",
    test: "node test.js",
    "test:coverage": "node coverage.js",
    "test:e2e": "node e2e.js",
  });
  const options = resolutionFileSystem;
  await expect(
    resolveNodeProjectCommand(
      definition("node_lint"),
      directory,
      { commandId: "node_lint", variant: "fix" },
      options,
    ),
  ).resolves.toMatchObject({ scriptKey: "lint:fix" });
  await expect(
    resolveNodeProjectCommand(
      definition("node_test"),
      directory,
      { commandId: "node_test", variant: "coverage" },
      options,
    ),
  ).resolves.toMatchObject({ scriptKey: "test:coverage" });
  await expect(
    resolveNodeProjectCommand(
      definition("node_test"),
      directory,
      { commandId: "node_test", variant: "e2e" },
      options,
    ),
  ).resolves.toMatchObject({ scriptKey: "test:e2e" });
});

it("includes the selected variant script in the authorization identity", async () => {
  const nodeLint = definition("node_lint");
  const baseResolved = {
    executable: "npm",
    args: ["run", "lint"],
    fingerprintArgs: nodeLint.argvTemplate,
  };
  const variantResolved = {
    executable: "npm",
    args: ["run", "lint:compact"],
    fingerprintArgs: nodeLint.argvTemplate,
    scriptKey: "lint:compact",
  };
  expect(fingerprintProjectCommandDefinition(nodeLint, baseResolved)).not.toBe(
    fingerprintProjectCommandDefinition(nodeLint, variantResolved),
  );
  expect(fingerprintProjectCommandDefinition(nodeLint, baseResolved)).toBe(
    fingerprintProjectCommandDefinition(nodeLint, {
      ...baseResolved,
      scriptKey: "lint",
    }),
  );
});

it("keys the relevant-input script hash by the selected variant script", async () => {
  const projectPath = await createScriptProject({
    lint: "node lint.js",
    "lint:compact": "node lint.js --compact",
  });
  const result = await createNodeProjectRelevantInputDiscovery({
    fileSystem: { readFile, stat },
  }).discover({
    definition: definition("node_lint"),
    projectPath,
    parameters: { commandId: "node_lint", variant: "compact" },
  });
  expect(result.status).toBe("complete");
  if (result.status !== "complete") return;
  expect(result.inputs.values).toEqual([
    { kind: "value", name: "package-script-hash:lint:compact", value: expect.any(String) },
  ]);
});

it("marks relevant-input discovery incomplete when a selected script is missing", async () => {
  const projectPath = await createScriptProject({ lint: "node lint.js" });
  const result = await createNodeProjectRelevantInputDiscovery({
    fileSystem: { readFile, stat },
  }).discover({
    definition: definition("node_lint"),
    projectPath,
    parameters: { commandId: "node_lint", variant: "compact" },
  });
  expect(result).toMatchObject({ status: "incomplete", reason: "missing-package-script" });
  const formatInputs = await createNodeProjectRelevantInputDiscovery({
    fileSystem: { readFile, stat },
  }).discover({
    definition: definition("node_format"),
    projectPath,
    parameters: { commandId: "node_format" },
  });
  expect(formatInputs).toMatchObject({ status: "incomplete", reason: "missing-package-script" });
});

it("resolves only exact validated script keys through the shared variant helper", () => {
  const nodeLint = definition("node_lint");
  expect(nodePackageScriptKey(nodeLint, { commandId: "node_lint" })).toBe("lint");
  expect(nodePackageScriptKey(nodeLint, { commandId: "node_lint", variant: "errors" })).toBe(
    "lint:errors",
  );
  expect(nodePackageScriptKey(nodeLint, { commandId: "node_lint", variant: "fix" })).toBe(
    "lint:fix",
  );
  const nodeFormat = definition("node_format");
  expect(nodePackageScriptKey(nodeFormat, { commandId: "node_format" })).toBe("format");
  expect(nodePackageScriptKey(nodeFormat, { commandId: "node_format", variant: "check:ci" })).toBe(
    "format:check:ci",
  );
});

it("keeps variant-capable commands non-cacheable and mutating where the base mutates", () => {
  expect(definition("node_lint").reusePolicy).toBe("never");
  expect(definition("node_test").reusePolicy).toBe("never");
  const nodeFormat = definition("node_format");
  expect(nodeFormat.reusePolicy).toBe("never");
  expect(nodeFormat.mutatesWorkspace).toBe(true);
  expect(nodeFormat.globalSafe).toBe(false);
});
