import { describe, expect, it } from "vitest";
import { projectCommandInputSchema } from "../../src/tools/project-command/schema.ts";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";

describe("project command metadata", () => {
  it("describes each semantic command in the input schema", () => {
    const schema = JSON.stringify(projectCommandInputSchema);

    expect(schema).toContain("Report the canonical project directory");
    expect(schema).toContain("Report the Node.js runtime version");
    expect(schema).toContain("Run the exact package.json test script");
    expect(schema).toContain("Run the exact package.json lint:fix script to write lint fixes.");
    expect(schema).toContain("Run the exact package.json format:check script");
    expect(schema).toContain(
      "Run the exact package.json format script to write formatting changes",
    );
    expect(schema).toContain("Run Fallow dead-code analysis");
    expect(schema).toContain("Required safe revision used as the Fallow audit base.");
  });

  it("explains command selection and tool boundaries", () => {
    const tool = createProjectCommandToolForTesting({
      configPath: "/tmp/project-command-metadata-policy.json",
    });

    expect(tool.description).toContain("node_project_info reports project state in process");
    expect(tool.description).toContain(
      "node_test, node_build, node_lint, node_lint_fix, node_typecheck, node_format_check, and node_format_write",
    );
    expect(tool.description).toContain(
      "node_lint_fix and node_format_write changing project files",
    );
    expect(tool.description).toContain("six fixed Fallow analyses");
    expect(tool.description).not.toContain("node_deps_install");
    expect(tool.promptSnippet).toBe(
      "Inspect Node project state, list top-level dependencies, run one exact Node package script including lint fixes and formatting, or run one fixed Fallow analysis",
    );
    expect(tool.promptGuidelines).toContain(
      "Use project_command with commandId node_project_info before selecting an applicable Node command.",
    );
  });
});
