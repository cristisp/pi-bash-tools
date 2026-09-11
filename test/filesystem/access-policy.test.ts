import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";

import { createAuthorizationRetryTracker } from "../../src/tools/authorization-retry.ts";
import {
  createFilesystemAccessPolicyInterceptor,
  type FilesystemAccessPolicyContext,
} from "../../src/tools/filesystem/access-policy.ts";
import { diagnoseFilesystemEdits } from "../../src/tools/filesystem/edit-diagnostics.ts";
import {
  createReadBatchToolForTesting,
  type ReadBatchToolContext,
} from "../../src/tools/filesystem/read-batch-tool.ts";
import { createPolicyStoreForTesting } from "../../src/tools/policy/store.ts";
import { createPolicyTestFixtures } from "../policy/test-fixtures.ts";

const fixtures = createPolicyTestFixtures();

afterEach(async () => {
  vi.useRealTimers();
  await fixtures.cleanup();
});

function context(
  cwd: string,
  overrides: Partial<Pick<FilesystemAccessPolicyContext, "mode" | "hasUI" | "signal">> & {
    select?: FilesystemAccessPolicyContext["ui"]["select"];
  } = {},
): FilesystemAccessPolicyContext {
  return {
    cwd,
    mode: overrides.mode ?? "print",
    hasUI: overrides.hasUI ?? false,
    signal: overrides.signal,
    ui: { select: overrides.select ?? (async () => undefined) },
  };
}

function event(
  toolName: "read" | "write" | "edit" | "ls" | "find" | "grep",
  path: string,
): ToolCallEvent {
  if (toolName === "grep") {
    return {
      type: "tool_call",
      toolCallId: "1",
      toolName,
      input: { pattern: "needle", path },
    };
  }
  if (toolName === "find") {
    return {
      type: "tool_call",
      toolCallId: "1",
      toolName,
      input: { pattern: "*", path },
    };
  }
  if (toolName === "write") {
    return {
      type: "tool_call",
      toolCallId: "1",
      toolName,
      input: { path, content: "content" },
    };
  }
  if (toolName === "edit") {
    return {
      type: "tool_call",
      toolCallId: "1",
      toolName,
      input: { path, edits: [{ oldText: "old", newText: "new" }] },
    };
  }
  return {
    type: "tool_call",
    toolCallId: "1",
    toolName,
    input: { path },
  };
}

it.each(["read", "write", "edit", "ls", "find", "grep"] as const)(
  "%s is governed by the filesystem access-policy interceptor",
  async (toolName) => {
    const directory = await fixtures.createDirectory();
    const outside = await fixtures.createDirectory();
    const configPath = join(await realpath(directory), "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const policy = createPolicyStoreForTesting({ configPath });
    const intercept = createFilesystemAccessPolicyInterceptor(policy);

    const result = await intercept(event(toolName, outside), context(directory));

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("Tool call blocked by access policy");
  },
);

it("blocks unknown paths without eligible UI and reports the policy reason", async () => {
  const directory = await fixtures.createDirectory();
  const outside = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const intercept = createFilesystemAccessPolicyInterceptor(policy);

  const result = await intercept(event("grep", outside), context(directory));

  expect(result).toEqual({
    block: true,
    reason: expect.stringContaining("Tool call blocked by access policy"),
  });
  expect(result?.terminate).toBeUndefined();
});

it("persists an approved project path and allows descendants", async () => {
  const directory = await fixtures.createDirectory();
  const outside = await fixtures.createDirectory();
  const child = join(outside, "child");
  await mkdir(child);
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const select = vi.fn(async () => "Allow for this project");
  const intercept = createFilesystemAccessPolicyInterceptor(policy);
  const approvalContext = context(directory, { mode: "tui", hasUI: true, select });

  expect(await intercept(event("find", outside), approvalContext)).toBeUndefined();
  expect(await intercept(event("grep", child), approvalContext)).toBeUndefined();
  expect(select).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
    version: 4,
    filesystem: {
      projects: {
        [await realpath(directory)]: {
          allowRead: [await realpath(outside)],
          allowWrite: [],
          denyRead: [],
          denyWrite: [],
        },
      },
    },
  });
});

