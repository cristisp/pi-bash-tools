/* oxlint-disable typescript/no-unsafe-type-assertion */

import type { TSchema } from "typebox";
import { describe, expect, it, vi } from "vitest";

import type {
  GitInvocationRecord,
  GitInvocationToolName,
} from "../../src/observability/git-invocation.ts";
import {
  cancellationError,
  GitToolError,
  invalidGitRequest,
  invalidGitRequestShape,
} from "../../src/tools/git/execution.ts";
import { createInvalidRequestTracker } from "../../src/tools/git/invalid-request-tracker.ts";
import { observeGitInvocation } from "../../src/tools/git/invocation.ts";
import type { GitToolContext, GitToolExecute } from "../../src/tools/git/tool.ts";

function context(): GitToolContext {
  return {
    cwd: "/repo",
    signal: undefined,
    sessionManager: { getSessionId: () => "observability-session" },
  };
}

const anonymousContext: GitToolContext = { cwd: "/repo", signal: undefined };

function recordingExecute(onCall?: (params: unknown) => void) {
  return vi.fn(async (_toolCallId: string, params: unknown) => {
    onCall?.(params);
    return { content: [], details: { done: true } };
  }) as unknown as GitToolExecute<TSchema, { done: boolean }>;
}

function throwingExecute(error: Error) {
  return vi.fn(async () => {
    throw error;
  }) as unknown as GitToolExecute<TSchema, { done: boolean }>;
}

function observedWith(
  execute: GitToolExecute<TSchema, { done: boolean }>,
  records: GitInvocationRecord[],
  tracker: ReturnType<typeof createInvalidRequestTracker> | undefined,
) {
  return observeGitInvocation<TSchema, { done: boolean }>(
    {
      tool: "git_log",
      schemaHash: "schema-hash",
      invocationRecorder: (record) => {
        records.push(record);
      },
      ...(tracker === undefined ? {} : { retryInvalidationTracker: tracker }),
    },
    execute,
  );
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

  it("treats an empty optional field as absent and records the coercion", async () => {
    const received: unknown[] = [];
    const execute = recordingExecute((params) => received.push(params));
    const records: GitInvocationRecord[] = [];
    const observed = observedWith(execute, records, undefined);
    const request = { maxEntries: 5, revision: "" };

    await observed("call-1", request, undefined, undefined, context());

    expect(received[0]).toEqual({ maxEntries: 5 });
    expect(request).toEqual({ maxEntries: 5, revision: "" });
    expect(records[0]).toMatchObject({
      reason: "completed",
      coercions: ["revision:empty-string-omitted"],
    });
    expect(records[0]).not.toHaveProperty("retryInvalidation");
  });

  it("records no coercion when the request has no empty optional field", async () => {
    const execute = recordingExecute();
    const records: GitInvocationRecord[] = [];

    await observedWith(execute, records, undefined)(
      "call-1",
      { maxEntries: 5, revision: "main" },
      undefined,
      undefined,
      context(),
    );

    expect(records[0]).not.toHaveProperty("coercions");
  });

  it("rejects an identical repeat of a shape-deterministic failure without executing again", async () => {
    const execute = throwingExecute(invalidGitRequestShape("bad shape", "revision"));
    const records: GitInvocationRecord[] = [];
    const observed = observedWith(execute, records, createInvalidRequestTracker());

    await expect(
      observed("call-1", { revision: "bad" }, undefined, undefined, context()),
    ).rejects.toThrow(/bad shape/u);
    await expect(
      observed("call-2", { revision: "bad" }, undefined, undefined, context()),
    ).rejects.toMatchObject({ contract: { code: "unchanged-invalid-request" } });

    expect(execute).toHaveBeenCalledOnce();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ reason: "invalid-request", errorCode: "invalid-request" });
    expect(records[0]).not.toHaveProperty("retryInvalidation");
    expect(records[1]).toMatchObject({
      reason: "invalid-request",
      errorCode: "unchanged-invalid-request",
      retryInvalidation: "invalid-request-repeat",
    });
  });

  it("executes a changed request after a shape-deterministic failure", async () => {
    const execute = throwingExecute(invalidGitRequestShape("bad shape", "revision"));
    const records: GitInvocationRecord[] = [];
    const observed = observedWith(execute, records, createInvalidRequestTracker());

    await expect(
      observed("call-1", { revision: "bad" }, undefined, undefined, context()),
    ).rejects.toThrow(/bad shape/u);
    await expect(
      observed("call-2", { revision: "other" }, undefined, undefined, context()),
    ).rejects.toThrow(/bad shape/u);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(records[1]?.errorCode).toBe("invalid-request");
  });

  it("never invalidates a retry without session identity", async () => {
    const execute = throwingExecute(invalidGitRequestShape("bad shape", "revision"));
    const records: GitInvocationRecord[] = [];
    const observed = observedWith(execute, records, createInvalidRequestTracker());

    await expect(
      observed("call-1", { revision: "bad" }, undefined, undefined, anonymousContext),
    ).rejects.toThrow(/bad shape/u);
    await expect(
      observed("call-2", { revision: "bad" }, undefined, undefined, anonymousContext),
    ).rejects.toThrow(/bad shape/u);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(0);
  });

  it("never invalidates a retry after a transient failure", async () => {
    const execute = throwingExecute(new GitToolError("transient git failure"));
    const records: GitInvocationRecord[] = [];
    const observed = observedWith(execute, records, createInvalidRequestTracker());

    await expect(
      observed("call-1", { revision: "main" }, undefined, undefined, context()),
    ).rejects.toThrow(/transient git failure/u);
    await expect(
      observed("call-2", { revision: "main" }, undefined, undefined, context()),
    ).rejects.toThrow(/transient git failure/u);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(records.map((record) => record.retryInvalidation)).toEqual([undefined, undefined]);
  });

  it("never invalidates a retry after a cancellation", async () => {
    const execute = throwingExecute(cancellationError(true));
    const records: GitInvocationRecord[] = [];
    const observed = observedWith(execute, records, createInvalidRequestTracker());

    await expect(observed("call-1", {}, undefined, undefined, context())).rejects.toThrow(
      /cancelled/u,
    );
    await expect(observed("call-2", {}, undefined, undefined, context())).rejects.toThrow(
      /cancelled/u,
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(records.map((record) => record.reason)).toEqual(["cancelled", "cancelled"]);
  });

  it("never invalidates a retry after an unmarked invalid request", async () => {
    const execute = throwingExecute(
      invalidGitRequest("path is not a safe workspace-relative path", "path"),
    );
    const records: GitInvocationRecord[] = [];
    const observed = observedWith(execute, records, createInvalidRequestTracker());

    await expect(
      observed("call-1", { revision: "main" }, undefined, undefined, context()),
    ).rejects.toThrow(/not a safe workspace-relative path/u);
    await expect(
      observed("call-2", { revision: "main" }, undefined, undefined, context()),
    ).rejects.toThrow(/not a safe workspace-relative path/u);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(records[1]?.errorCode).toBe("invalid-request");
  });
});

