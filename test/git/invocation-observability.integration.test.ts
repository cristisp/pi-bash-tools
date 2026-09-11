import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import { afterEach, expect, it } from "vitest";

import type { GitInvocationRecord } from "../../src/observability/git-invocation.ts";
import { createGitStatusTool } from "../../src/tools/git/status/tool.ts";
import { createProjectCommandRepositoryStateReader } from "../../src/tools/project-command/repository-state.ts";
import {
  createGitIntegrationFixtures,
  gitIntegration,
  makeRealGitExec,
  rawGit,
} from "./integration-fixtures.ts";

const fixtures = createGitIntegrationFixtures();

afterEach(async () => {
  await fixtures.cleanup();
});

gitIntegration("git_status invocation observation with a real Git process", () => {
  it("records a readable workspace block with real head and dirty digest metadata", async () => {
    const repository = await fixtures.createRepository();
    const gitExec = makeRealGitExec();
    const records: GitInvocationRecord[] = [];
    const tool = createGitStatusTool(gitExec, {
      invocationRecorder: (record) => {
        records.push(record);
      },
      repositoryStateReader: createProjectCommandRepositoryStateReader(gitExec),
    });

    const result = await tool.execute("status-call", {}, undefined, undefined, {
      ...repository.context,
      sessionManager: { getSessionId: () => "integration-session" },
    });

    expect(result.details.repositoryRoot).toBe(await realpath(repository.directory));
    expect(records).toHaveLength(1);
    const record = records[0];
    if (record === undefined) throw new Error("expected one invocation record");
    const realHead = (await rawGit(repository.directory, ["rev-parse", "HEAD"])).trim();
    expect(record).toMatchObject({
      invocationFormatVersion: 1,
      tool: "git_status",
      sessionId: "integration-session",
      toolCallId: "status-call",
      reason: "completed",
      unchanged: false,
    });
    expect(record.aggregate.resultBytes).toBeGreaterThan(0);
    expect(record.repositoryState).toEqual({
      repositoryId: createHash("sha256")
        .update(await realpath(repository.directory), "utf8")
        .digest("hex"),
      head: realHead,
      dirtyDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      status: "readable",
    });
  });

  it("does not record without a session identity", async () => {
    const repository = await fixtures.createRepository();
    const gitExec = makeRealGitExec();
    const records: GitInvocationRecord[] = [];
    const tool = createGitStatusTool(gitExec, {
      invocationRecorder: (record) => {
        records.push(record);
      },
      repositoryStateReader: createProjectCommandRepositoryStateReader(gitExec),
    });

    await tool.execute("status-call", {}, undefined, undefined, repository.context);

    expect(records).toEqual([]);
  });

  it("classifies invalid requests and rethrows without changing behavior", async () => {
    const repository = await fixtures.createRepository();
    const gitExec = makeRealGitExec();
    const records: GitInvocationRecord[] = [];
    const tool = createGitStatusTool(gitExec, {
      invocationRecorder: (record) => {
        records.push(record);
      },
      repositoryStateReader: createProjectCommandRepositoryStateReader(gitExec),
    });

    await expect(
      tool.execute("status-call", { path: "../escape" }, undefined, undefined, {
        ...repository.context,
        sessionManager: { getSessionId: () => "session" },
      }),
    ).rejects.toThrow();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tool: "git_status",
      reason: "invalid-request",
      errorCode: "invalid-request",
      aggregate: { resultBytes: 0 },
    });
    expect(records[0]?.repositoryState).toBeUndefined();
  });

  it("records a degraded workspace block with a repository id when observation fails", async () => {
    const repository = await fixtures.createRepository();
    const gitExec = makeRealGitExec();
    const records: GitInvocationRecord[] = [];
    const tool = createGitStatusTool(gitExec, {
      invocationRecorder: (record) => {
        records.push(record);
      },
      repositoryStateReader: async () => undefined,
    });

    await tool.execute("status-call", {}, undefined, undefined, {
      ...repository.context,
      sessionManager: { getSessionId: () => "session" },
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.repositoryState).toEqual({
      repositoryId: createHash("sha256")
        .update(await realpath(repository.directory), "utf8")
        .digest("hex"),
      head: null,
      dirtyDigest: null,
      status: "degraded",
    });
  });
});
