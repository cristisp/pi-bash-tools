import { writeFile, realpath } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  getProjectCommandDefinition,
  projectCommandIdentity,
} from "../../src/tools/project-command/definitions.ts";
import type {
  ProjectCommandEvidenceRecord,
  ProjectCommandEvidenceStore,
} from "../../src/tools/project-command/evidence.ts";
import {
  PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS,
  projectCommandModelContent,
} from "../../src/tools/project-command/model-content.ts";
import type { ProjectCommandOutputDetails } from "../../src/tools/project-command/output.ts";
import { resolveFixedProjectCommand } from "../../src/tools/project-command/resolution.ts";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";
import { authorize } from "./tool-execution-helpers.ts";
import { cleanupProjectCommandFixtures, context, fixture } from "./tool-test-fixtures.ts";

afterEach(cleanupProjectCommandFixtures);

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedTextContent(response: {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}): Record<string, unknown> {
  const entry = response.content[0];
  if (entry?.type !== "text") throw new Error("expected text content");
  const parsed: unknown = JSON.parse(entry.text ?? "");
  if (!isRecordObject(parsed)) throw new Error("expected serialized object content");
  return parsed;
}

function detailsFixture(
  overrides: Partial<ProjectCommandOutputDetails> = {},
): ProjectCommandOutputDetails {
  return {
    commandId: "node_test",
    projectPath: "/project",
    fingerprint: "auth-fingerprint-value",
    authFingerprint: "auth-fingerprint-value",
    resultFingerprint: "result-fingerprint-value",
    resultFingerprintVersion: 1,
    policyId: "policy-id-value",
    reusePolicyId: "static",
    toolCallId: "tool-call-1",
    relevantInputs: { files: [], values: [] },
    producerInvocationId: "producer-1",
    reused: false,
    forced: false,
    cacheDecision: "miss",
    durationMs: 42,
    executionDurationMs: 40,
    scope: { cwdStrategy: "canonical-project", projectPath: "/project" },
    status: "success",
    category: "PASS",
    executed: true,
    exit: { code: 0, signal: null },
    timedOut: false,
    cancelled: false,
    stdout: { text: "out", truncated: false, totalBytes: 3, totalLines: 1 },
    stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    output: {
      stdout: { truncated: false, totalBytes: 3, totalLines: 1 },
      stderr: { truncated: false, totalBytes: 0, totalLines: 1 },
    },
    resolvedCommand: "npm run test",
    parameters: { paths: ["fixture.js"] },
    projectInfo: { nodeVersion: "v24.0.0", manifestPresent: true },
    nodeVersion: "v24.0.0",
    manifestPresent: true,
    packageManager: "npm@10.0.0",
    scripts: ["test"],
    applicableCommands: ["node_test"],
    ...overrides,
  };
}

const OMITTED_INTERNAL_KEYS = [
  "fingerprint",
  "authFingerprint",
  "resultFingerprint",
  "resultFingerprintVersion",
  "policyId",
  "reusePolicyId",
  "relevantInputs",
  "producerInvocationId",
  "toolCallId",
  "durationMs",
  "executionDurationMs",
  "scope",
  "output",
] as const;

