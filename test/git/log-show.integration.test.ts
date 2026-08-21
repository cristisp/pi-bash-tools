import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createGitLogTool } from "../../src/tools/git/log/tool.ts";
import { createGitShowTool } from "../../src/tools/git/show/tool.ts";
import {
  gitIntegration,
  createGitIntegrationFixtures,
  makeRealGitExec,
  rawGit,
} from "./integration-fixtures.ts";

const fixtures = createGitIntegrationFixtures();

afterEach(() => fixtures.cleanup());

gitIntegration("Git log and show with a real Git process", () => {
  it("returns bounded log and show results for revisions, paths, binary content, and empty output", async () => {
    const repository = await fixtures.createRepository();
    await writeFile(join(repository.directory, "README.md"), "second README\n");
    await rawGit(repository.directory, ["add", "README.md"]);
    await rawGit(repository.directory, ["commit", "--quiet", "-m", "second commit"]);
    await writeFile(join(repository.directory, "space name.txt"), "second space file\n");
    await rawGit(repository.directory, ["add", "space name.txt"]);
    await rawGit(repository.directory, ["commit", "--quiet", "-m", "space commit"]);
    await writeFile(join(repository.directory, "binary.bin"), Buffer.from([0, 1, 8, 3, 255]));
    await rawGit(repository.directory, ["add", "binary.bin"]);
    await rawGit(repository.directory, ["commit", "--quiet", "-m", "binary commit"]);

    const log = await createGitLogTool(makeRealGitExec()).execute(
      "log",
      { revision: "HEAD", path: "space name.txt", maxEntries: 1 },
      undefined,
      undefined,
      repository.context,
    );
    const show = await createGitShowTool(makeRealGitExec()).execute(
      "show",
      { revision: "HEAD", path: "binary.bin", maxBytes: 4096 },
      undefined,
      undefined,
      repository.context,
    );
    const truncated = await createGitShowTool(makeRealGitExec()).execute(
      "truncated",
      { revision: "HEAD", path: "binary.bin", maxBytes: 4 },
      undefined,
      undefined,
      repository.context,
    );
    const empty = await createGitShowTool(makeRealGitExec()).execute(
      "empty",
      { revision: "HEAD", path: "does-not-exist.txt", maxBytes: 4 },
      undefined,
      undefined,
      repository.context,
    );

    expect(log.details.entries).toHaveLength(1);
    expect(log.details.entries[0]?.subject).toBe("space commit");
    expect(log.details.output.totalLines).toBe(1);
    expect(show.details.content).toMatch(/binary files|git binary patch/iu);
    expect(show.details.output.truncated).toBe(false);
    expect(truncated.details.content).toHaveLength(4);
    expect(truncated.details.output.truncated).toBe(true);
    expect(empty.details).toEqual({
      content: "",
      output: { truncated: false, totalBytes: 0, totalLines: 0 },
    });
  });
});
