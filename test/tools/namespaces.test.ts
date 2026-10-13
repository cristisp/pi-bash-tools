import { describe, expect, it } from "vitest";

import { createGitDiffTool } from "../../src/tools/git/diff/tool.ts";
import type { GitExec } from "../../src/tools/git/execution.ts";
import { createGitLogTool } from "../../src/tools/git/log/tool.ts";
import { createGitShowTool } from "../../src/tools/git/show/tool.ts";
import { createGitStatusTool } from "../../src/tools/git/status/tool.ts";
import { GIT_TOOL_NAMESPACE, PROJECT_COMMAND_TOOL_NAMESPACE } from "../../src/tools/namespaces.ts";
import { createProjectCommandTool } from "../../src/tools/project-command/tool.ts";

const exec: GitExec = async () => ({ stdout: "", stderr: "", code: 0, killed: false });

describe("tool namespaces", () => {
  it("declares the shared git namespace on every git tool", () => {
    const tools = [
      createGitStatusTool(exec),
      createGitDiffTool(exec),
      createGitLogTool(exec),
      createGitShowTool(exec),
    ];
    for (const tool of tools) {
      expect(tool.namespace).toEqual(GIT_TOOL_NAMESPACE);
    }
  });

  it("declares the project-command namespace on project_command", () => {
    const tool = createProjectCommandTool();
    expect(tool.namespace).toEqual(PROJECT_COMMAND_TOOL_NAMESPACE);
  });

  it("freezes the namespace declarations", () => {
    expect(Object.isFrozen(GIT_TOOL_NAMESPACE)).toBe(true);
    expect(Object.isFrozen(PROJECT_COMMAND_TOOL_NAMESPACE)).toBe(true);
  });
});
