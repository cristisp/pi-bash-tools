import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestScope, type TestScope } from "../test-scope.ts";

export type NodeTestScope = TestScope;

export function createNodeTestScope(): NodeTestScope {
  return createTestScope();
}

export async function createNodeProject(
  scope: NodeTestScope,
  manifest: unknown,
  prefix = "bash-tools-node-",
): Promise<string> {
  const directory = scope.track(await mkdtemp(join(tmpdir(), prefix)));
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  return await realpath(directory);
}