it("blocks a policy denial without terminating the agent", async () => {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  const canonicalDirectory = await realpath(directory);
  await writeFile(
    configPath,
    JSON.stringify({
      version: 4,
      environment: { version: 1 },
      projectCommands: { version: 1 },
      filesystem: {
        version: 2,
        global: { allowRead: [], allowWrite: [], denyRead: [canonicalDirectory], denyWrite: [] },
        projects: {},
      },
    }),
  );
  const policy = createPolicyStoreForTesting({ configPath });
  const intercept = createFilesystemAccessPolicyInterceptor(policy);

  const result = await intercept(event("ls", directory), context(directory));

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("denied by the global policy rule");
  expect(result?.reason).toContain('"code":"policy-denied"');
  expect(result?.reason).toContain('"category":"BLOCKED"');
  expect(result?.reason).toContain('"ruleKind":"filesystem-deny-global"');
  expect(result?.reason).toContain('"authorizedRoots":[]');
  expect(result?.terminate).toBeUndefined();
});

it("auto-denies and persists a project rule when approval times out", async () => {
  vi.useFakeTimers();
  const directory = await fixtures.createDirectory();
  const outside = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1, confirmationTimeoutMs: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const intercept = createFilesystemAccessPolicyInterceptor(policy);
  let resolveSelectEntered!: () => void;
  const selectEntered = new Promise<void>((resolve) => {
    resolveSelectEntered = resolve;
  });
  const select = vi.fn(() => {
    resolveSelectEntered();
    return new Promise<string | undefined>(() => undefined);
  });

  const pending = intercept(
    event("grep", outside),
    context(directory, {
      mode: "rpc",
      hasUI: true,
      select,
    }),
  );
  await selectEntered;
  await vi.advanceTimersByTimeAsync(2);
  const result = await pending;

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("confirmation timed out");
  expect(result?.terminate).toBeUndefined();
  expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
    version: 4,
    filesystem: {
      projects: {
        [await realpath(directory)]: {
          allowRead: [],
          allowWrite: [],
          denyRead: [await realpath(outside)],
          denyWrite: [],
        },
      },
    },
  });
});

it("implicitly allows read, write, and edit paths under the active workspace", async () => {
  const directory = await fixtures.createDirectory();
  const child = join(directory, "child");
  await mkdir(child);
  const file = join(child, "file.txt");
  await writeFile(file, "old");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const intercept = createFilesystemAccessPolicyInterceptor(policy);

  expect(await intercept(event("read", file), context(directory))).toBeUndefined();
  expect(
    await intercept(event("write", join(child, "new.txt")), context(directory)),
  ).toBeUndefined();
  expect(await intercept(event("edit", file), context(directory))).toBeUndefined();
  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ version: 1 });
});

it("reports bounded edit match diagnostics before the host mutates", async () => {
  const directory = await fixtures.createDirectory();
  const file = join(directory, "edit.txt");
  await writeFile(file, "first\n  target\nlast\n");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const intercept = createFilesystemAccessPolicyInterceptor(policy);

  const missing = await intercept(
    {
      type: "tool_call",
      toolCallId: "edit-missing",
      toolName: "edit",
      input: { path: file, edits: [{ oldText: "missing", newText: "new" }] },
    },
    context(directory),
  );
  expect(missing?.reason).toContain('"code":"edit-no-match"');
  expect(missing?.reason).toContain('"matchCount":0');
  expect(missing?.reason).toContain('"line":2');

  const validEdit = await intercept(
    {
      type: "tool_call",
      toolCallId: "edit-valid",
      toolName: "edit",
      input: { path: file, edits: [{ oldText: "first", newText: "new" }] },
    },
    context(directory),
  );
  expect(validEdit).toBeUndefined();
  await writeFile(file, "same\nother\nsame\n");
  const duplicate = await intercept(
    {
      type: "tool_call",
      toolCallId: "edit-duplicate",
      toolName: "edit",
      input: { path: file, edits: [{ oldText: "same", newText: "new" }] },
    },
    context(directory),
  );
  expect(duplicate?.reason).toContain('"code":"edit-ambiguous"');
  expect(duplicate?.reason).toContain('"matchCount":2');
  expect(duplicate?.reason).toContain('"line":1');
  expect(duplicate?.reason).toContain('"line":3');
});

