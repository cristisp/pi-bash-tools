import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import type {
  GitDiffOutput,
  GitDiffPatchOutput,
  GitDiffSummaryOutput,
} from "../../src/tools/git/diff/output.ts";
import { createGitDiffTool } from "../../src/tools/git/diff/tool.ts";
import {
  gitIntegration,
  createGitIntegrationFixtures,
  exists,
  makeRealGitExec,
  rawGit,
  writeExecutable,
} from "./integration-fixtures.ts";

const fixtures = createGitIntegrationFixtures();

function patchDetails(details: GitDiffOutput): GitDiffPatchOutput {
  if (details.mode !== "patch") throw new Error("expected a patch response");
  return details;
}

function summaryDetails(details: GitDiffOutput): GitDiffSummaryOutput {
  if (details.mode !== "summary" || "unchanged" in details) {
    throw new Error("expected a full summary response");
  }
  return details;
}

afterEach(() => fixtures.cleanup());

gitIntegration("Git diff with a real Git process", () => {
  it("does not execute configured textconv or external diff helpers", async () => {
    const repository = await fixtures.createRepository();
    const textconvMarker = join(repository.directory, "textconv-marker");
    const externalMarker = join(repository.directory, "external-marker");
    const textconv = join(repository.directory, "textconv-helper.sh");
    const external = join(repository.directory, "external-helper.sh");
    await writeExecutable(textconv, `printf marker >> '${textconvMarker}'`);
    await writeExecutable(external, `printf marker >> '${externalMarker}'`);
    await writeFile(join(repository.directory, ".gitattributes"), "*.txt diff=marker\n");
    await rawGit(repository.directory, ["add", ".gitattributes"]);
    await rawGit(repository.directory, ["commit", "--quiet", "-m", "attributes"]);
    await rawGit(repository.directory, ["config", "diff.marker.textconv", textconv]);
    await rawGit(repository.directory, ["config", "diff.external", external]);
    await writeFile(join(repository.directory, "space name.txt"), "changed\n");

    const response = await createGitDiffTool(makeRealGitExec()).execute(
      "diff",
      { mode: "patch", paths: ["space name.txt"], maxBytes: 1024 },
      undefined,
      undefined,
      repository.context,
    );

    expect(patchDetails(response.details).patch).toContain("space name.txt");
    expect(await exists(textconvMarker)).toBe(false);
    expect(await exists(externalMarker)).toBe(false);
  });

  it("returns coherent staged and worktree summaries without hunk bodies", async () => {
    const repository = await fixtures.createRepository();
    await writeFile(join(repository.directory, "README.md"), "staged content\n");
    await rawGit(repository.directory, ["add", "README.md"]);
    await writeFile(join(repository.directory, "README.md"), "worktree content\n");
    await writeFile(join(repository.directory, "space name.txt"), "staged-only content\n");
    await rawGit(repository.directory, ["add", "space name.txt"]);
    await writeFile(join(repository.directory, "binary.bin"), Buffer.from([9, 8, 7, 6, 5]));
    await writeFile(join(repository.directory, "untracked.txt"), "untracked content\n");

    const tool = createGitDiffTool(makeRealGitExec());
    const staged = summaryDetails(
      (
        await tool.execute(
          "staged-summary",
          { staged: true, maxBytes: 64 * 1024 },
          undefined,
          undefined,
          repository.context,
        )
      ).details,
    );
    const worktree = summaryDetails(
      (
        await tool.execute(
          "worktree-summary",
          { maxBytes: 64 * 1024 },
          undefined,
          undefined,
          repository.context,
        )
      ).details,
    );
    const scoped = summaryDetails(
      (
        await tool.execute(
          "scoped-summary",
          { paths: ["README.md"], maxBytes: 64 * 1024 },
          undefined,
          undefined,
          repository.context,
        )
      ).details,
    );

    expect(staged.status).toEqual([
      { path: "README.md", indexStatus: "M", worktreeStatus: " " },
      { path: "space name.txt", indexStatus: "M", worktreeStatus: " " },
    ]);
    expect(staged.stat).toContain("README.md");
    expect(staged.stat).toContain("space name.txt");
    expect(staged.stat).not.toContain("binary.bin");
    expect(staged.hunks.map((hunk) => hunk.path)).toEqual(["README.md", "space name.txt"]);

    expect(worktree.status).toEqual([
      { path: "README.md", indexStatus: " ", worktreeStatus: "M" },
      { path: "binary.bin", indexStatus: " ", worktreeStatus: "M" },
      { path: "untracked.txt", indexStatus: " ", worktreeStatus: "?" },
    ]);
    expect(worktree.stat).toContain("README.md");
    expect(worktree.stat).toContain("binary.bin");
    expect(worktree.stat).not.toContain("space name.txt");
    expect(worktree.hunks).toEqual([{ path: "README.md", header: expect.stringContaining("@@") }]);

    expect(scoped.status).toEqual([{ path: "README.md", indexStatus: " ", worktreeStatus: "M" }]);
    expect(scoped.stat).toContain("README.md");
    expect(scoped.stat).not.toContain("binary.bin");
    expect(scoped.hunks).toEqual([{ path: "README.md", header: expect.stringContaining("@@") }]);

    for (const summary of [staged, worktree, scoped]) {
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain("staged content");
      expect(serialized).not.toContain("worktree content");
      expect(serialized).not.toContain("untracked content");
    }
  });

  it("decodes quoted hunk paths for a non-ASCII filename", async () => {
    const repository = await fixtures.createRepository();
    const fileName = "café.txt";
    await writeFile(join(repository.directory, fileName), "initial café\n");
    await rawGit(repository.directory, ["add", fileName]);
    await rawGit(repository.directory, ["commit", "--quiet", "-m", "non-ASCII file"]);
    await writeFile(join(repository.directory, fileName), "changed café\n");

    const response = summaryDetails(
      (
        await createGitDiffTool(makeRealGitExec()).execute(
          "quoted-path-summary",
          { paths: [fileName], maxBytes: 64 * 1024 },
          undefined,
          undefined,
          repository.context,
        )
      ).details,
    );

    expect(response.hunks).toEqual([{ path: fileName, header: expect.stringContaining("@@") }]);
  });

  it("defaults to summary with identity and returns a compact unchanged repeat", async () => {
    const repository = await fixtures.createRepository();
    await writeFile(join(repository.directory, "README.md"), "changed\n");
    const tool = createGitDiffTool(makeRealGitExec());

    const first = summaryDetails(
      (await tool.execute("summary", {}, undefined, undefined, repository.context)).details,
    );
    const realHead = (await rawGit(repository.directory, ["rev-parse", "HEAD"])).trim();
    expect(first.head).toBe(realHead);
    expect(first.dirtyFilesDigest).toMatch(/^[0-9a-f]{64}$/u);

    const repeat = await tool.execute("repeat", {}, undefined, undefined, repository.context);
    expect(repeat.details).toMatchObject({
      mode: "summary",
      unchanged: true,
      previous: { head: realHead, dirtyFilesDigest: first.dirtyFilesDigest },
      output: { truncated: false, totalBytes: 0, totalLines: 0 },
      message: expect.stringContaining('mode: "patch"'),
    });
  });

  it("bounds whole-repository patches and directs follow-ups to explicit paths", async () => {
    const repository = await fixtures.createRepository();
    await writeFile(join(repository.directory, "README.md"), "content\n".repeat(400));

    const response = await createGitDiffTool(makeRealGitExec()).execute(
      "whole-patch",
      { mode: "patch", maxBytes: 512 },
      undefined,
      undefined,
      repository.context,
    );

    const details = patchDetails(response.details);
    expect(details.output.truncated).toBe(true);
    expect(details.message).toContain('mode: "patch"');
    expect(details.message).toContain("paths");
  });

  it("returns staged, unstaged, binary, space-containing, empty, and truncated diffs", async () => {
    const repository = await fixtures.createRepository();
    await writeFile(join(repository.directory, "README.md"), "unstaged change\n");
    await rawGit(repository.directory, ["add", "README.md"]);
    await writeFile(join(repository.directory, "README.md"), "unstaged change again\n");
    await writeFile(join(repository.directory, "binary.bin"), Buffer.from([0, 1, 9, 3, 255]));
    await writeFile(join(repository.directory, "space name.txt"), "space change\n");

    const tool = createGitDiffTool(makeRealGitExec());
    const wholeRepository = await tool.execute(
      "whole",
      { mode: "patch", maxBytes: 4096 },
      undefined,
      undefined,
      repository.context,
    );
    const selected = await tool.execute(
      "selected",
      { mode: "patch", paths: ["README.md", "space name.txt"], maxBytes: 4096 },
      undefined,
      undefined,
      repository.context,
    );
    const legacy = await tool.execute(
      "legacy",
      { mode: "patch", path: "README.md", maxBytes: 4096 },
      undefined,
      undefined,
      repository.context,
    );
    const unstaged = await tool.execute(
      "unstaged",
      { mode: "patch", paths: ["README.md"], maxBytes: 4096 },
      undefined,
      undefined,
      repository.context,
    );
    const staged = await tool.execute(
      "staged",
      { mode: "patch", staged: true, paths: ["README.md"], maxBytes: 4096 },
      undefined,
      undefined,
      repository.context,
    );
    const binary = await tool.execute(
      "binary",
      { mode: "patch", paths: ["binary.bin"], maxBytes: 4096 },
      undefined,
      undefined,
      repository.context,
    );
    const spaces = await tool.execute(
      "spaces",
      { mode: "patch", paths: ["space name.txt"], maxBytes: 4096 },
      undefined,
      undefined,
      repository.context,
    );
    const empty = await tool.execute(
      "empty",
      { mode: "patch", paths: ["does-not-exist.txt"], maxBytes: 4096 },
      undefined,
      undefined,
      repository.context,
    );
    const truncated = await tool.execute(
      "truncated",
      { mode: "patch", paths: ["README.md"], maxBytes: 5 },
      undefined,
      undefined,
      repository.context,
    );

    expect(patchDetails(wholeRepository.details).patch).toContain("README.md");
    expect(patchDetails(wholeRepository.details).patch).toContain("space name.txt");
    expect(patchDetails(wholeRepository.details).patch).toContain("binary.bin");
    expect(patchDetails(selected.details).patch).toContain("README.md");
    expect(patchDetails(selected.details).patch).toContain("space name.txt");
    expect(patchDetails(selected.details).patch).not.toContain("binary.bin");
    expect(patchDetails(legacy.details).patch).toContain("README.md");
    expect(patchDetails(legacy.details).patch).toContain("unstaged change again");
    expect(patchDetails(unstaged.details).patch).toContain("unstaged change again");
    expect(patchDetails(staged.details).patch).toContain("unstaged change");
    expect(patchDetails(binary.details).patch).toMatch(/binary files|git binary patch/iu);
    expect(patchDetails(spaces.details).patch).toContain("space name.txt");
    expect(empty.details).toEqual({
      mode: "patch",
      patch: "",
      output: { truncated: false, totalBytes: 0, totalLines: 0 },
    });
    expect(patchDetails(truncated.details).patch).toHaveLength(5);
    expect(truncated.details.output.truncated).toBe(true);
  });
});
