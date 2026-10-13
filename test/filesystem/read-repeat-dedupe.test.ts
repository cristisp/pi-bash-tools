import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

import {
  createReadRepeatDedupe,
  type ReadRepeatDedupeContext,
} from "../../src/tools/filesystem/read-repeat-dedupe.ts";

interface ReadEventOptions {
  readonly toolCallId: string;
  readonly path: string;
  readonly text: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly isError?: boolean;
  readonly parentToolCallId?: string;
  readonly parts?: readonly (
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "image";
        readonly data: string;
        readonly mimeType: string;
      }
  )[];
}

type ReadToolResultEvent = Extract<ToolResultEvent, { toolName: "read" }>;

function readEvent(options: ReadEventOptions): ReadToolResultEvent {
  const parts: ReadToolResultEvent["content"] = options.parts
    ? [...options.parts]
    : [{ type: "text", text: options.text }];
  return {
    type: "tool_result",
    toolName: "read",
    toolCallId: options.toolCallId,
    ...(options.parentToolCallId === undefined
      ? {}
      : { parentToolCallId: options.parentToolCallId }),
    input: {
      path: options.path,
      ...(options.offset === undefined ? {} : { offset: options.offset }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    },
    content: parts,
    isError: options.isError ?? false,
    details: undefined,
  };
}

function context(sessionId: string): ReadRepeatDedupeContext {
  return { sessionManager: { getSessionId: () => sessionId } };
}

it("passes through the first read of a path and records it", () => {
  const dedupe = createReadRepeatDedupe();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r1", path: "a.ts", text: "hello" }), context("s1")),
  ).toBeUndefined();
});

it("replaces an exact repeat with an unchanged notice naming the earlier read", () => {
  const dedupe = createReadRepeatDedupe();
  const first = readEvent({ toolCallId: "r1", path: "src/a.ts", text: "hello" });
  expect(dedupe.toolResult(first, context("s1"))).toBeUndefined();

  const repeat = dedupe.toolResult(
    readEvent({ toolCallId: "r2", path: "src/a.ts", text: "hello" }),
    context("s1"),
  );
  expect(repeat).toMatchObject({
    isError: false,
    structuredContent: expect.stringContaining("tool call r1"),
  });
  expect(repeat?.content).toEqual([
    {
      type: "text",
      text: expect.stringContaining("same content as the earlier read of src/a.ts"),
    },
  ]);

  const third = dedupe.toolResult(
    readEvent({ toolCallId: "r3", path: "src/a.ts", text: "hello" }),
    context("s1"),
  );
  expect(third?.structuredContent).toEqual(expect.stringContaining("tool call r1"));
});

it("does not dedupe changed content and names the most recent matching read afterwards", () => {
  const dedupe = createReadRepeatDedupe();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r1", path: "a.ts", text: "v1" }), context("s1")),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r2", path: "a.ts", text: "v2" }), context("s1")),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r3", path: "a.ts", text: "v2" }), context("s1")),
  ).toMatchObject({
    isError: false,
    structuredContent: expect.stringContaining("tool call r2"),
  });
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r4", path: "a.ts", text: "v1" }), context("s1")),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r5", path: "a.ts", text: "v1" }), context("s1")),
  ).toMatchObject({
    isError: false,
    structuredContent: expect.stringContaining("tool call r4"),
  });
});

it("treats different ranges as separate reads", () => {
  const dedupe = createReadRepeatDedupe();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r1", path: "a.ts", text: "head" }), context("s1")),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(
      readEvent({ toolCallId: "r2", path: "a.ts", text: "head", offset: 1 }),
      context("s1"),
    ),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(
      readEvent({ toolCallId: "r3", path: "a.ts", text: "head", offset: 1, limit: 5 }),
      context("s1"),
    ),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(
      readEvent({ toolCallId: "r4", path: "a.ts", text: "head", offset: 1 }),
      context("s1"),
    ),
  ).toMatchObject({
    structuredContent: expect.stringContaining("tool call r2"),
  });
});