it("bounds edit diagnostics before scanning large inputs", () => {
  expect(
    diagnoseFilesystemEdits("x".repeat(256_001), [{ oldText: "x", newText: "y" }]),
  ).toBeUndefined();
  expect(
    diagnoseFilesystemEdits("same", new Array(33).fill({ oldText: "same", newText: "new" })),
  ).toBeUndefined();
});

it("reports empty, overlapping, and capped edit diagnostics", () => {
  expect(diagnoseFilesystemEdits("target", [{ oldText: "", newText: "new" }])).toMatchObject({
    code: "edit-empty-old-text",
  });
  expect(
    diagnoseFilesystemEdits("first target", [
      { oldText: "first target", newText: "replacement" },
      { oldText: "target", newText: "replacement" },
    ]),
  ).toMatchObject({ code: "edit-overlap" });
  expect(
    diagnoseFilesystemEdits(new Array(12).fill("same").join("\n"), [
      { oldText: "same", newText: "new" },
    ]),
  ).toMatchObject({ code: "edit-ambiguous", matchCount: 10, matchCountCapped: true });
});

it("matches the host edit normalization for line endings and fuzzy text", () => {
  expect(
    diagnoseFilesystemEdits("target\r\n", [{ oldText: "target", newText: "new" }]),
  ).toBeUndefined();
  expect(
    diagnoseFilesystemEdits("\uFEFFtarget\n", [{ oldText: "target", newText: "new" }]),
  ).toBeUndefined();
  expect(
    diagnoseFilesystemEdits('const value = "target";', [
      { oldText: "const value = “target”;", newText: "replacement" },
    ]),
  ).toBeUndefined();
});

it("adds a whitespace mismatch hint to an edit diagnostic", async () => {
  const directory = await fixtures.createDirectory();
  const file = join(directory, "edit.txt");
  await writeFile(file, "target\n");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const intercept = createFilesystemAccessPolicyInterceptor(policy);

  const result = await intercept(
    {
      type: "tool_call",
      toolCallId: "edit-whitespace",
      toolName: "edit",
      input: { path: file, edits: [{ oldText: " target", newText: "new" }] },
    },
    context(directory),
  );

  expect(result?.reason).toContain('"whitespaceMismatch":true');
  expect(result?.reason).toContain("preserve indentation");
});

it("lets explicit deny rules override implicit workspace access and cover descendants", async () => {
  const directory = await fixtures.createDirectory();
  const deniedRead = join(directory, "private");
  const deniedWrite = join(directory, "generated");
  await mkdir(deniedRead);
  await mkdir(deniedWrite);
  const file = join(deniedRead, "secret.txt");
  await writeFile(file, "secret");
  const configPath = join(await realpath(directory), "bash-tools.json");
  const canonicalDirectory = await realpath(directory);
  await writeFile(
    configPath,
    JSON.stringify({
      version: 4,
      environment: { version: 1 },
      projectCommands: { version: 1 },
      filesystem: {
        version: 2,
        global: { allowRead: [], allowWrite: [], denyRead: [], denyWrite: [] },
        projects: {
          [canonicalDirectory]: {
            allowRead: [],
            allowWrite: [],
            denyRead: [await realpath(deniedRead)],
            denyWrite: [await realpath(deniedWrite)],
          },
        },
      },
    }),
  );
  const policy = createPolicyStoreForTesting({ configPath });
  const intercept = createFilesystemAccessPolicyInterceptor(policy);

  const readResult = await intercept(event("read", file), context(directory));
  const writeResult = await intercept(
    event("write", join(deniedWrite, "new.txt")),
    context(directory),
  );

  expect(readResult?.block).toBe(true);
  expect(writeResult?.block).toBe(true);
  expect(readResult?.reason).toContain("denied by the project policy rule");
  expect(readResult?.reason).toContain('"ruleKind":"filesystem-deny-project"');
  expect(writeResult?.reason).toContain("denied by the project policy rule");
});

