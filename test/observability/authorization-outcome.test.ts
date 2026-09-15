/* oxlint-disable typescript/no-unsafe-type-assertion */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAuthorizationOutcomeRecord,
  createAuthorizationOutcomeObserver,
  createAuthorizationOutcomeRecorder,
  AUTHORIZATION_OUTCOME_ENTRY_TYPE,
  recordAuthorizationOutcome,
  type AuthorizationOutcomeCore,
  type AuthorizationOutcomeRecordInput,
} from "../../src/observability/authorization-outcome.ts";
import { BASH_TOOLS_INVOCATIONS_PATH } from "../../src/observability/invocation-stream.ts";

function input(
  overrides: Partial<AuthorizationOutcomeRecordInput> = {},
): AuthorizationOutcomeRecordInput {
  return {
    surface: "verify",
    commandId: "verify",
    sessionId: "session-1",
    toolCallId: "call-1",
    outcome: "authorized",
    decisionPersisted: false,
    promptEmitted: false,
    promptWaitMs: 0,
    executionAttempted: false,
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("authorization outcome records", () => {
  it("records surface identity and outcome classification without policy contents", () => {
    const record = buildAuthorizationOutcomeRecord(
      input({
        outcome: "confirmation-timeout",
        decisionPersisted: true,
        promptEmitted: true,
        promptWaitMs: 512.6,
      }),
    );

    expect(record).toEqual({
      authorizationFormatVersion: 1,
      surface: "verify",
      commandId: "verify",
      sessionId: "session-1",
      toolCallId: "call-1",
      outcome: "confirmation-timeout",
      decisionPersisted: true,
      promptEmitted: true,
      promptWaitMs: 512,
      executionAttempted: false,
    });
  });

  it("drops empty command identifiers and clamps invalid values", () => {
    const record = buildAuthorizationOutcomeRecord(
      input({
        commandId: "",
        surface: "unexpected" as never,
        outcome: "unexpected" as never,
        promptWaitMs: Number.NaN,
        sessionId: "s".repeat(400),
      }),
    );

    expect("commandId" in record).toBe(false);
    expect(record.surface).toBe("environment");
    expect(record.outcome).toBe("confirmation-failure");
    expect(record.promptWaitMs).toBe(0);
    expect(record.sessionId.length).toBeLessThanOrEqual(256);
  });

  it("records interaction mode, effective flow, and policy decision source when known", () => {
    const record = buildAuthorizationOutcomeRecord(
      input({ mode: "rpc", flowId: "flow-7", decisionSource: "allow-project" }),
    );

    expect(record.mode).toBe("rpc");
    expect(record.flowId).toBe("flow-7");
    expect(record.decisionSource).toBe("allow-project");
  });

  it("omits unknown attribution and clamps invalid attribution values", () => {
    const absent = buildAuthorizationOutcomeRecord(input());
    expect("mode" in absent).toBe(false);
    expect("flowId" in absent).toBe(false);
    expect("decisionSource" in absent).toBe(false);

    const invalid = buildAuthorizationOutcomeRecord(
      input({
        mode: "unexpected" as never,
        flowId: "",
        decisionSource: "unexpected" as never,
      }),
    );
    expect("mode" in invalid).toBe(false);
    expect("flowId" in invalid).toBe(false);
    expect("decisionSource" in invalid).toBe(false);

    const bounded = buildAuthorizationOutcomeRecord(input({ flowId: "f".repeat(600) }));
    expect(bounded.flowId).toHaveLength(256);
    expect(JSON.stringify(bounded)).not.toContain("private");
  });

  it("omits empty role and delegation identifiers and clamps overly long values", () => {
    const absent = buildAuthorizationOutcomeRecord(input({ role: "", delegationId: undefined }));
    expect("role" in absent).toBe(false);
    expect("delegationId" in absent).toBe(false);

    const bounded = buildAuthorizationOutcomeRecord(
      input({
        role: "r".repeat(600),
        delegationId: "d".repeat(600),
      }),
    );
    expect(bounded.role).toHaveLength(256);
    expect(bounded.delegationId).toHaveLength(256);
  });

  it("marks an explicitly unknown decision source without policy contents", () => {
    const record = buildAuthorizationOutcomeRecord(input({ decisionSource: "unknown" }));

    expect(record.decisionSource).toBe("unknown");
    expect(JSON.stringify(record)).not.toContain("allow");
  });

  it("marks execution attempted when the caller reports it", () => {
    const record = buildAuthorizationOutcomeRecord(input({ executionAttempted: true }));

    expect(record.executionAttempted).toBe(true);
  });

  it("keeps records bounded well under the persistence cap", () => {
    const record = buildAuthorizationOutcomeRecord(
      input({
        commandId: "c".repeat(600),
        toolCallId: "t".repeat(600),
        outcome: "denied",
      }),
    );
    const serialized = JSON.stringify(record);

    expect(serialized.length).toBeLessThan(8 * 1024);
    expect(record.commandId?.length).toBeLessThanOrEqual(256);
    expect(record.toolCallId.length).toBeLessThanOrEqual(256);
  });

  it("swallows failures from an injected recorder", () => {
    const recorder = vi.fn(() => {
      throw new Error("recorder unavailable");
    });

    expect(() => recordAuthorizationOutcome(recorder, input())).not.toThrow();
    expect(recorder).toHaveBeenCalledOnce();
    expect(() => recordAuthorizationOutcome(undefined, input())).not.toThrow();
  });
});

describe("authorization outcome observer", () => {
  it("returns undefined without a recorder or session identity", () => {
    expect(
      createAuthorizationOutcomeObserver({
        surface: "verify",
        recorder: undefined,
        sessionId: "s",
        toolCallId: "c",
      }),
    ).toBeUndefined();
    expect(
      createAuthorizationOutcomeObserver({
        surface: "verify",
        recorder: vi.fn(),
        sessionId: undefined,
        toolCallId: "c",
      }),
    ).toBeUndefined();
  });

  it("emits a full record with surface identity for each observed outcome", () => {
    const recorder = vi.fn();
    const observe = createAuthorizationOutcomeObserver({
      surface: "project-command",
      commandId: "node_lint",
      recorder,
      sessionId: "session-1",
      toolCallId: "call-1",
    });

    const core: AuthorizationOutcomeCore = {
      outcome: "denied",
      decisionPersisted: true,
      promptEmitted: true,
      promptWaitMs: 42,
      executionAttempted: false,
    };
    observe?.(core);

    expect(recorder).toHaveBeenCalledWith(
      buildAuthorizationOutcomeRecord({
        surface: "project-command",
        commandId: "node_lint",
        sessionId: "session-1",
        toolCallId: "call-1",
        ...core,
      }),
    );
  });

  it("carries observer mode and flow identity onto every emitted record", () => {
    const recorder = vi.fn();
    const observe = createAuthorizationOutcomeObserver({
      surface: "filesystem",
      commandId: "read",
      recorder,
      sessionId: "session-1",
      toolCallId: "call-1",
      mode: "json",
      flowId: "flow-9",
    });

    observe?.({
      outcome: "authorized",
      decisionPersisted: false,
      promptEmitted: false,
      promptWaitMs: 0,
    });

    expect(recorder).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "json", flowId: "flow-9" }),
    );
  });

  it("carries orchestrated attribution onto every emitted record", () => {
    const recorder = vi.fn();
    const observe = createAuthorizationOutcomeObserver({
      surface: "project-command",
      commandId: "node_test",
      recorder,
      sessionId: "session-1",
      toolCallId: "call-1",
      attribution: { orchestrated: true, role: "worker", delegationId: "delegation-1" },
    });

    observe?.({
      outcome: "authorized",
      decisionPersisted: false,
      promptEmitted: false,
      promptWaitMs: 0,
    });
    observe?.({
      outcome: "denied",
      decisionPersisted: false,
      promptEmitted: false,
      promptWaitMs: 0,
    });

    expect(recorder).toHaveBeenCalledTimes(2);
    for (const call of recorder.mock.calls) {
      const [record] = call as [Record<string, unknown>];
      expect(record.role).toBe("worker");
      expect(record.delegationId).toBe("delegation-1");
    }
  });

  it("omits attribution identifiers when the caller is not orchestrated", () => {
    const recorder = vi.fn();
    const observe = createAuthorizationOutcomeObserver({
      surface: "verify",
      commandId: "verify",
      recorder,
      sessionId: "session-1",
      toolCallId: "call-1",
      attribution: { orchestrated: false, role: "worker", delegationId: "delegation-1" },
    });

    observe?.({
      outcome: "authorized",
      decisionPersisted: false,
      promptEmitted: false,
      promptWaitMs: 0,
    });

    const [record] = recorder.mock.calls[0] as [Record<string, unknown>];
    expect("role" in record).toBe(false);
    expect("delegationId" in record).toBe(false);
  });

  it("omits observer role and delegation identity when absent", () => {
    const recorder = vi.fn();
    const observe = createAuthorizationOutcomeObserver({
      surface: "verify",
      commandId: "verify",
      recorder,
      sessionId: "session-1",
      toolCallId: "call-1",
    });

    observe?.({
      outcome: "authorized",
      decisionPersisted: false,
      promptEmitted: false,
      promptWaitMs: 0,
    });

    const [record] = recorder.mock.calls[0] as [Record<string, unknown>];
    expect("role" in record).toBe(false);
    expect("delegationId" in record).toBe(false);
  });

  it("emits decision source from the observed core and omits it when absent", () => {
    const recorder = vi.fn();
    const observe = createAuthorizationOutcomeObserver({
      surface: "environment",
      commandId: "environment",
      recorder,
      sessionId: "session-1",
      toolCallId: "call-1",
    });

    observe?.({
      outcome: "authorized",
      decisionPersisted: false,
      promptEmitted: false,
      promptWaitMs: 0,
      decisionSource: "prompt",
    });
    const [withSource] = recorder.mock.calls[0] as [{ decisionSource?: string }];
    expect(withSource.decisionSource).toBe("prompt");

    observe?.({
      outcome: "not-authorized",
      decisionPersisted: false,
      promptEmitted: false,
      promptWaitMs: 0,
    });
    const [withoutSource] = recorder.mock.calls[1] as [Record<string, unknown>];
    expect("decisionSource" in withoutSource).toBe(false);
  });
});

describe("authorization outcome recorder", () => {
  it("appends custom entries and JSONL stream records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bash-tools-auth-"));
    const streamPath = join(directory, "nested", "invocations.jsonl");
    const appendEntry = vi.fn();
    const recorder = createAuthorizationOutcomeRecorder(
      { appendEntry },
      { [BASH_TOOLS_INVOCATIONS_PATH]: streamPath },
    );
    const record = buildAuthorizationOutcomeRecord(input());

    recorder(record);

    expect(appendEntry).toHaveBeenCalledWith(AUTHORIZATION_OUTCOME_ENTRY_TYPE, record);
    const stream = await readFile(streamPath, "utf8");
    expect(stream.trimEnd()).toBe(JSON.stringify(record));
    await rm(directory, { recursive: true, force: true });
  });

  it("ignores unset stream configuration", () => {
    const appendEntry = vi.fn();
    const recorder = createAuthorizationOutcomeRecorder({ appendEntry }, {});

    recorder(buildAuthorizationOutcomeRecord(input()));

    expect(appendEntry).toHaveBeenCalledOnce();
  });
});
