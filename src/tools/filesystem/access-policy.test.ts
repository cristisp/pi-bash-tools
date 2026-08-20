import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  createFilesystemAccessPolicyInterceptor,
  type FilesystemAccessPolicyContext,
} from "./access-policy.ts";
import { createPolicyStoreForTesting } from "../policy/store.ts";
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

function event(toolName: "ls" | "find" | "grep", path: string): ToolCallEvent {
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
  return {
    type: "tool_call",
    toolCallId: "1",
    toolName,
    input: { path },
  };
}

describe("filesystem access policy interceptor", () => {
  it("blocks unknown paths without eligible UI and reports the policy reason", async () => {
    const directory = await fixtures.createDirectory();
    const configPath = join(await realpath(directory), "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const policy = createPolicyStoreForTesting({ configPath });
    const intercept = createFilesystemAccessPolicyInterceptor(policy);

    const result = await intercept(event("grep", directory), context(directory));

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("Tool call blocked by access policy"),
    });
    expect(result?.terminate).toBeUndefined();
  });

  it("persists an approved project path and allows descendants", async () => {
    const directory = await fixtures.createDirectory();
    const child = join(directory, "child");
    await mkdir(child);
    const configPath = join(await realpath(directory), "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const policy = createPolicyStoreForTesting({ configPath });
    const select = vi.fn(async () => "Allow for this project");
    const intercept = createFilesystemAccessPolicyInterceptor(policy);
    const approvalContext = context(directory, { mode: "tui", hasUI: true, select });

    expect(await intercept(event("find", directory), approvalContext)).toBeUndefined();
    expect(await intercept(event("grep", child), approvalContext)).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      version: 3,
      filesystem: {
        projects: {
          [await realpath(directory)]: {
            allow: [await realpath(directory)],
            deny: [],
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
        version: 3,
        environment: { version: 1 },
        projectCommands: { version: 1 },
        filesystem: {
          version: 1,
          global: { allow: [], deny: [canonicalDirectory] },
          projects: {},
        },
      }),
    );
    const policy = createPolicyStoreForTesting({ configPath });
    const intercept = createFilesystemAccessPolicyInterceptor(policy);

    const result = await intercept(event("ls", directory), context(directory));

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("denied by the global policy rule");
    expect(result?.terminate).toBeUndefined();
  });

  it("auto-denies and persists a project rule when approval times out", async () => {
    vi.useFakeTimers();
    const directory = await fixtures.createDirectory();
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
      event("grep", directory),
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
      version: 3,
      filesystem: {
        projects: {
          [await realpath(directory)]: {
            allow: [],
            deny: [await realpath(directory)],
          },
        },
      },
    });
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
});
