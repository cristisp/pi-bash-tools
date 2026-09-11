import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import type { GitStatusChangedOutput, GitStatusOutput } from "../../src/tools/git/status/output.ts";
import { createGitStatusTool } from "../../src/tools/git/status/tool.ts";
import {
  gitIntegration,
  createGitIntegrationFixtures,
  exists,
  makeRealGitExec,
  rawGit,
  writeExecutable,
} from "./integration-fixtures.ts";

const fixtures = createGitIntegrationFixtures();

function changed(details: GitStatusOutput): GitStatusChangedOutput {
  if (details.unchanged) throw new Error("expected a rendered status");
  return details;
}

afterEach(() => fixtures.cleanup());

gitIntegration("Git status with a real Git process", () => {
  it("does not change the index or remove a pre-existing index lock", async () => {
    const repository = await fixtures.createRepository();
    const indexPath = join(repository.directory, ".git", "index");
    const lockPath = join(repository.directory, ".git", "index.lock");
    const beforeBytes = await readFile(indexPath);
    const beforeStat = await stat(indexPath, { bigint: true });
    await writeFile(lockPath, "sentinel");

    const response = await createGitStatusTool(makeRealGitExec()).execute(
      "status",
      {},
      undefined,
      undefined,
      repository.context,
    );

    const afterBytes = await readFile(indexPath);
    const afterStat = await stat(indexPath, { bigint: true });
    expect(afterBytes).toEqual(beforeBytes);
    expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);
    expect(await readFile(lockPath, "utf8")).toBe("sentinel");
    expect(response.details.repositoryRoot).toBe(await realpath(repository.directory));
  });

  it("does not execute a configured fsmonitor helper", async () => {
    const repository = await fixtures.createRepository();
    const marker = join(repository.directory, "fsmonitor-marker");
    const helper = join(repository.directory, "fsmonitor-helper.sh");
    await writeExecutable(helper, `printf marker >> '${marker}'`);
    await rawGit(repository.directory, ["config", "core.fsmonitor", helper]);

    await createGitStatusTool(makeRealGitExec()).execute(
      "status",
      {},
      undefined,
      undefined,
      repository.context,
    );

    expect(await exists(marker)).toBe(false);
  });

  it("returns real status records for spaces, renames, untracked files, and path filters", async () => {
    const repository = await fixtures.createRepository();
    await rawGit(repository.directory, ["mv", "space name.txt", "renamed file.txt"]);
    await writeFile(join(repository.directory, "untracked space.txt"), "untracked\n");

    const tool = createGitStatusTool(makeRealGitExec());
    const all = await tool.execute("status", {}, undefined, undefined, repository.context);
    expect(changed(all.details).entries).toEqual(
      expect.arrayContaining([
        {
          path: "renamed file.txt",
          indexStatus: "R",
          worktreeStatus: " ",
          renamedFrom: "space name.txt",
        },
        { path: "untracked space.txt", indexStatus: "?", worktreeStatus: "?" },
      ]),
    );

    const filtered = await tool.execute(
      "filtered",
      { path: "renamed file.txt" },
      undefined,
      undefined,
      repository.context,
    );
    expect(changed(filtered.details).entries).toEqual([
      { path: "renamed file.txt", indexStatus: "A", worktreeStatus: " " },
    ]);
  });

  it("caps status records and returns structured output metadata", async () => {
    const repository = await fixtures.createRepository();
    await Promise.all(
      Array.from({ length: 2001 }, (_, index) =>
        writeFile(
          join(repository.directory, `untracked-${index.toString().padStart(4, "0")}.txt`),
          "x\n",
        ),
      ),
    );

    const response = await createGitStatusTool(makeRealGitExec()).execute(
      "status-cap",
      {},
      undefined,
      undefined,
      repository.context,
    );

    expect(changed(response.details).entries).toHaveLength(2000);
    expect(response.details.output.truncated).toBe(true);
    expect(response.details.output.totalBytes).toBeGreaterThan(0);
    expect(response.details.output.totalLines).toBe(2001);
    expect(response.content[0]?.type).toBe("text");
  });

  it("carries repository-state identity matching the real HEAD and keeps it in the unchanged repeat", async () => {
    const repository = await fixtures.createRepository();
    await writeFile(join(repository.directory, "dirty.txt"), "dirty\n");
    const tool = createGitStatusTool(makeRealGitExec());

    const details = changed(
      (await tool.execute("identity", {}, undefined, undefined, repository.context)).details,
    );
    const realHead = (await rawGit(repository.directory, ["rev-parse", "HEAD"])).trim();
    expect(details.head).toBe(realHead);
    expect(details.dirtyFilesDigest).toMatch(/^[0-9a-f]{64}$/u);

    const repeat = await tool.execute("repeat", {}, undefined, undefined, repository.context);
    expect(repeat.details).toMatchObject({
      unchanged: true,
      previous: { head: realHead, dirtyFilesDigest: details.dirtyFilesDigest },
    });
  });

  it("cancels a real Git process after the adapter observes its spawn", async () => {
    const repository = await fixtures.createRepository();
    let resolveSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      resolveSpawned = resolve;
    });
    const controller = new AbortController();
    const exec = makeRealGitExec(() => resolveSpawned?.());
    const execution = createGitStatusTool(exec).execute(
      "cancel",
      {},
      controller.signal,
      undefined,
      repository.context,
    );
    await spawned;
    controller.abort();
    await expect(execution).rejects.toThrow(/cancelled/iu);
  });
});