it("authorizes a missing write path using its existing canonical ancestors", async () => {
  const directory = await fixtures.createDirectory();
  const outside = await fixtures.createDirectory();
  const parent = join(outside, "parent");
  await mkdir(parent);
  const target = join(parent, "new.txt");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const select = vi.fn(async () => "Allow for this project");
  const intercept = createFilesystemAccessPolicyInterceptor(policy);

  expect(
    await intercept(
      event("write", target),
      context(directory, { mode: "tui", hasUI: true, select }),
    ),
  ).toBeUndefined();
  expect(select).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
    version: 4,
    filesystem: {
      projects: {
        [await realpath(directory)]: {
          allowRead: [],
          allowWrite: [join(await realpath(parent), "new.txt")],
          denyRead: [],
          denyWrite: [],
        },
      },
    },
  });
});

it("requires both read and write authorization for edit", async () => {
  const directory = await fixtures.createDirectory();
  const outside = await fixtures.createDirectory();
  const file = join(outside, "file.txt");
  await writeFile(file, "old");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const select = vi.fn(async () => "Allow for this project");
  const intercept = createFilesystemAccessPolicyInterceptor(policy);

  expect(
    await intercept(event("edit", file), context(directory, { mode: "tui", hasUI: true, select })),
  ).toBeUndefined();
  expect(select).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
    version: 4,
    filesystem: {
      projects: {
        [await realpath(directory)]: {
          allowRead: [await realpath(file)],
          allowWrite: [await realpath(file)],
          denyRead: [],
          denyWrite: [],
        },
      },
    },
  });
});

it("does not persist a deferred edit read approval when write approval is denied", async () => {
  const directory = await fixtures.createDirectory();
  const outside = await fixtures.createDirectory();
  const file = join(outside, "file.txt");
  await writeFile(file, "old");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const select = vi
    .fn<FilesystemAccessPolicyContext["ui"]["select"]>()
    .mockResolvedValueOnce("Allow for this project")
    .mockResolvedValueOnce("Deny for this project");
  const intercept = createFilesystemAccessPolicyInterceptor(policy);

  const result = await intercept(
    event("edit", file),
    context(directory, { mode: "tui", hasUI: true, select }),
  );

  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("denied by a configured policy rule");
  expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
    version: 4,
    filesystem: {
      projects: {
        [await realpath(directory)]: {
          allowRead: [],
          allowWrite: [],
          denyRead: [],
          denyWrite: [await realpath(file)],
        },
      },
    },
  });
});

it("does not authorize unknown tool calls as filesystem access", async () => {
  const directory = await fixtures.createDirectory();
  const outside = await fixtures.createDirectory();
  const policy = createPolicyStoreForTesting({
    configPath: join(await realpath(directory), "missing-bash-tools.json"),
  });
  const intercept = createFilesystemAccessPolicyInterceptor(policy);

  const result = await intercept(
    {
      type: "tool_call",
      toolCallId: "1",
      toolName: "unknown_tool",
      input: { path: outside },
    },
    context(directory),
  );

  expect(result).toBeUndefined();
});

