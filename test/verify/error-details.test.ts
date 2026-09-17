import { afterEach, expect, it } from "vitest";

import {
  createVerifyErrorDetailsStore,
  createVerifyToolResultHandler,
} from "../../src/tools/verify/error-details.ts";
import { createVerifyToolForTesting } from "../../src/tools/verify/tool.ts";
import {
  cleanupProjectCommandFixtures,
  context,
  fixture,
} from "../project-command/tool-test-fixtures.ts";

afterEach(cleanupProjectCommandFixtures);

function resultEvent(
  toolCallId: string,
  input: Record<string, unknown>,
): Parameters<ReturnType<typeof createVerifyToolResultHandler>>[0] {
  return {
    type: "tool_result",
    toolName: "verify",
    toolCallId,
    input,
    content: [{ type: "text", text: "validation ref not found" }],
    details: {},
    isError: true,
  };
}

it("forwards stale lookup metadata without replacing host error content", async () => {
  const fixtureData = await fixture();
  const errorDetails = createVerifyErrorDetailsStore();
  const handler = createVerifyToolResultHandler(errorDetails);
  const tool = createVerifyToolForTesting({
    configPath: fixtureData.configPath,
    errorDetailsRecorder: errorDetails.record,
  });
  const input = { ref: "vr_stale" };

  await expect(
    tool.execute("stale-verify-ref", input, undefined, undefined, context(fixtureData.directory)),
  ).rejects.toMatchObject({
    code: "not-found",
    resultCategory: "RESOLUTION_FAILURE",
    executed: false,
    retryable: false,
  });

  expect(handler(resultEvent("stale-verify-ref", input))).toEqual({
    details: expect.objectContaining({
      code: "not-found",
      resultCategory: "RESOLUTION_FAILURE",
      executed: false,
      retryable: false,
    }),
  });
});

it("does not classify invalid verify requests with a ref as stale lookups", async () => {
  const fixtureData = await fixture();
  const errorDetails = createVerifyErrorDetailsStore();
  const handler = createVerifyToolResultHandler(errorDetails);
  const tool = createVerifyToolForTesting({
    configPath: fixtureData.configPath,
    errorDetailsRecorder: errorDetails.record,
  });
  const cases = [
    ["invalid-fresh", { ref: "vr_stale", fresh: true }],
    ["invalid-flow", { ref: "vr_stale", flowId: "!" }],
    ["invalid-covers", { ref: "vr_stale", covers: [""] }],
  ] as const;

  await Promise.all(
    cases.map(async ([toolCallId, input]) => {
      await expect(
        tool.execute(toolCallId, input, undefined, undefined, context(fixtureData.directory)),
      ).rejects.toMatchObject({ code: "invalid-request" });
      expect(handler(resultEvent(toolCallId, input))).toEqual({
        details: expect.objectContaining({ code: "invalid-request" }),
      });
      expect(handler(resultEvent(toolCallId, input))).toBeUndefined();
    }),
  );
});
