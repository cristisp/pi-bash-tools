import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "vitest";

import type { PackageManagerAvailability } from "../../../src/tools/project-command/resolution.ts";
import { createTestScope, type TestScope } from "../test-scope.ts";

export const availablePackageManagers: PackageManagerAvailability = {
  npm: true,
  pnpm: true,
  bun: true,
  yarn: true,
};

export type ResolutionTestScope = TestScope;

export function createResolutionTestScope(): ResolutionTestScope {
  return createTestScope();
}

export function expectResolutionError(
  operation: Promise<unknown>,
  stage: string,
  code: string,
): Promise<void> {
  return expect(operation).rejects.toMatchObject({
    name: "ProjectCommandResolutionError",
    stage,
    code,
    details: { stage, code },
  });
}

export async function createProjectDirectory(scope: ResolutionTestScope): Promise<string> {
  return scope.track(await mkdtemp(join(tmpdir(), "bash-tools-project-command-resolution-")));
}

export async function createBinaryProject(scope: ResolutionTestScope): Promise<{
  directory: string;
  nodeModules: string;
  binDirectory: string;
}> {
  const directory = await createProjectDirectory(scope);
  const nodeModules = join(directory, "node_modules");
  const binDirectory = join(nodeModules, ".bin");
  await mkdir(binDirectory, { recursive: true });
  return { directory, nodeModules, binDirectory };
}