it("classifies policy loading, path resolution, and cancellation failures", async () => {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const failingPolicy = {
    configPath,
    load: async () => {
      throw new Error("policy unavailable");
    },
    recordDecisions: async () => undefined,
  };
  const loadResult = await createFilesystemAccessPolicyInterceptor(failingPolicy)(
    event("ls", directory),
    context(directory),
  );
  expect(loadResult?.reason).toContain('"code":"policy-load-failure"');
  expect(loadResult?.reason).toContain('"category":"POLICY_FAILURE"');

  const policy = createPolicyStoreForTesting({ configPath });
  const missingResult = await createFilesystemAccessPolicyInterceptor(policy)(
    event("read", join(directory, "missing.txt")),
    context(directory),
  );
  expect(missingResult?.reason).toContain('"code":"policy-path-resolution-failure"');
  expect(missingResult?.reason).toContain('"executed":false');

  const controller = new AbortController();
  controller.abort();
  const cancelledResult = await createFilesystemAccessPolicyInterceptor(policy)(
    event("ls", directory),
    context(directory, { signal: controller.signal }),
  );
  expect(cancelledResult?.reason).toContain('"code":"cancelled"');
  expect(cancelledResult?.reason).toContain('"category":"CANCELLED"');
});

it("ignores non-filesystem tool calls", async () => {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const intercept = createFilesystemAccessPolicyInterceptor(policy);

  const result = await intercept(
    {
      type: "tool_call",
      toolCallId: "1",
      toolName: "bash",
      input: { command: "ls" },
    },
    context(directory),
  );

  expect(result).toBeUndefined();
});

function readBatchContext(cwd: string): ReadBatchToolContext {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    signal: undefined,
    ui: { select: async () => undefined },
  };
}

it("classifies stale context when an observed read no longer matches the file", async () => {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const intercept = createFilesystemAccessPolicyInterceptor(policy);
  const file = join(await realpath(directory), "stale.txt");
  await writeFile(file, "observed line\n");
  const readBatch = createReadBatchToolForTesting({ configPath });
  const readResult = await readBatch.execute(
    "read-batch",
    { paths: [{ path: file }] },
    undefined,
    undefined,
    readBatchContext(directory),
  );
  expect(readResult.details.results[0]).toMatchObject({ unchanged: false });

  await writeFile(file, "changed line\n");
  const stale = await intercept(
    {
      type: "tool_call",
      toolCallId: "edit-stale",
      toolName: "edit",
      input: { path: file, edits: [{ oldText: "observed line", newText: "new" }] },
    },
    context(directory),
  );
  expect(stale?.reason).toContain('"code":"edit-stale-context"');
  expect(stale?.reason).toContain('"fileFingerprint":"');

  const unobserved = join(await realpath(directory), "unobserved.txt");
  await writeFile(unobserved, "other\n");
  const plain = await intercept(
    {
      type: "tool_call",
      toolCallId: "edit-plain",
      toolName: "edit",
      input: { path: unobserved, edits: [{ oldText: "missing", newText: "new" }] },
    },
    context(directory),
  );
  expect(plain?.reason).toContain('"code":"edit-no-match"');
});

it("classifies a plain no-match for an unchanged non-UTF-8 file with observed evidence", async () => {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const intercept = createFilesystemAccessPolicyInterceptor(policy);
  const file = join(await realpath(directory), "binary.txt");
  await writeFile(file, Buffer.from([0x62, 0x69, 0x6e, 0xff, 0x0a]));
  const readBatch = createReadBatchToolForTesting({ configPath });
  const readResult = await readBatch.execute(
    "read-batch",
    { paths: [{ path: file }] },
    undefined,
    undefined,
    readBatchContext(directory),
  );
  expect(readResult.details.results[0]).toMatchObject({ unchanged: false });

  const noMatch = await intercept(
    {
      type: "tool_call",
      toolCallId: "edit-binary",
      toolName: "edit",
      input: { path: file, edits: [{ oldText: "missing", newText: "new" }] },
    },
    context(directory),
  );
  expect(noMatch?.reason).toContain('"code":"edit-no-match"');
  expect(noMatch?.reason).not.toContain('"code":"edit-stale-context"');
});

