import { describe, expect, it } from "vitest";

import {
  isSafeFailureTail,
  isVerifyStepResult,
} from "../../src/tools/verify/cache/step-validation.ts";
import { isVerifyEvidenceRecord } from "../../src/tools/verify/cache/validation.ts";

const MAX_TEXT = 50 * 1024;
const MAX_TAIL = 8 * 1024;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const ANSI_ESCAPE = "\u001b";
const RECORD_KEY = "request-key";

function output(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: "",
    truncated: false,
    totalBytes: 0,
    totalLines: 0,
    ...overrides,
  };
}

function step(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "test",
    status: "passed",
    verdict: "passed",
    exitCode: 0,
    signal: null,
    durationMs: 0,
    executed: true,
    stdout: output(),
    stderr: output(),
    ...overrides,
  };
}

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const phases = ["format", "lint", "typecheck", "test"] as const;
  const perStep = phases.map((phase) =>
    step({ phase, command: `pnpm run ${phase}`, resolvedCommand: `pnpm run ${phase}` }),
  );
  return {
    cacheFormatVersion: 2,
    key: "request-key",
    ref: "vr_request-key",
    projectPath: "/tmp/verify-project",
    resolvedCommands: ["pnpm run format"],
    perStep,
    verdict: "passed",
    covers: [],
    createdAt: 0,
    ...overrides,
  };
}

