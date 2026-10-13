import type { ToolResultEvent, TruncationResult } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

import { createReadRangeHint } from "../../src/tools/filesystem/read-range-hint.ts";

type ReadToolResultEvent = Extract<ToolResultEvent, { toolName: "read" }>;

interface ReadEventOptions {
  readonly toolCallId: string;
  readonly path: string;
  readonly text: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly isError?: boolean;
  readonly parentToolCallId?: string;
  readonly truncated?: boolean;
  readonly structuredContent?: string;
  readonly parts?: readonly (
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "image";
        readonly data: string;
        readonly mimeType: string;
      }
  )[];
}

function truncatedDetails(): TruncationResult {
  return {
    content: "truncated view",
    truncated: true,
    truncatedBy: "lines",
    totalLines: 10,
    totalBytes: 10,
    outputLines: 5,
    outputBytes: 5,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines: 5,
    maxBytes: 50_000,
  };
}

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
    details: options.truncated === undefined ? undefined : { truncation: truncatedDetails() },
    ...(options.structuredContent === undefined
      ? {}
      : { structuredContent: options.structuredContent }),
  };
}

const LARGE_TEXT = "x".repeat(40_000);

it("appends the range hint to a large whole-file read and keeps the structured content", () => {
  const hint = createReadRangeHint();
  const result = hint.handler(
    readEvent({
      toolCallId: "r1",
      path: "big.ts",
      text: LARGE_TEXT,
      structuredContent: LARGE_TEXT,
    }),
  );
  expect(result).toMatchObject({ isError: false });
  const parts = result?.content;
  expect(parts).toHaveLength(2);
  expect(parts?.[1]).toMatchObject({
    type: "text",
    text: expect.stringContaining("read_batch with a bounded line range"),
  });
  expect(result?.structuredContent).toBe(LARGE_TEXT);
});

it("passes through small whole-file reads unchanged", () => {
  const hint = createReadRangeHint();
  expect(
    hint.handler(readEvent({ toolCallId: "r1", path: "a.ts", text: "small" })),
  ).toBeUndefined();
});

it("appends the hint to truncated whole-file reads below the byte threshold", () => {
  const hint = createReadRangeHint();
  const result = hint.handler(
    readEvent({ toolCallId: "r1", path: "big.ts", text: "truncated view", truncated: true }),
  );
  const parts = result?.content;
  expect(parts).toHaveLength(2);
  expect(parts?.[1]).toMatchObject({
    type: "text",
    text: expect.stringContaining("Informational"),
  });
});

it("never hints on ranged reads", () => {
  const hint = createReadRangeHint();
  expect(
    hint.handler(readEvent({ toolCallId: "r1", path: "big.ts", text: LARGE_TEXT, offset: 1 })),
  ).toBeUndefined();
  expect(
    hint.handler(readEvent({ toolCallId: "r2", path: "big.ts", text: LARGE_TEXT, limit: 10 })),
  ).toBeUndefined();
});

it("skips error, nested, image, and non-read results", () => {
  const hint = createReadRangeHint();
  expect(
    hint.handler(readEvent({ toolCallId: "r1", path: "big.ts", text: LARGE_TEXT, isError: true })),
  ).toBeUndefined();
  expect(
    hint.handler(
      readEvent({ toolCallId: "n1", path: "big.ts", text: LARGE_TEXT, parentToolCallId: "p1" }),
    ),
  ).toBeUndefined();
  expect(
    hint.handler(
      readEvent({
        toolCallId: "r2",
        path: "img.png",
        text: "",
        parts: [{ type: "image", data: "abc", mimeType: "image/png" }],
      }),
    ),
  ).toBeUndefined();
  const bashEvent: ToolResultEvent = {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "b1",
    input: { command: "ls" },
    content: [{ type: "text", text: LARGE_TEXT }],
    isError: false,
    details: undefined,
  };
  expect(hint.handler(bashEvent)).toBeUndefined();
});

it("honors a custom threshold", () => {
  const hint = createReadRangeHint({ minBytes: 10 });
  const result = hint.handler(readEvent({ toolCallId: "r1", path: "a.ts", text: "0123456789x" }));
  const parts = result?.content;
  expect(parts).toHaveLength(2);
});
