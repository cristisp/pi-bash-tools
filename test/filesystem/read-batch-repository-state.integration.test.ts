import { createHash } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import type { ReadBatchInvocationRecord } from "../../src/observability/read-batch-invocation.ts";
import { createReadBatchToolForTesting } from "../../src/tools/filesystem/read-batch-tool.ts";
import { createProjectCommandRepositoryStateReader } from "../../src/tools/project-command/repository-state.ts";
import {
  createGitIntegrationFixtures,
  gitIntegration,
  makeRealGitExec,
  rawGit,
} from "../git/integration-fixtures.ts";

const fixtures = createGitIntegrationFixtures();

afterEach(async () => {
  await fixtures.cleanup();
});

gitIntegration("read_batch repository-state observation with a real Git process", () => {
  it("records a readable workspace block with real head and dirty digest metadata", async () => {
    const repository = await fixtures.createRepository();
    const gitExec = makeRealGitExec();
    const configPath = join(await realpath(repository.directory), "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const records: ReadBatchInvocationRecord[] = [];
    const tool = createReadBatchToolForTesting({
      configPath,
      gitExec,
      invocationRecorder: (record) => {
        records.push(record);
      },
      repositoryStateReader: createProjectCommandRepositoryStateReader(gitExec),
    });

    const result = await tool.execute(
      "call-1",
      { paths: [{ path: "README.md" }] },
      undefined,
      undefined,
      {
        ...repository.context,
        mode: "print",
        hasUI: false,
        ui: { select: async () => undefined },
        sessionManager: { getSessionId: () => "integration-session" },
      },
    );

    expect(result.details.results[0]).toMatchObject({ path: "README.md", unchanged: false });
    expect(records).toHaveLength(1);
    const record = records[0];
    if (record === undefined) throw new Error("expected one invocation record");
    const expectedHead = (await rawGit(repository.directory, ["rev-parse", "HEAD"])).trim();
    expect(record.repositoryState).toEqual({
      repositoryId: createHash("sha256")
        .update(await realpath(repository.directory), "utf8")
        .digest("hex"),
      head: expectedHead,
      dirtyDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      status: "readable",
    });
  });
});