describe("isVerifyStepResult", () => {
  it.each([
    ["passed", { status: "passed", verdict: "passed", executed: true, exitCode: 0 }],
    ["failed", { status: "failed", verdict: "failed", executed: true, exitCode: 1 }],
    ["omitted", { status: "omitted", verdict: "omitted", executed: false, exitCode: null }],
    ["not-run", { status: "not-run", verdict: "not-run", executed: false, exitCode: null }],
  ] as const)("accepts a valid %s step", (_status, overrides) => {
    expect(isVerifyStepResult(step(overrides))).toBe(true);
  });

  it.each([
    ["passed", "passed", false],
    ["failed", "failed", false],
    ["omitted", "omitted", true],
    ["not-run", "not-run", true],
  ] as const)("rejects %s with executed=%s", (status, verdict, executed) => {
    expect(isVerifyStepResult(step({ status, verdict, executed }))).toBe(false);
  });

  it.each([
    ["passed", "failed", true],
    ["failed", "passed", true],
    ["omitted", "not-run", false],
    ["not-run", "omitted", false],
  ] as const)("rejects %s with a mismatched verdict", (status, verdict, executed) => {
    expect(isVerifyStepResult(step({ status, verdict, executed }))).toBe(false);
  });

  it.each(["unknown", "", null, 1])("rejects an invalid status %j", (status) => {
    expect(isVerifyStepResult(step({ status, verdict: status, executed: false }))).toBe(false);
  });

  it("accepts omitted optional fields", () => {
    expect(isVerifyStepResult(step())).toBe(true);
  });

  it("accepts optional fields at their maximum valid lengths", () => {
    expect(
      isVerifyStepResult(
        step({
          command: "c".repeat(4096),
          resolvedCommand: "r".repeat(4096),
          executable: "e".repeat(4096),
          args: ["a".repeat(4096)],
          script: "s".repeat(128),
          signal: "g".repeat(128),
          reason: "n".repeat(1024),
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ["command", { command: "" }],
    ["resolvedCommand", { resolvedCommand: "" }],
    ["command length", { command: "c".repeat(4097) }],
    ["resolvedCommand length", { resolvedCommand: "r".repeat(4097) }],
    ["executable length", { executable: "e".repeat(4097) }],
    ["argument length", { args: ["a".repeat(4097)] }],
    ["script length", { script: "s".repeat(129) }],
    ["signal length", { signal: "g".repeat(129) }],
    ["reason length", { reason: "n".repeat(1025) }],
  ] as const)("rejects an invalid optional %s", (_field, overrides) => {
    expect(isVerifyStepResult(step(overrides))).toBe(false);
  });

  it("accepts output exactly at each limit in both streams", () => {
    const boundedOutput = output({
      text: "x".repeat(MAX_TEXT),
      totalBytes: MAX_TEXT,
      totalLines: MAX_TEXT,
    });
    expect(isVerifyStepResult(step({ stdout: boundedOutput, stderr: boundedOutput }))).toBe(true);
  });

  it.each([
    ["text", { text: "x".repeat(MAX_TEXT + 1) }],
    ["totalBytes", { totalBytes: MAX_TEXT + 1 }],
    ["totalLines", { totalLines: MAX_TEXT + 1 }],
  ] as const)("rejects output over the %s limit in either stream", (_field, overrides) => {
    for (const stream of ["stdout", "stderr"] as const) {
      expect(isVerifyStepResult(step({ [stream]: output(overrides) }))).toBe(false);
    }
  });

  it.each([null, -1, 0, 255] as const)("accepts exit code %s", (exitCode) => {
    expect(isVerifyStepResult(step({ exitCode }))).toBe(true);
  });

  it.each([-2, 256, 1.5, Number.NaN, Number.POSITIVE_INFINITY] as const)(
    "rejects exit code %s",
    (exitCode) => {
      expect(isVerifyStepResult(step({ exitCode }))).toBe(false);
    },
  );

  it.each([0, MAX_DURATION_MS] as const)("accepts duration %s ms", (durationMs) => {
    expect(isVerifyStepResult(step({ durationMs }))).toBe(true);
  });

  it.each([-1, MAX_DURATION_MS + 1, 1.5, Number.NaN] as const)(
    "rejects duration %s ms",
    (durationMs) => {
      expect(isVerifyStepResult(step({ durationMs }))).toBe(false);
    },
  );

  it("accepts a failed step with a failure tail at the maximum length", () => {
    expect(
      isVerifyStepResult(
        step({
          status: "failed",
          verdict: "failed",
          executed: true,
          exitCode: 1,
          failureTail: "f".repeat(MAX_TAIL),
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ["too long", "f".repeat(MAX_TAIL + 1)],
    ["ANSI escape", `failure${ANSI_ESCAPE}[31m`],
  ] as const)("rejects a failed step with a %s failure tail", (_reason, failureTail) => {
    expect(isVerifyStepResult(step({ status: "failed", verdict: "failed", failureTail }))).toBe(
      false,
    );
  });

  it.each(["passed", "omitted", "not-run"] as const)(
    "rejects a %s step with a failure tail",
    (status) => {
      expect(
        isVerifyStepResult(
          step({ status, verdict: status, executed: status === "passed", failureTail: "tail" }),
        ),
      ).toBe(false);
    },
  );
});

describe("isVerifyStepResult malformed values", () => {
  it.each([null, undefined, [], "step", 1])("rejects non-record input %j", (value) => {
    expect(isVerifyStepResult(value)).toBe(false);
  });

  it.each([
    ["phase", { phase: "format;rm -rf /" }],
    ["verdict", { verdict: "failed" }],
    ["executed", { executed: "true" }],
    ["exitCode", { exitCode: undefined }],
    ["signal", { signal: 9 }],
    ["args", { args: "run test" }],
    ["args item", { args: [1] }],
    ["stdout", { stdout: null }],
    ["stderr field", { stderr: { text: "", truncated: false, totalBytes: 0 } }],
    ["failureTail", { failureTail: 1 }],
    ["reason", { reason: 1 }],
  ] as const)("rejects a malformed %s", (_field, overrides) => {
    expect(isVerifyStepResult(step(overrides))).toBe(false);
  });

  it("accepts empty argument lists and omitted optional command metadata", () => {
    expect(isVerifyStepResult(step({ args: [] }))).toBe(true);
  });
});

describe("isSafeFailureTail", () => {
  it("allows an omitted tail for every status", () => {
    for (const status of ["passed", "failed", "omitted", "not-run"]) {
      expect(isSafeFailureTail(undefined, status)).toBe(true);
    }
  });

  it("accepts an empty failed tail and the exact maximum length", () => {
    expect(isSafeFailureTail("", "failed")).toBe(true);
    expect(isSafeFailureTail("f".repeat(MAX_TAIL), "failed")).toBe(true);
  });

  it("rejects oversized or ANSI-containing failed tails", () => {
    expect(isSafeFailureTail("f".repeat(MAX_TAIL + 1), "failed")).toBe(false);
    expect(isSafeFailureTail(`failure${ANSI_ESCAPE}[0m`, "failed")).toBe(false);
  });

  it.each(["passed", "omitted", "not-run"] as const)("rejects a nonempty tail for %s", (status) => {
    expect(isSafeFailureTail("tail", status)).toBe(false);
  });
});

describe("isVerifyEvidenceRecord boundary validation", () => {
  it("rejects malformed metadata and optional metadata fields", () => {
    const record = validRecord();
    expect(isVerifyEvidenceRecord(null)).toBe(false);
    expect(isVerifyEvidenceRecord([])).toBe(false);

    const malformed: readonly [string, Record<string, unknown>, string | undefined][] = [
      ["cache version", { cacheFormatVersion: 1 }, undefined],
      ["empty key", { key: "" }, undefined],
      ["oversized key", { key: "k".repeat(257) }, undefined],
      ["wrong logical key", {}, "different-request-key"],
      ["wrong ref", { ref: "vr_wrong" }, undefined],
      ["relative project path", { projectPath: "relative/path" }, undefined],
      ["oversized project path", { projectPath: `/${"p".repeat(4096)}` }, undefined],
      ["repository state", { repositoryState: { repositoryIdentity: 1 } }, undefined],
      [
        "repository working directory",
        {
          repositoryState: {
            repositoryIdentity: "repository",
            workingDirectory: "/tmp/other-project",
            head: "head",
            dirtyFilesDigest: "digest",
          },
        },
        undefined,
      ],
      ["provenance scope", { provenance: { scope: "unknown" } }, undefined],
      ["malformed provenance flow id", { provenance: { scope: "flow", flowId: 1 } }, undefined],
      ["publication", { publication: { flowId: "flow" } }, undefined],
      ["mutating", { mutating: "yes" }, undefined],
      ["concurrent executions", { concurrentExecutions: 257 }, undefined],
      ["state drift", { stateDrift: "yes" }, undefined],
      ["shared execution", { sharedExecution: "yes" }, undefined],
    ];

    for (const [label, overrides, logicalKey] of malformed) {
      expect(isVerifyEvidenceRecord({ ...record, ...overrides }, logicalKey), label).toBe(false);
    }
  });

  it("accepts metadata at every configured boundary", () => {
    const projectPath = `/${"p".repeat(4095)}`;
    const key = "k".repeat(256);
    expect(
      isVerifyEvidenceRecord({
        ...validRecord(),
        key,
        ref: `vr_${key.slice(0, 24)}`,
        projectPath,
        resolvedCommands: ["c".repeat(4096), "c".repeat(4096), "c".repeat(4096), "c".repeat(4096)],
        covers: Array.from({ length: 64 }, () => "x".repeat(512)),
        createdAt: Number.MAX_SAFE_INTEGER,
        repositoryState: {
          repositoryIdentity: "r".repeat(4096),
          workingDirectory: projectPath,
          head: "h".repeat(512),
          dirtyFilesDigest: "d".repeat(256),
        },
        provenance: {
          scope: "root",
          flowId: "f".repeat(64),
          repositoryIdentity: "r".repeat(4096),
        },
        publication: {
          flowId: "f".repeat(64),
          repositoryIdentity: "r".repeat(4096),
          producerScope: "root",
          published: false,
        },
        mutating: false,
        concurrentExecutions: 256,
        stateDrift: false,
        sharedExecution: false,
      }),
    ).toBe(true);
  });

  it("rejects malformed step arrays and outcome fields", () => {
    const record = validRecord();
    const perStep = Array.isArray(record.perStep) ? record.perStep : [];
    const cases: readonly [string, Record<string, unknown>][] = [
      ["commands not an array", { resolvedCommands: "pnpm run test" }],
      ["too many commands", { resolvedCommands: Array.from({ length: 5 }, () => "test") }],
      ["empty commands", { resolvedCommands: [] }],
      ["command item", { resolvedCommands: [1] }],
      ["steps not an array", { perStep: {} }],
      ["wrong step count", { perStep: [step()] }],
      ["wrong phase order", { perStep: [step({ phase: "lint" }), ...perStep.slice(1)] }],
      ["invalid verdict", { verdict: "unknown" }],
      ["failed without tail", { verdict: "failed" }],
      ["empty failure tail", { verdict: "failed", failureTail: "" }],
      ["oversized failure tail", { verdict: "failed", failureTail: "f".repeat(8193) }],
      ["failure tail on passed record", { failureTail: "tail" }],
      ["covers not an array", { covers: "AC-001" }],
      ["empty cover", { covers: [""] }],
      ["too many covers", { covers: Array.from({ length: 65 }, () => "cover") }],
      ["cover item", { covers: [1] }],
      ["negative createdAt", { createdAt: -1 }],
      ["fractional createdAt", { createdAt: 1.5 }],
      ["non-finite createdAt", { createdAt: Number.NaN }],
    ];
    for (const [label, overrides] of cases) {
      expect(isVerifyEvidenceRecord({ ...record, ...overrides }, RECORD_KEY), label).toBe(false);
    }
  });

  it("accepts consistent incomplete and failed verdicts", () => {
    const record = validRecord();
    const perStep = Array.isArray(record.perStep) ? record.perStep : [];
    const omitted = step({
      phase: "format",
      status: "omitted",
      verdict: "omitted",
      executed: false,
      exitCode: null,
    });
    expect(
      isVerifyEvidenceRecord(
        { ...record, verdict: "incomplete", perStep: [omitted, ...perStep.slice(1)] },
        RECORD_KEY,
      ),
    ).toBe(true);

    const notRun = step({
      phase: "format",
      status: "not-run",
      verdict: "not-run",
      executed: false,
      exitCode: null,
    });
    expect(
      isVerifyEvidenceRecord(
        {
          ...record,
          verdict: "failed",
          failureTail: "aggregate failure",
          perStep: [notRun, ...perStep.slice(1)],
        },
        RECORD_KEY,
      ),
    ).toBe(true);
  });
});