it("does not dedupe across sessions", () => {
  const dedupe = createReadRepeatDedupe();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r1", path: "a.ts", text: "same" }), context("s1")),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r2", path: "a.ts", text: "same" }), context("s2")),
  ).toBeUndefined();
});

it("skips results without a session id without recording or replacing", () => {
  const dedupe = createReadRepeatDedupe();
  const emptyContext: ReadRepeatDedupeContext = { sessionManager: { getSessionId: () => "" } };
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r1", path: "a.ts", text: "x" }), emptyContext),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r2", path: "a.ts", text: "x" }), context("s1")),
  ).toBeUndefined();
});

it("skips error results", () => {
  const dedupe = createReadRepeatDedupe();
  expect(
    dedupe.toolResult(
      readEvent({ toolCallId: "r1", path: "a.ts", text: "boom", isError: true }),
      context("s1"),
    ),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r2", path: "a.ts", text: "boom" }), context("s1")),
  ).toBeUndefined();
});

it("skips nested calls and image results", () => {
  const dedupe = createReadRepeatDedupe();
  expect(
    dedupe.toolResult(
      readEvent({ toolCallId: "nested/r1", path: "a.ts", text: "x", parentToolCallId: "p1" }),
      context("s1"),
    ),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(
      readEvent({
        toolCallId: "r1",
        path: "img.png",
        text: "",
        parts: [{ type: "image", data: "abc", mimeType: "image/png" }],
      }),
      context("s1"),
    ),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r2", path: "img.png", text: "" }), context("s1")),
  ).toBeUndefined();
});

it("ignores non-read tools", () => {
  const dedupe = createReadRepeatDedupe();
  const bashEvent: ToolResultEvent = {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "b1",
    input: { command: "ls" },
    content: [{ type: "text", text: "x" }],
    isError: false,
    details: undefined,
  };
  expect(dedupe.toolResult(bashEvent, context("s1"))).toBeUndefined();
});

it("clear() prevents dedupe of prior reads", () => {
  const dedupe = createReadRepeatDedupe();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r1", path: "a.ts", text: "x" }), context("s1")),
  ).toBeUndefined();
  dedupe.clear();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r2", path: "a.ts", text: "x" }), context("s1")),
  ).toBeUndefined();
});

it("evicts the oldest entry beyond the per-session capacity", () => {
  const dedupe = createReadRepeatDedupe({ maxSessions: 4, maxEntriesPerSession: 1 });
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r1", path: "a.ts", text: "x" }), context("s1")),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r2", path: "b.ts", text: "y" }), context("s1")),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r3", path: "a.ts", text: "x" }), context("s1")),
  ).toBeUndefined();
});

it("evicts the oldest session beyond the session capacity", () => {
  const dedupe = createReadRepeatDedupe({ maxSessions: 1, maxEntriesPerSession: 4 });
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r1", path: "a.ts", text: "x" }), context("s1")),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r2", path: "a.ts", text: "x" }), context("s2")),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r3", path: "a.ts", text: "x" }), context("s1")),
  ).toBeUndefined();
});

it("evicts the least recently used session, refreshing session order on access", () => {
  const dedupe = createReadRepeatDedupe({ maxSessions: 2 });
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r1", path: "a.ts", text: "x" }), context("s1")),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r2", path: "b.ts", text: "y" }), context("s2")),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r3", path: "c.ts", text: "z" }), context("s1")),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r4", path: "d.ts", text: "w" }), context("s3")),
  ).toBeUndefined();
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r5", path: "a.ts", text: "x" }), context("s1")),
  ).toMatchObject({ structuredContent: expect.stringContaining("tool call r1") });
  expect(
    dedupe.toolResult(readEvent({ toolCallId: "r6", path: "b.ts", text: "y" }), context("s2")),
  ).toBeUndefined();
});
