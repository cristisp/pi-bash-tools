import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  createFilesystemAccessPolicyInterceptor,
  type FilesystemAccessPolicyContext,
} from "../../src/tools/filesystem/access-policy.ts";
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
