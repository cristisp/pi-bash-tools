/* oxlint-disable typescript/no-unsafe-type-assertion */

import type { TSchema } from "typebox";
import { describe, expect, it, vi } from "vitest";

import type { GitInvocationRecord } from "../../src/observability/git-invocation.ts";
import { observeGitInvocation } from "../../src/tools/git/invocation.ts";
import type { GitToolContext, GitToolExecute } from "../../src/tools/git/tool.ts";

function context(): GitToolContext {
  return {
    cwd: "/repo",
    signal: undefined,
    sessionManager: { getSessionId: () => "observability-session" },
  };
}

describe("git invocation observation", () => {
  it("keeps the tool result unchanged and emits a degraded record when result details are not serializable", async () => {
    const details = {
      toJSON(): never {
        throw new Error("unserializable details");
      },
    };
    const result = { content: [{ type: "text", text: "unchanged" }], details } as never;
    const execute = vi.fn(async () => result) as unknown as GitToolExecute<TSchema, typeof details>;
    const records: GitInvocationRecord[] = [];
    const observed = observeGitInvocation(
      {
        tool: "git_status",
        schemaHash: "schema-hash",
        invocationRecorder: (record) => {
          records.push(record);
        },
      },
      execute,
    );

    await expect(observed("call-1", {}, undefined, undefined, context())).resolves.toBe(result);

    expect(execute).toHaveBeenCalledOnce();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tool: "git_status",
      sessionId: "observability-session",
      toolCallId: "call-1",
      reason: "completed",
      unchanged: false,
    });
    expect(records[0]?.aggregate).toEqual({ resultBytes: 0 });
  });

  it("keeps the tool result unchanged and drops the workspace block when shared state derivation throws", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "unchanged" }],
      details: { done: true },
    })) as unknown as GitToolExecute<TSchema, { done: boolean }>;
    const records: GitInvocationRecord[] = [];
    const observed = observeGitInvocation(
      {
        tool: "git_diff",
        schemaHash: "schema-hash",
        invocationRecorder: (record) => {
          records.push(record);
        },
        repositoryStateReader: async () =>
          ({
            repositoryIdentity: 7,
            head: "head",
            dirtyFilesDigest: "digest",
          }) as never,
      },
      execute,
    );

    const result = await observed("call-2", {}, undefined, undefined, context());

    expect(result.details).toEqual({ done: true });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tool: "git_diff",
      sessionId: "observability-session",
      toolCallId: "call-2",
      reason: "completed",
    });
    expect(records[0]?.repositoryState).toBeUndefined();
  });
});
