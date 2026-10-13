import { describe, expect, it } from "vitest";

import { projectCommandEvidenceRef } from "../../src/tools/project-command/evidence.ts";
import type { ProjectCommandOutputDetails } from "../../src/tools/project-command/output.ts";

type RefDetails = Pick<
  ProjectCommandOutputDetails,
  "commandId" | "projectPath" | "parameters" | "status" | "category" | "stdout" | "stderr"
>;

function details(overrides: Partial<RefDetails> = {}): RefDetails {
  return {
    commandId: "workspace_path",
    projectPath: "/project",
    parameters: {},
    status: "success",
    category: "PASS",
    stdout: { text: "workspace", truncated: false, totalBytes: 9, totalLines: 1 },
    stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    ...overrides,
  };
}

describe("projectCommandEvidenceRef", () => {
  it("derives a deterministic pc_ reference from execution details", () => {
    expect(projectCommandEvidenceRef(details())).toMatch(/^pc_[A-Za-z0-9]{24}$/u);
    expect(projectCommandEvidenceRef(details())).toBe(projectCommandEvidenceRef(details()));
  });

  it("changes the reference when execution details change", () => {
    const reference = projectCommandEvidenceRef(details());
    expect(projectCommandEvidenceRef(details({ status: "nonzero" }))).not.toBe(reference);
    expect(
      projectCommandEvidenceRef(
        details({ stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 } }),
      ),
    ).not.toBe(reference);
    expect(projectCommandEvidenceRef(details({ parameters: { force: true } }))).not.toBe(reference);
    expect(projectCommandEvidenceRef(details({ commandId: "node_test" }))).not.toBe(reference);
    expect(projectCommandEvidenceRef(details({ projectPath: "/other" }))).not.toBe(reference);
  });
});