describe("git invocation request fields", () => {
  async function captureRecord(
    tool: GitInvocationToolName,
    params: unknown,
    details: object,
  ): Promise<GitInvocationRecord | undefined> {
    const records: GitInvocationRecord[] = [];
    const observed = observeGitInvocation<TSchema, object>(
      {
        tool,
        schemaHash: "schema-hash",
        invocationRecorder: (record) => {
          records.push(record);
        },
      },
      async () => ({ content: [], details }),
    );
    await observed("call-1", params, undefined, undefined, context());
    return records[0];
  }

  it("records the effective git_diff mode and a requested maxBytes", async () => {
    const record = await captureRecord(
      "git_diff",
      { mode: "patch", maxBytes: 4_096 },
      { output: { truncated: false } },
    );

    expect(record?.mode).toBe("patch");
    expect(record?.maxBytes).toBe(4_096);
    expect(record?.truncated).toBe(false);
  });

  it("defaults the recorded git_diff mode to summary and omits an unset maxBytes", async () => {
    const record = await captureRecord("git_diff", {}, { output: { truncated: false } });

    expect(record?.mode).toBe("summary");
    expect(Object.hasOwn(record ?? {}, "maxBytes")).toBe(false);
  });

  it("records maxBytes for git_show and neither request field for other tools", async () => {
    const show = await captureRecord(
      "git_show",
      { revision: "HEAD", maxBytes: 8_192 },
      { output: { truncated: false } },
    );
    expect(show?.maxBytes).toBe(8_192);
    expect(Object.hasOwn(show ?? {}, "mode")).toBe(false);

    const status = await captureRecord("git_status", {}, { output: { truncated: false } });
    expect(Object.hasOwn(status ?? {}, "mode")).toBe(false);
    expect(Object.hasOwn(status ?? {}, "maxBytes")).toBe(false);
  });

  it("records the truncation flag and omits request fields on the error path", async () => {
    const truncatedRecords: GitInvocationRecord[] = [];
    const observed = observeGitInvocation<TSchema, { output: { truncated: boolean } }>(
      {
        tool: "git_diff",
        schemaHash: "schema-hash",
        invocationRecorder: (record) => {
          truncatedRecords.push(record);
        },
      },
      async () => ({ content: [], details: { output: { truncated: true } } }),
    );

    await observed("call-1", { mode: "summary" }, undefined, undefined, context());
    expect(truncatedRecords[0]?.truncated).toBe(true);

    const errorRecords: GitInvocationRecord[] = [];
    const failing = observeGitInvocation<TSchema, { output: { truncated: boolean } }>(
      {
        tool: "git_diff",
        schemaHash: "schema-hash",
        invocationRecorder: (record) => {
          errorRecords.push(record);
        },
      },
      async () => {
        throw new GitToolError("transient git failure");
      },
    );

    await expect(
      failing("call-2", { mode: "patch" }, undefined, undefined, context()),
    ).rejects.toThrow(/transient git failure/u);
    expect(Object.hasOwn(errorRecords[0] ?? {}, "mode")).toBe(false);
    expect(Object.hasOwn(errorRecords[0] ?? {}, "truncated")).toBe(false);
  });
});
