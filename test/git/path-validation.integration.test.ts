import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { createGitDiffTool } from "../../src/tools/git/diff/tool.ts";
import { createGitStatusTool } from "../../src/tools/git/status/tool.ts";
import {
  gitIntegration,
  capabilityError,
  createGitIntegrationFixtures,
  makeRealGitExec,
} from "./integration-fixtures.ts";

const fixtures = createGitIntegrationFixtures();

afterEach(() => fixtures.cleanup());

gitIntegration("Git path validation with a real Git process", () => {
  it("rejects empty and duplicate paths and rejects symlink escapes when supported", async () => {
    const repository = await fixtures.createRepository();
    const tool = createGitDiffTool(makeRealGitExec());
    await expect(
      tool.execute("empty", { paths: [], maxBytes: 10 }, undefined, undefined, repository.context),
    ).rejects.toThrow(/must not be empty/iu);
    await expect(
      tool.execute(
        "duplicate",
        { paths: ["README.md", "README.md"], maxBytes: 10 },
        undefined,
        undefined,
        repository.context,
      ),
    ).rejects.toThrow(/duplicate/iu);

    const outside = await mkdtemp(join(tmpdir(), "bash-tools-outside-"));
    fixtures.trackDirectory(outside);
    await writeFile(join(outside, "secret.txt"), "secret\n");
    const link = join(repository.directory, "escape");
    try {
      await symlink(outside, link, "junction");
    } catch (error) {
      if (capabilityError(error)) {
        return;
      }
      throw error;
    }
    await expect(
      createGitStatusTool(makeRealGitExec()).execute(
        "symlink",
        { path: "escape/secret.txt" },
        undefined,
        undefined,
        repository.context,
      ),
    ).rejects.toThrow(/symlink/iu);
  });
});
