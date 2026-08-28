import { mkdir, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDeleteToolForTesting,
  createMoveToolForTesting,
  type FilesystemMutationToolContext,
} from "../../src/tools/filesystem/mutation-tool.ts";
import { createPolicyTestFixtures } from "../policy/test-fixtures.ts";

const fixtures = createPolicyTestFixtures();

afterEach(async () => {
  vi.useRealTimers();
  await fixtures.cleanup();
});

function context(
  cwd: string,
  overrides: Partial<Pick<FilesystemMutationToolContext, "mode" | "hasUI" | "signal">> & {
    select?: FilesystemMutationToolContext["ui"]["select"];
  } = {},
): FilesystemMutationToolContext {
  return {
    cwd,
    mode: overrides.mode ?? "print",
    hasUI: overrides.hasUI ?? false,
    signal: overrides.signal,
    ui: { select: overrides.select ?? (async () => undefined) },
  };
}

async function configPath(directory: string): Promise<string> {
  const path = join(await realpath(directory), "bash-tools.json");
  await writeFile(path, JSON.stringify({ version: 1 }));
  return path;
}

it.each(["move", "delete"] as const)(
  "%s enforces filesystem policy within its implementation",
  async (operation) => {
    const directory = await fixtures.createDirectory();
    const outside = await fixtures.createDirectory();
    const config = await configPath(directory);

    if (operation === "move") {
      const source = join(outside, "source.txt");
      const destination = join(outside, "destination.txt");
      await writeFile(source, "content");
      const tool = createMoveToolForTesting({ configPath: config });

      const execution = tool.execute(
        "1",
        { source, destination },
        undefined,
        undefined,
        context(directory),
      );
      await expect(execution).rejects.toThrow(/requires approval that is unavailable/iu);
      await expect(execution).rejects.toMatchObject({
        contract: {
          code: "policy-not-authorized",
          category: "BLOCKED",
          retryable: false,
          executed: false,
        },
      });
      await expect(readFile(source, "utf8")).resolves.toBe("content");
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      return;
    }

    const path = join(outside, "delete.txt");
    await writeFile(path, "content");
    const tool = createDeleteToolForTesting({ configPath: config });

    const execution = tool.execute("1", { path }, undefined, undefined, context(directory));
    await expect(execution).rejects.toThrow(/requires approval that is unavailable/iu);
    await expect(execution).rejects.toMatchObject({
      contract: {
        code: "policy-not-authorized",
        category: "BLOCKED",
        retryable: false,
        executed: false,
      },
    });
    await expect(readFile(path, "utf8")).resolves.toBe("content");
  },
);

it("moves a regular file within the active workspace", async () => {
  const directory = await fixtures.createDirectory();
  const source = join(directory, "source.txt");
  const destination = join(directory, "destination.txt");
  await writeFile(source, "content");
  const tool = createMoveToolForTesting({ configPath: await configPath(directory) });
  const choices = ["Allow for this project", "Allow for this project"];

  const result = await tool.execute(
    "1",
    { source, destination },
    undefined,
    undefined,
    context(directory, {
      hasUI: true,
      mode: "tui",
      select: async () => choices.shift(),
    }),
  );

  const canonicalDirectory = await realpath(directory);
  expect(result.details).toEqual({
    operation: "move",
    source: join(canonicalDirectory, "source.txt"),
    destination: join(canonicalDirectory, "destination.txt"),
  });
  await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(destination, "utf8")).resolves.toBe("content");
});

it("deletes a regular file within the active workspace", async () => {
  const directory = await fixtures.createDirectory();
  const path = join(directory, "delete.txt");
  await writeFile(path, "content");
  const tool = createDeleteToolForTesting({ configPath: await configPath(directory) });

  const result = await tool.execute(
    "1",
    { path },
    undefined,
    undefined,
    context(directory, {
      hasUI: true,
      mode: "tui",
      select: async () => "Allow for this project",
    }),
  );

  expect(result.details).toEqual({
    operation: "delete",
    path: join(await realpath(directory), "delete.txt"),
  });
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("persists delete approval for a folder and reuses it for descendants", async () => {
  const directory = await fixtures.createDirectory();
  const outside = await fixtures.createDirectory();
  const folder = join(outside, "removable");
  await mkdir(folder);
  const first = join(folder, "first.txt");
  const second = join(folder, "nested", "second.txt");
  await mkdir(join(folder, "nested"));
  await writeFile(first, "first");
  await writeFile(second, "second");
  const config = await configPath(directory);
  const tool = createDeleteToolForTesting({ configPath: config });
  const select = vi.fn(async (title: string, choices: readonly string[]) => {
    expect(title).toContain("Authorize deletion of files in");
    expect(title).toContain("for this project only");
    expect(title).toContain("Requested file:");
    expect(choices).toEqual([
      "Deny once",
      "Deny for this project",
      "Allow once",
      "Allow for this project",
    ]);
    return "Allow for this project";
  });
  const approvalContext = context(directory, {
    hasUI: true,
    mode: "tui",
    select,
  });

  await tool.execute("1", { path: first }, undefined, undefined, approvalContext);
  await tool.execute("2", { path: second }, undefined, undefined, approvalContext);

  expect(select).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(config, "utf8"))).toMatchObject({
    filesystem: {
      projects: {
        [await realpath(directory)]: {
          allowDelete: [await realpath(folder)],
        },
      },
    },
  });
});

