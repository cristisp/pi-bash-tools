import { realpath, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import {
  getProjectCommandDefinition,
  projectCommandIdentity,
} from "../../src/tools/project-command/definitions.ts";
import { cleanupProjectCommandFixtures, context, fixture } from "./tool-test-fixtures.ts";
import { resolveFixedProjectCommand } from "../../src/tools/project-command/resolution.ts";
import type { ResolvedProjectCommand } from "../../src/tools/project-command/resolution/types.ts";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";

afterEach(cleanupProjectCommandFixtures);

async function authorize(
  fixtureData: { readonly directory: string; readonly configPath: string },
  definition: NonNullable<ReturnType<typeof getProjectCommandDefinition>>,
  resolved: ResolvedProjectCommand,
): Promise<string> {
  const projectPath = await realpath(fixtureData.directory);
  await writeFile(
    fixtureData.configPath,
    JSON.stringify({
      version: 2,
      environment: { version: 1 },
      projectCommands: {
        version: 1,
        global: { allow: [], deny: [] },
        projects: {
          [projectPath]: { allow: [projectCommandIdentity(definition, resolved)], deny: [] },
        },
      },
    }),
  );
  return projectPath;
}

it("returns Fallow findings with exit code one as normal command data", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("fallow_health");
  if (definition === undefined) throw new Error("missing fallow_health definition");
  const resolved = {
    ...resolveFixedProjectCommand(definition),
    executable: process.execPath,
    args: ["/project/node_modules/fallow/bin/fallow", ...definition.args],
    fingerprintArgs: definition.argvTemplate,
  } satisfies ResolvedProjectCommand;
  await authorize(fixtureData, definition, resolved);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    resolver: async () => resolved,
    executor: async () => ({
      status: "nonzero" as const,
      exit: { code: 1, signal: null },
      timedOut: false,
      cancelled: false,
      stdout: {
        text: '{"kind":"health","findings":[{}]}',
        truncated: false,
        totalBytes: 34,
        totalLines: 1,
      },
      stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    }),
  });
  const response = await tool.execute(
    "fallow-health",
    { commandId: "fallow_health" },
    undefined,
    undefined,
    context(fixtureData.directory),
  );
  expect(response.details).toMatchObject({
    commandId: "fallow_health",
    status: "nonzero",
    exit: { code: 1, signal: null },
    stdout: { text: '{"kind":"health","findings":[{}]}' },
    resolvedCommand: expect.stringContaining("health --format json --quiet"),
    parameters: {},
  });
  expect(response.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining('"resolvedCommand":"'),
  });
  expect(response.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining('"parameters":{}'),
  });
});

it("keeps exit code two as a Fallow execution failure", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("fallow_health");
  if (definition === undefined) throw new Error("missing fallow_health definition");
  const resolved = {
    ...resolveFixedProjectCommand(definition),
    executable: process.execPath,
    args: ["/project/node_modules/fallow/bin/fallow", ...definition.args],
    fingerprintArgs: definition.argvTemplate,
  } satisfies ResolvedProjectCommand;
  await authorize(fixtureData, definition, resolved);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    resolver: async () => resolved,
    executor: async () => ({
      status: "nonzero" as const,
      exit: { code: 2, signal: null },
      timedOut: false,
      cancelled: false,
      stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
      stderr: { text: "invalid options", truncated: false, totalBytes: 15, totalLines: 1 },
    }),
  });
  await expect(
    tool.execute(
      "fallow-health",
      { commandId: "fallow_health" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  ).rejects.toMatchObject({
    message: expect.stringMatching(
      /status: nonzero.*commandId: fallow_health.*resolvedCommand: .*health --format json --quiet.*parameters: \{\}.*exit: code 2.*stderr: "invalid options"/u,
    ),
    details: {
      commandId: "fallow_health",
      status: "nonzero",
      resolvedCommand: expect.stringContaining("health --format json --quiet"),
      parameters: {},
      exit: { code: 2, signal: null },
      stderr: { text: "invalid options" },
    },
  });
});

it("includes timeout diagnostics with resolved parameters and stdout fallback", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("fallow_audit");
  if (definition === undefined) throw new Error("missing fallow_audit definition");
  const resolved = {
    ...resolveFixedProjectCommand(definition),
    executable: "/bin/fallow",
    args: ["audit", "--format", "json", "--quiet", "--base", "HEAD~1"],
    effectiveParameters: { base: "HEAD~1" },
  } satisfies ResolvedProjectCommand;
  await authorize(fixtureData, definition, resolved);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    resolver: async () => resolved,
    executor: async () => ({
      status: "timeout" as const,
      exit: { code: null, signal: "SIGTERM" },
      timedOut: true,
      cancelled: false,
      stdout: { text: "diagnostic output", truncated: false, totalBytes: 16, totalLines: 1 },
      stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    }),
  });
  await expect(
    tool.execute(
      "fallow-audit",
      { commandId: "fallow_audit", base: "HEAD~1" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  ).rejects.toMatchObject({
    message: expect.stringMatching(
      /status: timeout.*reason: the command timed out.*commandId: fallow_audit.*resolvedCommand: \/bin\/fallow audit --format json --quiet --base HEAD~1.*parameters: \{"base":"HEAD~1"\}.*exit: signal SIGTERM.*stdout: "diagnostic output"/u,
    ),
    details: {
      status: "timeout",
      commandId: "fallow_audit",
      resolvedCommand: "/bin/fallow audit --format json --quiet --base HEAD~1",
      parameters: { base: "HEAD~1" },
      exit: { code: null, signal: "SIGTERM" },
      stdout: { text: "diagnostic output" },
    },
  });
});

it("returns bounded execution details and marks execution cancellation as abort", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) throw new Error("missing workspace_path definition");
  const resolved = resolveFixedProjectCommand(definition);
  await authorize(fixtureData, definition, resolved);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    executor: async () => ({
      status: "cancelled" as const,
      exit: { code: null, signal: "SIGTERM" },
      timedOut: false,
      cancelled: true,
      stdout: { text: "partial", truncated: true, totalBytes: 100, totalLines: 2 },
      stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    }),
  });
  await expect(
    tool.execute(
      "1",
      { commandId: "workspace_path" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  ).rejects.toMatchObject({
    name: "AbortError",
    details: { commandId: "workspace_path", cancelled: true },
  });
});