it("classifies stale context for an unchanged-in-bytes multibyte file that changed content", async () => {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const intercept = createFilesystemAccessPolicyInterceptor(policy);
  const file = join(await realpath(directory), "multibyte.txt");
  await writeFile(file, "h\u00e9llo w\u00f6rld \u00fc\u00f1\u00ee\u00e7\u00f8de\n");
  const readBatch = createReadBatchToolForTesting({ configPath });
  const readResult = await readBatch.execute(
    "read-batch",
    { paths: [{ path: file }] },
    undefined,
    undefined,
    readBatchContext(directory),
  );
  expect(readResult.details.results[0]).toMatchObject({ unchanged: false });

  await writeFile(file, "completely different content\n");
  const stale = await intercept(
    {
      type: "tool_call",
      toolCallId: "edit-multibyte",
      toolName: "edit",
      input: { path: file, edits: [{ oldText: "h\u00e9llo", newText: "new" }] },
    },
    context(directory),
  );
  expect(stale?.reason).toContain('"code":"edit-stale-context"');
  expect(stale?.reason).toContain('"fileFingerprint":"');
});

it("rejects unchanged retries after a preflight failure with a distinct code", async () => {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const tracker = createAuthorizationRetryTracker();
  const intercept = createFilesystemAccessPolicyInterceptor(policy, undefined, tracker);
  const file = join(await realpath(directory), "retry.txt");
  await writeFile(file, "alpha\n");
  const editEvent = {
    type: "tool_call" as const,
    toolCallId: "edit-retry",
    toolName: "edit" as const,
    input: { path: file, edits: [{ oldText: "missing", newText: "new" }] },
  };

  const first = await intercept(editEvent, context(directory));
  expect(first?.reason).toContain('"code":"edit-no-match"');

  const retry = await intercept({ ...editEvent, toolCallId: "edit-retry-2" }, context(directory));
  expect(retry?.reason).toContain('"code":"edit-unchanged-retry"');
  expect(retry?.reason).toContain("reread the file and rebase the edit before retrying");

  const changedEdits = await intercept(
    {
      ...editEvent,
      toolCallId: "edit-retry-3",
      input: { path: file, edits: [{ oldText: "missing", newText: "other" }] },
    },
    context(directory),
  );
  expect(changedEdits?.reason).toContain('"code":"edit-no-match"');
});

it("rejects unchanged retries after no-op, ambiguous, and overlap failures", async () => {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const tracker = createAuthorizationRetryTracker();
  const intercept = createFilesystemAccessPolicyInterceptor(policy, undefined, tracker);

  const ambiguous = join(await realpath(directory), "ambiguous.txt");
  await writeFile(ambiguous, "same\nsame\n");
  const ambiguousInput = { path: ambiguous, edits: [{ oldText: "same", newText: "new" }] };
  expect(
    (
      await intercept(
        {
          type: "tool_call",
          toolCallId: "edit-ambiguous",
          toolName: "edit",
          input: ambiguousInput,
        },
        context(directory),
      )
    )?.reason,
  ).toContain('"code":"edit-ambiguous"');
  expect(
    (
      await intercept(
        {
          type: "tool_call",
          toolCallId: "edit-ambiguous-2",
          toolName: "edit",
          input: ambiguousInput,
        },
        context(directory),
      )
    )?.reason,
  ).toContain('"code":"edit-unchanged-retry"');

  const noOp = join(await realpath(directory), "noop.txt");
  await writeFile(noOp, "target\n");
  const noOpInput = { path: noOp, edits: [{ oldText: "target", newText: "target" }] };
  expect(
    (
      await intercept(
        { type: "tool_call", toolCallId: "edit-noop", toolName: "edit", input: noOpInput },
        context(directory),
      )
    )?.reason,
  ).toContain('"code":"edit-no-op"');
  expect(
    (
      await intercept(
        { type: "tool_call", toolCallId: "edit-noop-2", toolName: "edit", input: noOpInput },
        context(directory),
      )
    )?.reason,
  ).toContain('"code":"edit-unchanged-retry"');

  const overlap = join(await realpath(directory), "overlap.txt");
  await writeFile(overlap, "overlap\n");
  const overlapInput = {
    path: overlap,
    edits: [
      { oldText: "overlap", newText: "new" },
      { oldText: "erlap", newText: "new2" },
    ],
  };
  expect(
    (
      await intercept(
        { type: "tool_call", toolCallId: "edit-overlap", toolName: "edit", input: overlapInput },
        context(directory),
      )
    )?.reason,
  ).toContain('"code":"edit-overlap"');
  expect(
    (
      await intercept(
        {
          type: "tool_call",
          toolCallId: "edit-overlap-2",
          toolName: "edit",
          input: overlapInput,
        },
        context(directory),
      )
    )?.reason,
  ).toContain('"code":"edit-unchanged-retry"');
});

