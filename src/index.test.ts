import { describe, expect, it } from "vitest";
import extension from "./index.ts";

describe("bash tools extension", () => {
  it("exports a pi extension factory", () => {
    expect(extension).toBeTypeOf("function");
  });

  it("registers six distinct tools without overriding pi built-ins", () => {
    const names: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        names.push(tool.name);
      },
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    } satisfies Parameters<typeof extension>[0];
    extension(pi);
    expect(names).toEqual([
      "git_status",
      "git_diff",
      "git_log",
      "git_show",
      "environment",
      "project_command",
    ]);
    expect(names).not.toContain("read");
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("grep");
    expect(names).not.toContain("find");
    expect(names).not.toContain("ls");
    expect(names).not.toContain("bash");
  });
});
