import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import extension from "../src/index.ts";

describe("bash tools extension", () => {
  it("exports a pi extension factory", () => {
    expect(extension).toBeTypeOf("function");
  });

  it("registers ten distinct tools without overriding pi built-ins", () => {
    const names: string[] = [];
    const annotations = new Map<string, unknown>();
    const events: string[] = [];
    const entries: unknown[] = [];
    const handlers = new Map<string, unknown>();
    const unsupported = (..._args: unknown[]): never => {
      throw new Error("Unexpected call in extension factory test");
    };
    const registerTool: ExtensionAPI["registerTool"] = (tool) => {
      names.push(tool.name);
      if ("annotations" in tool) annotations.set(tool.name, tool.annotations);
    };
    const pi = {
      on(event: string, _handler: unknown) {
        events.push(event);
        handlers.set(event, _handler);
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
      appendEntry: vi.fn((...args: unknown[]) => {
        entries.push(args);
      }),
      setSessionName: unsupported,
      getSessionName: unsupported,
      setLabel: unsupported,
      exec: async (..._args: Parameters<ExtensionAPI["exec"]>) => ({
        stdout: "",
        stderr: "",
        code: 0,
        killed: false,
      }),
      getActiveTools: () => [],
      getAllTools: () => [],
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
    expect(events).toEqual(["session_start", "session_shutdown", "tool_call", "tool_result"]);
    expect(names).toEqual([
      "git_status",
      "git_diff",
      "git_log",
      "git_show",
      "environment",
      "read_batch",
      "project_command",
      "verify",
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
    expect(annotations.get("git_status")).toEqual({ readOnlyHint: true });
    expect(annotations.get("git_diff")).toEqual({ readOnlyHint: true });
    expect(annotations.get("git_log")).toEqual({ readOnlyHint: true });
    expect(annotations.get("git_show")).toEqual({ readOnlyHint: true });
    expect(annotations.get("read_batch")).toEqual({ readOnlyHint: true });
    expect(annotations.get("move")).toEqual({ destructiveHint: true });
    expect(annotations.get("delete")).toEqual({ destructiveHint: true });
    expect(annotations.has("project_command")).toBe(false);
    expect(annotations.has("verify")).toBe(false);

    const context = { sessionManager: { getSessionId: () => "index-session" } };
    const emit = (name: string, event: unknown): void => {
      const handler = handlers.get(name);
      if (typeof handler !== "function") throw new Error(`missing ${name} handler`);
      Reflect.apply(handler, undefined, [event, context]);
    };
    const toolResultHandler = handlers.get("tool_result");
    if (typeof toolResultHandler !== "function") throw new Error("missing tool_result handler");
    const rejected: unknown = Reflect.apply(toolResultHandler, undefined, [
      {
        type: "tool_result",
        toolName: "project_command",
        toolCallId: "invalid-variant",
        input: { commandId: "node_lint", variant: "-unsafe" },
        content: [{ type: "text", text: "invalid request" }],
        isError: true,
      },
      context,
    ]);
    if (typeof rejected !== "object" || rejected === null || !("details" in rejected)) {
      throw new Error("expected structured project command rejection details");
    }
    expect(rejected.details).toMatchObject({
      resultCategory: "INVALID_REQUEST",
      executed: false,
      retryable: false,
      error: { code: "invalid-request" },
    });

    const unrecordedVerifyResult: unknown = Reflect.apply(toolResultHandler, undefined, [
      {
        type: "tool_result",
        toolName: "verify",
        toolCallId: "unrecorded-verify-error",
        input: { ref: "vr_stale" },
        content: [{ type: "text", text: "existing verify error" }],
        isError: true,
        details: {},
      },
      context,
    ]);
    expect(unrecordedVerifyResult).toBeUndefined();

    emit("session_start", { type: "session_start", reason: "startup" });
    emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject([
      "bash-tools.project-command-summary",
      { sessionId: "index-session", invocationCount: 0 },
    ]);
  });
});
