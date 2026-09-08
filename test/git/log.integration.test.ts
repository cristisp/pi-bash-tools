import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { createGitLogTool } from "../../src/tools/git/log/tool.ts";
import {
  gitIntegration,
  createGitIntegrationFixtures,
  makeRealGitExec,
  rawGit,
} from "./integration-fixtures.ts";

const fixtures = createGitIntegrationFixtures();

afterEach(() => fixtures.cleanup());

gitIntegration("Git log with a real Git process", () => {
  it("parses multiple real Git log records with exact metadata", async () => {
    const repository = await fixtures.createRepository();
    await rawGit(repository.directory, ["config", "user.name", "Second Author Name"]);
    await writeFile(join(repository.directory, "README.md"), "second README\n");
    await rawGit(repository.directory, ["add", "README.md"]);
    await rawGit(repository.directory, ["commit", "--quiet", "-m", "second commit with spaces"]);
    await rawGit(repository.directory, ["config", "user.name", "Third Author Name"]);
    await writeFile(join(repository.directory, "README.md"), "third README\n");
    await rawGit(repository.directory, ["add", "README.md"]);
    await rawGit(repository.directory, ["commit", "--quiet", "-m", "third commit with spaces"]);

    const expectedEntries = await Promise.all(
      ["HEAD", "HEAD^"].map(async (revision) => {
        const [id, author, date, subject] = await Promise.all([
          rawGit(repository.directory, ["rev-parse", revision]),
          rawGit(repository.directory, ["show", "-s", "--format=%an", revision]),
          rawGit(repository.directory, ["show", "-s", "--format=%aI", revision]),
          rawGit(repository.directory, ["show", "-s", "--format=%s", revision]),
        ]);
        return {
          id: id.trim(),
          author: author.trim(),
          date: date.trim(),
          subject: subject.trim(),
        };
      }),
    );

    const response = await createGitLogTool(makeRealGitExec()).execute(
      "multiple",
      { maxEntries: 2 },
      undefined,
      undefined,
      repository.context,
    );

    expect(response.details.entries).toEqual(expectedEntries);
    expect(response.details.output.totalLines).toBe(2);
    expect(response.details.output.truncated).toBe(false);
  });
});
