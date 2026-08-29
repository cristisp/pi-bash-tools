import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandIdentity } from "../../src/tools/policy/types.ts";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";
import type { ProjectCommandToolDefinition } from "../../src/tools/project-command/tool.ts";
import {
  getProjectCommandDefinition,
  projectCommandIdentity,
} from "../../src/tools/project-command/definitions.ts";
import { resolveProjectCommand } from "../../src/tools/project-command/resolution.ts";
import {
  createCatalogRequests,
  createCommandContext,
  createIntegrationFixture,
  createProjectCommandIntegrationScope,
  type CatalogRequest,
  writeProjectPolicy,
} from "./integration-fixtures.ts";

const scope = createProjectCommandIntegrationScope();

afterEach(scope.cleanup);

async function resolveCatalogIdentities(
  requests: readonly CatalogRequest[],
  projectPath: string,
): Promise<CommandIdentity[]> {
  return await Promise.all(
    requests.map(async (request) => {
      const definition = getProjectCommandDefinition(request.commandId);
      if (definition === undefined) throw new Error(`missing ${request.commandId} definition`);
      const resolved = await resolveProjectCommand(
        definition,
        projectPath,
        undefined,
        request.params,
      );
      return projectCommandIdentity(definition, resolved);
    }),
  );
}

async function createCatalogTool(
  fixture: { projectPath: string },
  userAgent: string,
  requests: readonly CatalogRequest[],
): Promise<ProjectCommandToolDefinition> {
  const identities = await resolveCatalogIdentities(requests, fixture.projectPath);
  const configPath = join(userAgent, "bash-tools.json");
  await writeProjectPolicy(configPath, fixture.projectPath, identities);
  return createProjectCommandToolForTesting({ configPath });
}

async function executeCatalogRequests(
  tool: ProjectCommandToolDefinition,
  requests: readonly CatalogRequest[],
  cwd: string,
): Promise<Map<string, unknown>> {
  const responseEntries = await Promise.all(
    requests.map(async (request) => {
      const response = await tool.execute(
        request.commandId,
        request.params,
        undefined,
        undefined,
        createCommandContext(cwd),
      );
      return [request.commandId, response.details] as const;
    }),
  );
  return new Map(responseEntries);
}

function expectCoreResponses(responses: Map<string, unknown>, projectPath: string): void {
  expect(responses.get("workspace_path")).toMatchObject({
    status: "success",
    stdout: { text: `${projectPath}\n` },
  });
  expect(responses.get("node_version")).toMatchObject({
    status: "success",
    stdout: { text: expect.stringMatching(/^v\d+(?:\.\d+){2}\n$/u) },
  });
}

function expectNodeResponses(responses: Map<string, unknown>, projectPath: string): void {
  expect(responses.get("node_project_info")).toMatchObject({
    status: "success",
    projectInfo: {
      packageManager: { manager: "npm", executableAvailable: true },
      applicableCommands: expect.arrayContaining([
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
      ]),
    },
  });
  expect(responses.get("node_deps_list")).toMatchObject({
    status: "success",
    exit: { code: 0 },
    resolvedCommand: expect.stringContaining(" ls --depth=0"),
  });
  for (const commandId of ["node_build", "node_typecheck"] as const) {
    expect(responses.get(commandId)).toMatchObject({
      status: "success",
      stdout: { text: expect.stringContaining(`${commandId.replace("node_", "")}:none\n`) },
    });
  }
  expect(responses.get("node_lint")).toMatchObject({
    status: "success",
    stdout: { text: expect.stringContaining("lint:fix\n") },
    resolvedCommand: expect.stringContaining(" run lint:fix"),
  });
  expect(responses.get("node_test")).toMatchObject({
    status: "success",
    stdout: { text: expect.stringContaining("test:coverage:none\n") },
    resolvedCommand: expect.stringContaining(" run test:coverage"),
  });
  expect(projectPath).toBeTruthy();
}

async function expectMutatingNodeResponses(
  responses: Map<string, unknown>,
  fixtureDirectory: string,
): Promise<void> {
  expect(responses.get("node_format")).toMatchObject({
    status: "success",
    stdout: { text: expect.stringContaining("format:write\n") },
    resolvedCommand: expect.stringContaining(" run format"),
  });
  expect(await readFile(join(fixtureDirectory, "format-target.txt"), "utf8")).toBe("after\n");
  expect(await readFile(join(fixtureDirectory, "lint-fix-target.txt"), "utf8")).toBe("after\n");
}

function expectFallowResponses(responses: Map<string, unknown>): void {
  for (const commandId of [
    "fallow_dead_code",
    "fallow_dupes",
    "fallow_health",
    "fallow_list_entry_points",
    "fallow_list_boundaries",
  ] as const) {
    const fallowCommand = commandId.startsWith("fallow_list")
      ? "list"
      : commandId.replace("fallow_", "").replaceAll("_", "-");
    expect(responses.get(commandId)).toMatchObject({
      status: "success",
      stdout: { text: expect.stringContaining(`"command":"${fallowCommand}"`) },
    });
  }
  expect(responses.get("fallow_audit")).toMatchObject({
    status: "nonzero",
    exit: { code: 1 },
  });
}

describe("project command catalog integration", () => {
  it("runs every practical catalog command against a real temporary fixture project", async () => {
    const { fixture, userAgent } = await createIntegrationFixture(
      scope,
      "bash-tools-node-project-integration-policy-",
    );
    const requests = createCatalogRequests();
    const tool = await createCatalogTool(fixture, userAgent, requests);
    const responses = await executeCatalogRequests(tool, requests, fixture.directory);

    expectCoreResponses(responses, fixture.projectPath);
    expectNodeResponses(responses, fixture.projectPath);
    await expectMutatingNodeResponses(responses, fixture.directory);
    expectFallowResponses(responses);
  });
});
