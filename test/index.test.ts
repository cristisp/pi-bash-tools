import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import extension from "../src/index.ts";

describe("bash tools extension", () => {
  it("exports a pi extension factory", () => {
    expect(extension).toBeTypeOf("function");
  });

  it("registers eight distinct tools without overriding pi built-ins", () => {
    const names: string[] = [];
    const events: string[] = [];
    const unsupported = (..._args: unknown[]): never => {
      throw new Error("Unexpected call in extension factory test");
    };
    const registerTool: ExtensionAPI["registerTool"] = (tool) => {
      names.push(tool.name);
    };
    const pi = {
      on(event: string, _handler: unknown) {
        events.push(event);
      },
      registerTool,
      registerCommand: unsupported,
      registerShortcut: unsupported,
      registerFlag: unsupported,
      getFlag: unsupported,
      registerMessageRenderer: unsupported,
      registerMarkdownTransformer: unsupported,
      registerEntryRenderer: unsupported,
      sendMessage: unsupported,
      sendUserMessage: unsupported,
      appendEntry: unsupported,
      setSessionName: unsupported,
      getSessionName: unsupported,
      setLabel: unsupported,
      exec: async (..._args: Parameters<ExtensionAPI["exec"]>) => ({
        stdout: "",
        stderr: "",
        code: 0,
        killed: false,
      }),
      getActiveTools: unsupported,
      getAllTools: unsupported,
      setActiveTools: unsupported,
      getCommands: unsupported,
      setModel: unsupported,
      getThinkingLevel: unsupported,
      setThinkingLevel: unsupported,
      registerProvider: unsupported,
      unregisterProvider: unsupported,
      events: {
        emit: unsupported,
        on: unsupported,
      },
    } satisfies Parameters<typeof extension>[0];
    extension(pi);
    expect(events).toEqual(["tool_call"]);
    expect(names).toEqual([
      "git_status",
      "git_diff",
      "git_log",
      "git_show",
      "environment",
      "project_command",
      "move",
      "delete",
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