describe("projectCommandModelContent", () => {
  it("retains model-facing command, status, and output fields", () => {
    const content = projectCommandModelContent(
      detailsFixture({
        diagnostic: "some diagnostic",
        suggestedAction: "some action",
      }),
    );
    expect(content).toMatchObject({
      commandId: "node_test",
      projectPath: "/project",
      status: "success",
      category: "PASS",
      executed: true,
      exit: { code: 0, signal: null },
      timedOut: false,
      cancelled: false,
      resolvedCommand: "npm run test",
      parameters: { paths: ["fixture.js"] },
      diagnostic: "some diagnostic",
      suggestedAction: "some action",
      reused: false,
      forced: false,
      cacheDecision: "miss",
      projectInfo: { nodeVersion: "v24.0.0", manifestPresent: true },
      nodeVersion: "v24.0.0",
      manifestPresent: true,
      packageManager: "npm@10.0.0",
      scripts: ["test"],
      applicableCommands: ["node_test"],
    });
    expect(content.stdout).toMatchObject({
      text: "out",
      truncated: false,
      totalBytes: 3,
      totalLines: 1,
    });
    expect(content.stderr).toMatchObject({
      text: "",
      truncated: false,
      totalBytes: 0,
      totalLines: 0,
    });
  });

  it("omits internal authorization, cache, fingerprint, and timing metadata", () => {
    const content = projectCommandModelContent(detailsFixture());
    for (const key of OMITTED_INTERNAL_KEYS) {
      expect(content, `content must not expose ${key}`).not.toHaveProperty(key);
    }
  });

  it("includes the evidence reference when defined and omits the key otherwise", () => {
    const withRef = projectCommandModelContent(detailsFixture({ ref: "pc_example" }));
    expect(withRef.ref).toBe("pc_example");

    const withoutRef = projectCommandModelContent(detailsFixture());
    expect("ref" in withoutRef).toBe(false);
    expect(withoutRef).not.toHaveProperty("ref");
  });

  it("includes the publication outcome when defined and omits the key otherwise", () => {
    const published = projectCommandModelContent(
      detailsFixture({
        ref: "pc_example",
        publication: { scope: "flow", flowId: "flow-a", published: true },
      }),
    );
    expect(published.publication).toEqual({ scope: "flow", flowId: "flow-a", published: true });

    const failed = projectCommandModelContent(
      detailsFixture({
        ref: "pc_example",
        publication: {
          scope: "flow",
          flowId: "flow-a",
          published: false,
          error: "Evidence publication was not available from the producer scope.",
        },
      }),
    );
    expect(failed.publication).toEqual({
      scope: "flow",
      flowId: "flow-a",
      published: false,
      error: "Evidence publication was not available from the producer scope.",
    });

    const withoutPublication = projectCommandModelContent(detailsFixture({ ref: "pc_example" }));
    expect("publication" in withoutPublication).toBe(false);
    expect(withoutPublication).not.toHaveProperty("publication");
  });

  it("never emits undefined-valued keys", () => {
    const content = projectCommandModelContent(detailsFixture());
    for (const [key, value] of Object.entries(content)) {
      expect(value, `content must define a value for ${key}`).not.toBeUndefined();
    }
    const keys = Object.keys(content);
    expect(keys).not.toContain("ref");
    expect(keys).not.toContain("publication");
  });

  it("sanitizes ANSI escape and control sequences from output text", () => {
    const content = projectCommandModelContent(
      detailsFixture({
        stdout: {
          text: "\u001b[31mred error\u001b[0m\u0007bell\u001b]0;title\u0007ok\r\nline2",
          truncated: false,
          totalBytes: 40,
          totalLines: 2,
        },
        stderr: {
          text: "\u001b[2Kclear\u009bdirect",
          truncated: false,
          totalBytes: 12,
          totalLines: 1,
        },
      }),
    );
    const stdout = content.stdout;
    const stderr = content.stderr;
    expect(stdout.text).toBe("red errorbellok\nline2");
    expect(stderr.text).toBe("clearirect");
    for (const character of stdout.text + stderr.text) {
      const codePoint = character.codePointAt(0) ?? -1;
      expect(codePoint === 0x1b || (codePoint >= 0x80 && codePoint <= 0x9f)).toBe(false);
    }
  });

  it("compacts long output while preserving both head and tail", () => {
    const head = "HEAD-".padEnd(80, "h");
    const tail = "TAIL-".padStart(80, "t");
    const middle = "m".repeat(PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS * 3);
    const text = `${head}${middle}${tail}`;
    const content = projectCommandModelContent(
      detailsFixture({
        stdout: { text, truncated: true, totalBytes: text.length, totalLines: 1 },
      }),
    );
    const stdout = content.stdout;
    expect(stdout.truncated).toBe(true);
    expect(stdout.text.startsWith(head)).toBe(true);
    expect(stdout.text.endsWith(tail)).toBe(true);
    expect(stdout.text).toContain("output truncated");
    expect(stdout.text.length).toBeLessThanOrEqual(PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS);
  });

  it("keeps short output intact without truncation markers", () => {
    const content = projectCommandModelContent(detailsFixture());
    const stdout = content.stdout;
    expect(stdout.text).toBe("out");
  });

  it("handles exact compaction boundaries and preserves valid Unicode", () => {
    const exact = projectCommandModelContent(
      detailsFixture({
        stdout: {
          text: "x".repeat(PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS),
          truncated: false,
          totalBytes: PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS,
          totalLines: 1,
        },
      }),
    ).stdout.text;
    expect(exact).toHaveLength(PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS);
    expect(exact).not.toContain("output truncated");

    const sourceWasNotTruncated = projectCommandModelContent(
      detailsFixture({
        stdout: {
          text: "y".repeat(PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS + 1),
          truncated: false,
          totalBytes: PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS + 1,
          totalLines: 1,
        },
      }),
    ).stdout;
    expect(sourceWasNotTruncated.truncated).toBe(true);
    expect(sourceWasNotTruncated.text).toHaveLength(PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS);

    const over = projectCommandModelContent(
      detailsFixture({
        stdout: {
          text: `${"x".repeat(PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS)}😀tail`,
          truncated: true,
          totalBytes: PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS + 8,
          totalLines: 1,
        },
      }),
    ).stdout.text;
    expect(over.length).toBeLessThanOrEqual(PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS);
    expect(over).toContain("😀");
    expect(() => encodeURIComponent(over)).not.toThrow();
    expect(JSON.parse(JSON.stringify(over))).toBe(over);
  });

  it("serializes projected content through a real tool response without internal metadata", async () => {
    const fixtureData = await fixture();
    const definition = (
      await import("../../src/tools/project-command/definitions.ts")
    ).getProjectCommandDefinition("workspace_path");
    if (definition === undefined) throw new Error("missing workspace_path definition");
    const resolved = resolveFixedProjectCommand(definition);
    const projectPath = await realpath(fixtureData.directory);
    await writeFile(
      fixtureData.configPath,
      JSON.stringify({
        version: 2,
        environment: { version: 1 },
        projectCommands: {
          version: 1,
          global: { allow: [], deny: [] },
          projects: {
            [projectPath]: { allow: [projectCommandIdentity(definition, resolved)], deny: [] },
          },
        },
      }),
    );
    const tool = createProjectCommandToolForTesting({
      configPath: fixtureData.configPath,
      executor: async (_resolved, cwd) => ({
        status: "success" as const,
        exit: { code: 0, signal: null },
        timedOut: false,
        cancelled: false,
        stdout: {
          text: `\u001b[32m${cwd}\u001b[0m`,
          truncated: false,
          totalBytes: cwd.length + 9,
          totalLines: 1,
        },
        stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
      }),
    });
    const response = await tool.execute(
      "model-content-check",
      { commandId: "workspace_path" },
      undefined,
      undefined,
      context(fixtureData.directory),
    );
    const entry = response.content[0];
    if (entry?.type !== "text") throw new Error("expected text content");
    const parsed: unknown = JSON.parse(entry.text);
    if (!isRecordObject(parsed)) throw new Error("expected serialized object content");
    const content = parsed;
    expect(content).toMatchObject({
      commandId: "workspace_path",
      status: "success",
      category: "PASS",
      resolvedCommand: expect.any(String),
    });
    expect(content.stdout).toMatchObject({
      text: expect.stringMatching(/^[^[]/u),
    });
    for (const key of OMITTED_INTERNAL_KEYS) {
      expect(content, `serialized content must not expose ${key}`).not.toHaveProperty(key);
    }
    const ref = content.ref;
    expect(typeof ref === "string" && ref.startsWith("pc_")).toBe(true);
    expect("publication" in content).toBe(false);
  });

  it("serializes the evidence reference for executions and lookups", async () => {
    const fixtureData = await fixture();
    const definition = getProjectCommandDefinition("workspace_path");
    if (definition === undefined) throw new Error("missing workspace_path definition");
    const resolved = resolveFixedProjectCommand(definition);
    await authorize(fixtureData, definition, resolved);
    let storedRecord: ProjectCommandEvidenceRecord | undefined;
    const evidence: ProjectCommandEvidenceStore = {
      getByRef: (ref) => (storedRecord?.ref === ref ? storedRecord : undefined),
      set: (record) => {
        storedRecord = record;
        return true;
      },
      publish: () => false,
      clear: () => {
        storedRecord = undefined;
      },
    };
    const tool = createProjectCommandToolForTesting({
      configPath: fixtureData.configPath,
      evidence,
      executor: async (_resolved, cwd) => ({
        status: "success" as const,
        exit: { code: 0, signal: null },
        timedOut: false,
        cancelled: false,
        stdout: { text: cwd, truncated: false, totalBytes: cwd.length, totalLines: 1 },
        stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
      }),
    });
    const executed = await tool.execute(
      "serialized-ref-producer",
      { commandId: "workspace_path" },
      undefined,
      undefined,
      context(fixtureData.directory),
    );
    const ref = executed.details.ref;
    if (typeof ref !== "string") throw new Error("expected an evidence reference");
    const executedContent = parsedTextContent(executed);
    expect(executedContent.ref).toBe(ref);
    expect("publication" in executedContent).toBe(false);

    const lookedUp = await tool.execute(
      "serialized-ref-lookup",
      { ref },
      undefined,
      undefined,
      context(fixtureData.directory),
    );
    const lookedUpContent = parsedTextContent(lookedUp);
    expect(lookedUpContent.ref).toBe(ref);
    expect("publication" in lookedUpContent).toBe(false);
  });
});