it("allows an edit after the caller rebases the content on a reread", async () => {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const tracker = createAuthorizationRetryTracker();
  const intercept = createFilesystemAccessPolicyInterceptor(policy, undefined, tracker);
  const file = join(await realpath(directory), "rebase.txt");
  await writeFile(file, "first\n");
  const editEvent = {
    type: "tool_call" as const,
    toolCallId: "edit-rebase",
    toolName: "edit" as const,
    input: { path: file, edits: [{ oldText: "second", newText: "new" }] },
  };
  expect((await intercept(editEvent, context(directory)))?.reason).toContain(
    '"code":"edit-no-match"',
  );

  await writeFile(file, "first\nsecond\n");
  expect(
    await intercept({ ...editEvent, toolCallId: "edit-rebase-2" }, context(directory)),
  ).toBeUndefined();
});

it("scopes unchanged-retry tracking per session and bounds it", async () => {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const policy = createPolicyStoreForTesting({ configPath });
  const tracker = createAuthorizationRetryTracker();
  const intercept = createFilesystemAccessPolicyInterceptor(policy, undefined, tracker);
  const file = join(await realpath(directory), "session.txt");
  await writeFile(file, "alpha\n");
  const editInput = { path: file, edits: [{ oldText: "missing", newText: "new" }] };
  const firstSession = { ...context(directory), sessionManager: { getSessionId: () => "s1" } };
  const secondSession = { ...context(directory), sessionManager: { getSessionId: () => "s2" } };
  expect(
    (
      await intercept(
        { type: "tool_call", toolCallId: "edit-session", toolName: "edit", input: editInput },
        firstSession,
      )
    )?.reason,
  ).toContain('"code":"edit-no-match"');
  expect(
    (
      await intercept(
        { type: "tool_call", toolCallId: "edit-session-2", toolName: "edit", input: editInput },
        firstSession,
      )
    )?.reason,
  ).toContain('"code":"edit-unchanged-retry"');
  expect(
    (
      await intercept(
        { type: "tool_call", toolCallId: "edit-session-3", toolName: "edit", input: editInput },
        secondSession,
      )
    )?.reason,
  ).toContain('"code":"edit-no-match"');

  const boundedTracker = createAuthorizationRetryTracker(1);
  const boundedIntercept = createFilesystemAccessPolicyInterceptor(
    policy,
    undefined,
    boundedTracker,
  );
  const firstFile = join(await realpath(directory), "bound-a.txt");
  const secondFile = join(await realpath(directory), "bound-b.txt");
  await writeFile(firstFile, "alpha\n");
  await writeFile(secondFile, "beta\n");
  const firstPath = { path: firstFile, edits: [{ oldText: "missing", newText: "new" }] };
  const secondPath = { path: secondFile, edits: [{ oldText: "absent", newText: "new" }] };
  const editCall = (toolCallId: string, path: typeof firstPath) =>
    boundedIntercept(
      { type: "tool_call", toolCallId, toolName: "edit" as const, input: path },
      context(directory),
    );
  expect((await editCall("b1", firstPath))?.reason).toContain('"code":"edit-no-match"');
  expect((await editCall("b2", secondPath))?.reason).toContain('"code":"edit-no-match"');
  expect((await editCall("b3", firstPath))?.reason).toContain('"code":"edit-no-match"');
});
