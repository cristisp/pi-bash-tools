import { describe, expect, it } from "vitest";
import { projectCommandInputSchema } from "./schema.ts";
import { createProjectCommandToolForTesting } from "./tool.ts";

describe("project command metadata", () => {
  it("describes each semantic command in the input schema", () => {
    const schema = JSON.stringify(projectCommandInputSchema);

    expect(schema).toContain("Report the canonical project directory");
    expect(schema).toContain("Report the Node.js runtime version");
  });

  it("explains command selection and tool boundaries", () => {
    const tool = createProjectCommandToolForTesting({
      configPath: "/tmp/project-command-metadata-policy.json",
    });

    expect(tool.description).toContain("workspace_path reports the canonical project directory");
    expect(tool.description).toContain("node_version reports the active Node.js runtime version");
    expect(tool.promptSnippet).toBe(
      "Get the project path or Node.js version through a fixed, user-authorized command",
    );
    expect(tool.promptGuidelines).toEqual([
      "Use project_command with commandId workspace_path when you need the current project workspace path.",
      "Use project_command with commandId node_version when you need the active Node.js runtime version.",
      "Do not use project_command for Git inspection; use git_status, git_diff, git_log, or git_show instead.",
      "Do not use project_command for file or directory inspection; use read, grep, find, or ls instead.",
      "Do not use project_command for arbitrary commands, package scripts, environment access, or project mutation.",
    ]);
  });
});
