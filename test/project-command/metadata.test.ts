import { describe, expect, it } from "vitest";

import { projectCommandInputSchema } from "../../src/tools/project-command/schema.ts";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";

describe("project command metadata", () => {
  it("describes each semantic command in the input schema", () => {
    const schema = JSON.stringify(projectCommandInputSchema);

    expect(schema).toContain("Report the canonical project directory");
    expect(schema).toContain("Report the Node.js runtime version");
    expect(schema).toContain("Run the exact package.json test script");
    expect(schema).toContain(
      "Run the exact package.json test script with optional workspace-relative paths.",
    );
    expect(schema).toContain(
      "Run the exact package.json lint script or an existing validated lint:<variant> script.",
    );
    expect(schema).toContain(
      "Run the exact package.json format script or an existing validated format:<variant> script.",
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
      "supported Node script commands run only exact package.json scripts or validated existing lint:<variant>, test:<variant>, and format:<variant> family forms",
    );
    expect(tool.description).toContain(
      "project mutation outside the project-controlled package scripts exposed by this catalog",
    );
    expect(tool.description).toContain("six fixed Fallow analyses");
    expect(tool.description).toContain(
      "Variants use bounded package-script-safe names and select the exact script configured by the project.",
    );
    expect(tool.description).not.toContain("node_deps_install");
    expect(tool.promptSnippet).toBe(
      "Inspect Node project state, list top-level dependencies, run one exact Node package script or validated variant including lint fixes and formatting, or run one fixed Fallow analysis",
    );
    expect(tool.promptGuidelines).toContain(
      "Use project_command with commandId node_project_info before selecting an applicable Node command.",
    );
    expect(tool.promptGuidelines).toContain(
      "Use node_test with optional workspace-relative paths only when package.json has the exact test script; its optional variant selects an existing validated test:<variant> script, including project-defined coverage or E2E scripts.",
    );
    expect(tool.promptGuidelines).toContain(
      "Use node_format with an optional variant only when package.json has the exact format or format:<variant> script; formatting scripts may modify project files.",
    );
    expect(tool.promptGuidelines).toContain(
      "Use node_build or node_typecheck only when package.json has the exact corresponding script; node_lint accepts an optional variant selecting an existing validated lint:<variant> script, including project-defined fix scripts.",
    );
  });
});
