import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createGitDiffTool } from "../src/tools/git/diff/tool.ts";
import {
  gitIntegration,
  createGitIntegrationFixtures,
  exists,
  makeRealGitExec,
  rawGit,
  writeExecutable,
} from "./git-tools.integration-fixtures.ts";

const fixtures = createGitIntegrationFixtures();

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
      { path: "space name.txt", maxBytes: 1024 },
      undefined,
      undefined,
      repository.context,
    );

    expect(response.details.patch).toContain("space name.txt");
    expect(await exists(textconvMarker)).toBe(false);
    expect(await exists(externalMarker)).toBe(false);
  });

  it("returns staged, unstaged, binary, space-containing, empty, and truncated diffs", async () => {
    const repository = await fixtures.createRepository();
    await writeFile(join(repository.directory, "README.md"), "unstaged change\n");
    await rawGit(repository.directory, ["add", "README.md"]);
    await writeFile(join(repository.directory, "README.md"), "unstaged change again\n");
    await writeFile(join(repository.directory, "binary.bin"), Buffer.from([0, 1, 9, 3, 255]));
    await writeFile(join(repository.directory, "space name.txt"), "space change\n");

    const tool = createGitDiffTool(makeRealGitExec());
    const unstaged = await tool.execute(
      "unstaged",
      { path: "README.md", maxBytes: 4096 },
      undefined,
      undefined,
      repository.context,
    );
    const staged = await tool.execute(
      "staged",
      { staged: true, path: "README.md", maxBytes: 4096 },
      undefined,
      undefined,
      repository.context,
    );
    const binary = await tool.execute(
      "binary",
      { path: "binary.bin", maxBytes: 4096 },
      undefined,
      undefined,
      repository.context,
    );
    const spaces = await tool.execute(
      "spaces",
      { path: "space name.txt", maxBytes: 4096 },
      undefined,
      undefined,
      repository.context,
    );
    const empty = await tool.execute(
      "empty",
      { path: "does-not-exist.txt", maxBytes: 4096 },
      undefined,
      undefined,
      repository.context,
    );
    const truncated = await tool.execute(
      "truncated",
      { path: "README.md", maxBytes: 5 },
      undefined,
      undefined,
      repository.context,
    );

    expect(unstaged.details.patch).toContain("unstaged change again");
    expect(staged.details.patch).toContain("unstaged change");
    expect(binary.details.patch).toMatch(/binary files|git binary patch/iu);
    expect(spaces.details.patch).toContain("space name.txt");
    expect(empty.details).toEqual({
      patch: "",
      output: { truncated: false, totalBytes: 0, totalLines: 0 },
    });
    expect(truncated.details.patch).toHaveLength(5);
    expect(truncated.details.output.truncated).toBe(true);
  });
});
