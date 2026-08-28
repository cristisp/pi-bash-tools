import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveRepository } from "../../src/tools/git/repository.ts";
import type { GitExec } from "../../src/tools/git/execution.ts";
import { createGitIntegrationFixtures, gitIntegration } from "./integration-fixtures.ts";

const cwd = process.cwd();
const fixtures = createGitIntegrationFixtures();

afterEach(() => fixtures.cleanup());

function result(stdout: string) {
  return { stdout, stderr: "", code: 0, killed: false };
}

function expectResolutionFailure(execution: Promise<unknown>) {
  return expect(execution).rejects.toMatchObject({
    contract: {
      code: "git-repository-resolution-failure",
      category: "IMPLEMENTATION_FAILURE",
      retryable: true,
      executed: true,
    },
    details: {
      category: "IMPLEMENTATION_FAILURE",
      executed: true,
    },
  });
}

it("reports an attempted Git execution when the repository root output is empty", async () => {
  let calls = 0;
  const exec: GitExec = async () => {
    calls += 1;
    return result("  \n");
  };

  await expectResolutionFailure(resolveRepository(exec, cwd));
  expect(calls).toBe(1);
});

it("reports an attempted Git execution when the repository root cannot be realpathed", async () => {
  let calls = 0;
  const missingRoot = join(cwd, ".bash-tools-missing-repository-root");
  const exec: GitExec = async () => {
    calls += 1;
    return result(`${missingRoot}\n`);
  };

  await expectResolutionFailure(resolveRepository(exec, cwd));
  expect(calls).toBe(1);
});

gitIntegration("Git repository resolution", () => {
  it("reports an attempted Git execution when the repository is outside the workspace", async () => {
    const repository = await fixtures.createRepository();
    const root = await realpath(repository.directory);
    const canonicalCwd = await realpath(cwd);
    expect(root).not.toBe(canonicalCwd);

    let calls = 0;
    const exec: GitExec = async () => {
      calls += 1;
      return result(`${root}\n`);
    };

    await expectResolutionFailure(resolveRepository(exec, cwd));
    expect(calls).toBe(1);
  });
});
