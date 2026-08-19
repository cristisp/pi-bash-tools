import { describe, expect, it } from "vitest";
import { projectCommandInputSchema } from "./schema.ts";
import { createProjectCommandToolForTesting } from "./tool.ts";

describe("project command metadata", () => {
  it("describes each semantic command in the input schema", () => {
    const schema = JSON.stringify(projectCommandInputSchema);

    expect(schema).toContain("Report the canonical project directory");
    expect(schema).toContain("Report the Node.js runtime version");
    expect(schema).toContain("Run the exact package.json test script");
  });

  it("explains command selection and tool boundaries", () => {
    const tool = createProjectCommandToolForTesting({
      configPath: "/tmp/project-command-metadata-policy.json",
    });

    expect(tool.description).toContain("node_project_info reports project state in process");
    expect(tool.description).toContain("node_test, node_build, node_lint, and node_typecheck");
    expect(tool.description).not.toContain("node_deps_install");
    expect(tool.promptSnippet).toBe(
      "Inspect Node project state or run one exact, user-authorized Node package script",
    );
    expect(tool.promptGuidelines).toContain(
      "Use project_command with commandId node_project_info before selecting an applicable Node package script.",
    );
  });
});
