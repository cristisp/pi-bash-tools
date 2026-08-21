import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandIdentity } from "../../src/tools/policy/types.ts";
import type { BuiltInProjectCommandDefinitions } from "../../src/tools/project-command/definitions.ts";
import type { ProjectCommandInputFor } from "../../src/tools/project-command/schema.ts";
import type { ProjectCommandToolDefinition } from "../../src/tools/project-command/tool.ts";
import { createTestScope, type TestScope } from "./test-scope.ts";
import { createNodeProjectIntegrationFixture } from "./node-project.integration-fixtures.ts";

export type ProjectCommandIntegrationScope = TestScope;

export function createProjectCommandIntegrationScope(): ProjectCommandIntegrationScope {
  return createTestScope();
}

export async function createIntegrationDirectory(
  scope: ProjectCommandIntegrationScope,
  prefix: string,
): Promise<string> {
  return await realpath(scope.track(await mkdtemp(join(tmpdir(), prefix))));
}

export function createCommandContext(cwd: string, mode: "json" | "print" = "print") {
  return {
    cwd,
    mode,
    hasUI: false,
    signal: undefined,
    ui: { select: async () => undefined },
  } as const;
}

export async function writeProjectPolicy(
  configPath: string,
  projectPath: string,
  allow: readonly CommandIdentity[],
): Promise<void> {
  await writeFile(
    configPath,
    JSON.stringify({
      version: 2,
      environment: { version: 1 },
      projectCommands: {
        version: 1,
        global: { allow: [], deny: [] },
        projects: { [projectPath]: { allow, deny: [] } },
      },
    }),
  );
}

export async function createIntegrationFixture(
  scope: ProjectCommandIntegrationScope,
  prefix: string,
) {
  const fixture = await createNodeProjectIntegrationFixture();
  scope.track(fixture.directory);
  const userAgent = await createIntegrationDirectory(scope, prefix);
  return { fixture, userAgent };
}

export function createCatalogRequests() {
  return [
    { commandId: "workspace_path", params: { commandId: "workspace_path" } },
    { commandId: "node_version", params: { commandId: "node_version" } },
    { commandId: "node_project_info", params: { commandId: "node_project_info" } },
    { commandId: "node_deps_list", params: { commandId: "node_deps_list" } },
    {
      commandId: "node_test",
      params: { commandId: "node_test", paths: ["fixture-runner.js"] },
    },
    { commandId: "node_build", params: { commandId: "node_build" } },
    { commandId: "node_lint", params: { commandId: "node_lint" } },
    { commandId: "node_lint_fix", params: { commandId: "node_lint_fix" } },
    { commandId: "node_typecheck", params: { commandId: "node_typecheck" } },
    { commandId: "node_format_check", params: { commandId: "node_format_check" } },
    { commandId: "node_format_write", params: { commandId: "node_format_write" } },
    { commandId: "fallow_dead_code", params: { commandId: "fallow_dead_code" } },
    { commandId: "fallow_dupes", params: { commandId: "fallow_dupes" } },
    { commandId: "fallow_health", params: { commandId: "fallow_health" } },
    { commandId: "fallow_audit", params: { commandId: "fallow_audit", base: "HEAD~1" } },
    {
      commandId: "fallow_list_entry_points",
      params: { commandId: "fallow_list_entry_points" },
    },
    { commandId: "fallow_list_boundaries", params: { commandId: "fallow_list_boundaries" } },
  ] as const;
}

export type CatalogRequest = ReturnType<typeof createCatalogRequests>[number];

export async function executeCommand(
  tool: ProjectCommandToolDefinition,
  commandId: string,
  parameters: ProjectCommandInputFor<BuiltInProjectCommandDefinitions>,
  cwd: string,
  mode: "json" | "print" = "print",
) {
  return await tool.execute(
    commandId,
    parameters,
    undefined,
    undefined,
    createCommandContext(cwd, mode),
  );
}