it("blocks mutation outside the active workspace without authorization", async () => {
  const directory = await fixtures.createDirectory();
  const outside = await fixtures.createDirectory();
  const path = join(outside, "delete.txt");
  await writeFile(path, "content");
  const tool = createDeleteToolForTesting({ configPath: await configPath(directory) });

  await expect(
    tool.execute("1", { path }, undefined, undefined, context(directory)),
  ).rejects.toThrow(/requires approval that is unavailable/iu);
  await expect(readFile(path, "utf8")).resolves.toBe("content");
});

it("does not persist an earlier move approval when destination approval is denied", async () => {
  const directory = await fixtures.createDirectory();
  const outside = await fixtures.createDirectory();
  const source = join(outside, "source.txt");
  const destination = join(outside, "destination.txt");
  await writeFile(source, "content");
  const config = await configPath(directory);
  const tool = createMoveToolForTesting({ configPath: config });
  const choices = ["Allow for this project", "Deny for this project"];

  await expect(
    tool.execute(
      "1",
      { source, destination },
      undefined,
      undefined,
      context(directory, {
        hasUI: true,
        mode: "tui",
        select: async () => choices.shift(),
      }),
    ),
  ).rejects.toThrow(/denied/iu);

  await expect(readFile(source, "utf8")).resolves.toBe("content");
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(config, "utf8"))).toMatchObject({
    filesystem: {
      projects: {
        [await realpath(directory)]: {
          allowMove: [],
          denyMove: [join(await realpath(outside), "destination.txt")],
        },
      },
    },
  });
});

it.each(["move", "delete"] as const)(
  "classifies pre-execution cancellation for %s",
  async (operation) => {
    const directory = await fixtures.createDirectory();
    const path = join(directory, `${operation}.txt`);
    await writeFile(path, "content");
    const controller = new AbortController();
    controller.abort();
    const config = await configPath(directory);
    const execution =
      operation === "move"
        ? createMoveToolForTesting({ configPath: config }).execute(
            "1",
            { source: path, destination: join(directory, "destination.txt") },
            controller.signal,
            undefined,
            context(directory),
          )
        : createDeleteToolForTesting({ configPath: config }).execute(
            "1",
            { path },
            controller.signal,
            undefined,
            context(directory),
          );

    await expect(execution).rejects.toMatchObject({
      contract: {
        code: "cancelled",
        category: "CANCELLED",
        retryable: true,
        executed: false,
      },
    });
    await expect(readFile(path, "utf8")).resolves.toBe("content");
  },
);

it.each(["move", "delete"] as const)(
  "classifies %s syscall failures after authorization",
  async (operation) => {
    const directory = await fixtures.createDirectory();
    const source = join(directory, "source.txt");
    const destination = join(directory, "destination.txt");
    await writeFile(source, "content");
    const path = join(directory, "delete.txt");
    await writeFile(path, "content");
    const config = await configPath(directory);
    const canonicalSource = await realpath(source);
    const canonicalDestination = join(await realpath(directory), "destination.txt");
    const canonicalDeletePath = await realpath(path);
    const choices =
      operation === "move"
        ? ["Allow for this project", "Allow for this project"]
        : ["Allow for this project"];
    const approvalContext = context(directory, {
      hasUI: true,
      mode: "tui",
      select: async () => choices.shift(),
    });
    const execution =
      operation === "move"
        ? createMoveToolForTesting({
            configPath: config,
            fs: {
              rename: async (from, to) => {
                if (from === canonicalSource && to === canonicalDestination) {
                  throw new Error("rename failed");
                }
                await rename(from, to);
              },
            },
          }).execute("1", { source, destination }, undefined, undefined, approvalContext)
        : createDeleteToolForTesting({
            configPath: config,
            fs: {
              unlink: async (target) => {
                if (target === canonicalDeletePath) {
                  throw new Error("unlink failed");
                }
              },
            },
          }).execute("1", { path }, undefined, undefined, approvalContext);

    await expect(execution).rejects.toMatchObject({
      contract: {
        code: "filesystem-mutation-failure",
        category: "IMPLEMENTATION_FAILURE",
        retryable: true,
        executed: true,
      },
    });
  },
);

it("classifies filesystem inspection failures before mutation", async () => {
  const directory = await fixtures.createDirectory();
  const path = join(directory, "target.txt");
  await writeFile(path, "content");
  const tool = createDeleteToolForTesting({
    configPath: await configPath(directory),
    fs: { lstat: async () => Promise.reject(new Error("inspection failed")) },
  });

  await expect(
    tool.execute("1", { path }, undefined, undefined, context(directory)),
  ).rejects.toMatchObject({
    contract: {
      code: "filesystem-inspection-failure",
      category: "IMPLEMENTATION_FAILURE",
      retryable: true,
      executed: false,
    },
  });
});

it("rejects symlink mutation targets", async () => {
  const directory = await fixtures.createDirectory();
  const target = join(directory, "target.txt");
  const link = join(directory, "link.txt");
  await writeFile(target, "content");
  await symlink(target, link);
  const tool = createDeleteToolForTesting({ configPath: await configPath(directory) });

  await expect(
    tool.execute("1", { path: link }, undefined, undefined, context(directory)),
  ).rejects.toThrow(/regular file/iu);
  await expect(readFile(target, "utf8")).resolves.toBe("content");
});
