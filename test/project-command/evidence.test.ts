import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  createProjectCommandEvidenceRecord,
  createProjectCommandEvidenceStore,
  isEvidenceRecord,
} from "../../src/tools/project-command/evidence.ts";
import type { ProjectCommandOutputDetails } from "../../src/tools/project-command/output.ts";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function details(): ProjectCommandOutputDetails {
  const empty = { text: "", truncated: false, totalBytes: 0, totalLines: 0 };
  return {
    commandId: "workspace_path",
    projectPath: "/repo",
    fingerprint: "fingerprint",
    authFingerprint: "auth-fingerprint",
    toolCallId: "tool-call",
    reused: false,
    forced: false,
    cacheDecision: "miss",
    durationMs: 1,
    executionDurationMs: 1,
    scope: { cwdStrategy: "canonical-project", projectPath: "/repo" },
    status: "success",
    category: "PASS",
    executed: true,
    exit: { code: 0, signal: null },
    timedOut: false,
    cancelled: false,
    stdout: { text: "ok", truncated: false, totalBytes: 2, totalLines: 1 },
    stderr: empty,
    output: {
      stdout: { truncated: false, totalBytes: 2, totalLines: 1 },
      stderr: empty,
    },
    resolvedCommand: "/bin/pwd",
    parameters: {},
  };
}

function record(scope: "session" | "flow" = "session") {
  return createProjectCommandEvidenceRecord(details(), {
    repositoryState: {
      repositoryIdentity: "/repo",
      head: "HEAD",
      dirtyFilesDigest: "clean",
    },
    producerScope: scope,
    ...(scope === "flow" ? { flowId: "flow-a" } : {}),
    provenance:
      scope === "flow"
        ? { scope: "flow", flowId: "flow-a", producerInvocationId: "producer" }
        : { scope: "session", producerInvocationId: "producer" },
  });
}

function recordWithDetails(overrides: Record<string, unknown>) {
  return createProjectCommandEvidenceRecord(
    { ...details(), ...overrides },
    {
      repositoryState: {
        repositoryIdentity: "/repo",
        head: "HEAD",
        dirtyFilesDigest: "clean",
      },
      producerScope: "session",
      provenance: { scope: "session", producerInvocationId: "producer" },
    },
  );
}

it("validates complete records on in-memory lookup and rejects malformed replacements", () => {
  const store = createProjectCommandEvidenceStore();
  const valid = record();
  expect(isEvidenceRecord(valid)).toBe(true);
  store.set(valid);
  expect(store.getByRef(valid.ref)).toEqual(valid);

  const rejectionStore = createProjectCommandEvidenceStore();
  rejectionStore.set({ ...valid, key: "not-the-content-key" });
  expect(rejectionStore.getByRef(valid.ref)).toBeUndefined();

  const malformedCategory = { ...valid, details: { ...valid.details } };
  Reflect.set(malformedCategory.details, "category", "UNSUPPORTED");
  expect(isEvidenceRecord(malformedCategory)).toBe(false);
  rejectionStore.set(malformedCategory);
  expect(rejectionStore.getByRef(valid.ref)).toBeUndefined();

  const fractionalDuration = {
    ...valid,
    details: { ...valid.details, durationMs: 1.5 },
  };
  expect(isEvidenceRecord(fractionalDuration)).toBe(false);

  const malformed = {
    ...valid,
    details: {
      ...valid.details,
      output: {
        ...valid.details.output,
        stdout: { ...valid.details.output.stdout },
      },
    },
  };
  Reflect.deleteProperty(malformed.details.output.stdout, "truncated");
  rejectionStore.set(malformed);
  expect(rejectionStore.getByRef(valid.ref)).toBeUndefined();
});

it("rejects unsupported categories on durable reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "bash-tools-evidence-category-"));
  roots.push(root);
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const store = createProjectCommandEvidenceStore({ rootDirectory: root });
  const valid = record("flow");
  store.set(valid, "flow-a");

  const directory = join(root, "flows", "flow-a", "project-command");
  const [fileName] = await readdir(directory);
  if (fileName === undefined) throw new Error("missing persisted evidence file");
  const filePath = join(directory, fileName);
  const serialized = await readFile(filePath, "utf8");
  const corrupted = serialized.replace('"category":"PASS"', '"category":"UNSUPPORTED"');
  expect(corrupted).not.toBe(serialized);
  await writeFile(filePath, corrupted, "utf8");

  const reloaded = createProjectCommandEvidenceStore({ rootDirectory: root });
  expect(reloaded.getByRef(valid.ref, "flow-a")).toBeUndefined();
});

it("rejects malformed publication sources already present in the store", () => {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const store = createProjectCommandEvidenceStore();
  const valid = record("flow");
  expect(store.set(valid, "flow-a")).toBe(true);
  if (valid.provenance === undefined) throw new Error("missing provenance");
  Object.assign(valid.provenance, { flowId: "flow-b" });

  expect(
    store.publish(valid.ref, "flow-a", "/repo", {
      scope: "flow",
      flowId: "flow-a",
      published: true,
    }),
  ).toBe(false);
});

it("rejects malformed final publication records", () => {
  vi.unstubAllEnvs();
  const store = createProjectCommandEvidenceStore();
  const valid = record();
  expect(store.set(valid)).toBe(true);

  expect(
    store.publish(valid.ref, "flow-a", "/repo", {
      scope: "flow",
      flowId: "flow-a",
      published: true,
      error: "x".repeat(257),
    }),
  ).toBe(false);
});

it("does not expose flow evidence when durable storage fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "bash-tools-evidence-failure-"));
  roots.push(root);
  const brokenRoot = join(root, "not-a-directory");
  await writeFile(brokenRoot, "not a directory", "utf8");
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const store = createProjectCommandEvidenceStore({ rootDirectory: brokenRoot });
  const valid = record("flow");

  expect(store.set(valid, "flow-a")).toBe(false);
  expect(store.getByRef(valid.ref, "flow-a")).toBeUndefined();
  expect(
    store.publish(valid.ref, "flow-a", "/repo", {
      scope: "flow",
      flowId: "flow-a",
      published: true,
    }),
  ).toBe(false);
});

it("requires repository-compatible publication and confirms the durable write", async () => {
  vi.unstubAllEnvs();
  const root = await mkdtemp(join(tmpdir(), "bash-tools-evidence-"));
  roots.push(root);
  const store = createProjectCommandEvidenceStore({ rootDirectory: root });
  const valid = record();
  store.set(valid);

  const publication = { scope: "flow" as const, flowId: "flow-a", published: true };
  expect(store.publish(valid.ref, "flow-a", "/other-repository", publication)).toBe(false);
  expect(store.publish(valid.ref, "flow-a", "/repo", publication)).toBe(true);

  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const reloaded = createProjectCommandEvidenceStore({ rootDirectory: root });
  expect(reloaded.getByRef(valid.ref, "flow-a")).toMatchObject({
    ref: valid.ref,
    publication: { scope: "flow", flowId: "flow-a", published: true },
    provenance: { scope: "flow", flowId: "flow-a" },
  });
});

it("rejects publication from one effective flow into another", () => {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const store = createProjectCommandEvidenceStore();
  const flowRecord = createProjectCommandEvidenceRecord(details(), {
    repositoryState: {
      repositoryIdentity: "/repo",
      head: "HEAD",
      dirtyFilesDigest: "clean",
    },
    producerScope: "flow",
    flowId: "flow-a",
    provenance: { scope: "flow", flowId: "flow-a" },
  });
  store.set(flowRecord, "flow-a");
  expect(
    store.publish(flowRecord.ref, "flow-b", "/repo", {
      scope: "flow",
      flowId: "flow-b",
      published: true,
    }),
  ).toBe(false);
});

it("rejects malformed evidence details across nested validation branches", () => {
  const valid = record();
  const oversizedParameters = Object.fromEntries(
    Array.from({ length: 129 }, (_, index) => [`parameter-${index}`, true]),
  );
  const malformed: readonly [string, Record<string, unknown>][] = [
    ["details ref", { ref: "pc_wrong" }],
    ["command id", { commandId: "c".repeat(129) }],
    ["project path", { projectPath: "p".repeat(4097) }],
    ["fingerprint", { fingerprint: "f".repeat(257) }],
    ["auth fingerprint", { authFingerprint: "a".repeat(257) }],
    ["tool call id", { toolCallId: "t".repeat(257) }],
    ["producer scope", { producerScope: "other" }],
    ["reused", { reused: "false" }],
    ["cache decision", { cacheDecision: "unknown" }],
    ["duration", { durationMs: 1.5 }],
    ["scope", { scope: { cwdStrategy: "other", projectPath: "/repo" } }],
    ["status", { status: "unknown" }],
    ["category", { category: "UNSUPPORTED" }],
    ["executed", { executed: "true" }],
    ["error", { error: { category: "PASS" } }],
    ["exit", { exit: { code: 256, signal: null } }],
    ["timed out", { timedOut: "false" }],
    ["cancelled", { cancelled: "false" }],
    ["stdout", { stdout: { text: "", totalBytes: 0, totalLines: 0, truncated: "false" } }],
    ["output metadata", { output: { stdout: {}, stderr: valid.details.output.stderr } }],
    ["diagnostic", { diagnostic: "d".repeat(50 * 1024 + 1) }],
    ["suggested action", { suggestedAction: "s".repeat(1025) }],
    ["resolved command", { resolvedCommand: "r".repeat(50 * 1024 + 1) }],
    ["parameters", { parameters: oversizedParameters }],
    ["optional fingerprint", { resultFingerprint: "r".repeat(257) }],
    ["optional fingerprint version", { resultFingerprintVersion: 2 }],
    ["policy id", { policyId: "p".repeat(257) }],
    ["reuse policy id", { reusePolicyId: "r".repeat(257) }],
    ["relevant inputs", { relevantInputs: null }],
    ["producer invocation", { producerInvocationId: "i".repeat(257) }],
    ["node version", { nodeVersion: "n".repeat(129) }],
    ["manifest present", { manifestPresent: "true" }],
    ["scripts", { scripts: [1] }],
    ["applicable commands", { applicableCommands: ["a".repeat(257)] }],
    ["covers", { covers: Array.from({ length: 65 }, () => "cover") }],
    ["publication", { publication: { scope: "session" } }],
    ["provenance", { provenance: { scope: "flow" } }],
    ["repository state", { repositoryState: { repositoryIdentity: 1 } }],
    ["recorded state", { recordedRepositoryState: { head: 1 } }],
    ["current state", { currentRepositoryState: { head: 1 } }],
    ["repository state status", { repositoryStateStatus: "unknown" }],
    ["shared execution", { sharedExecution: "false" }],
    ["coercions", { coercions: ["c".repeat(129)] }],
    ["mutating", { mutating: "false" }],
    ["concurrent executions", { concurrentExecutions: 257 }],
    ["state drift", { stateDrift: "false" }],
    ["project info", { projectInfo: "x".repeat(64 * 1024 + 1) }],
    ["package manager", { packageManager: "x".repeat(16 * 1024 + 1) }],
  ];

  for (const [label, overrides] of malformed) {
    expect(isEvidenceRecord({ ...valid, details: { ...valid.details, ...overrides } }), label).toBe(
      false,
    );
  }

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(isEvidenceRecord({ ...valid, details: { ...valid.details, parameters: cyclic } })).toBe(
    false,
  );
  expect(isEvidenceRecord({ ...valid, details: { ...valid.details, projectInfo: cyclic } })).toBe(
    false,
  );
});

it("accepts evidence details at configured boundaries", () => {
  const projectPath = "p".repeat(4096);
  const parameters = Object.fromEntries(
    Array.from({ length: 128 }, (_, index) => [`parameter-${index}`, true]),
  );
  const state = {
    repositoryIdentity: "r".repeat(4096),
    head: "h".repeat(512),
    dirtyFilesDigest: "d".repeat(256),
  };
  const boundary = recordWithDetails({
    commandId: "c".repeat(128),
    projectPath,
    fingerprint: "f".repeat(256),
    authFingerprint: "a".repeat(256),
    toolCallId: "t".repeat(256),
    durationMs: 24 * 60 * 60 * 1000,
    executionDurationMs: 24 * 60 * 60 * 1000,
    scope: { cwdStrategy: "canonical-project", projectPath },
    stdout: {
      text: "x".repeat(50 * 1024),
      truncated: false,
      totalBytes: 2 * 1024 * 1024,
      totalLines: 4_000_000,
    },
    stderr: {
      text: "x".repeat(50 * 1024),
      truncated: true,
      totalBytes: 2 * 1024 * 1024,
      totalLines: 4_000_000,
    },
    output: {
      stdout: { truncated: false, totalBytes: 2 * 1024 * 1024, totalLines: 4_000_000 },
      stderr: { truncated: true, totalBytes: 2 * 1024 * 1024, totalLines: 4_000_000 },
    },
    resolvedCommand: "r".repeat(50 * 1024),
    parameters,
    diagnostic: "d".repeat(50 * 1024),
    suggestedAction: "s".repeat(1024),
    resultFingerprint: "r".repeat(256),
    resultFingerprintVersion: 1,
    policyId: "p".repeat(256),
    reusePolicyId: "u".repeat(256),
    relevantInputs: parameters,
    producerInvocationId: "i".repeat(256),
    nodeVersion: "n".repeat(128),
    manifestPresent: true,
    scripts: Array.from({ length: 256 }, () => "s".repeat(256)),
    applicableCommands: Array.from({ length: 256 }, () => "a".repeat(256)),
    covers: Array.from({ length: 64 }, () => "c".repeat(512)),
    repositoryState: state,
    recordedRepositoryState: state,
    currentRepositoryState: state,
    repositoryStateStatus: "unreadable",
    sharedExecution: false,
    coercions: Array.from({ length: 32 }, () => "c".repeat(128)),
    mutating: false,
    concurrentExecutions: 256,
    stateDrift: false,
    projectInfo: { value: "project" },
    packageManager: { value: "npm" },
  });
  expect(isEvidenceRecord(boundary)).toBe(true);
});

it("validates the evidence envelope and publication scope boundaries", () => {
  const valid = record();
  const malformed: readonly [string, Record<string, unknown>][] = [
    ["format version", { evidenceFormatVersion: 2 }],
    ["key", { key: "not-the-content-key" }],
    ["ref", { ref: "invalid-ref" }],
    ["covers", { covers: Array.from({ length: 65 }, () => "cover") }],
    ["cover item", { covers: [1] }],
    ["created at", { createdAt: -1 }],
    ["repository state", { repositoryState: { head: 1 } }],
    ["provenance", { provenance: { scope: "other" } }],
    ["publication", { publication: { scope: "session" } }],
    ["producer scope", { producerScope: "other" }],
    ["flow id", { flowId: "f".repeat(65) }],
    ["producer role", { producerRole: "r".repeat(65) }],
    ["delegation id", { producerDelegationId: "d".repeat(65) }],
  ];
  for (const [label, overrides] of malformed) {
    expect(isEvidenceRecord({ ...valid, ...overrides }), label).toBe(false);
  }

  expect(
    isEvidenceRecord({
      ...valid,
      covers: Array.from({ length: 64 }, () => "c".repeat(512)),
      createdAt: Number.MAX_SAFE_INTEGER,
      repositoryState: {
        repositoryIdentity: "r".repeat(4096),
        head: "h".repeat(512),
        dirtyFilesDigest: "d".repeat(256),
      },
      provenance: {
        scope: "session",
        flowId: "f".repeat(64),
        repositoryIdentity: "r".repeat(4096),
      },
      publication: {
        scope: "flow",
        flowId: "f".repeat(64),
        published: false,
      },
      producerScope: "session",
      flowId: "f".repeat(64),
      producerRole: "r".repeat(64),
      producerDelegationId: "d".repeat(64),
    }),
  ).toBe(true);

  const flow = record("flow");
  expect(isEvidenceRecord(flow, "flow-a")).toBe(true);
  expect(isEvidenceRecord(flow, "flow-b")).toBe(false);
  expect(isEvidenceRecord(valid, "flow-a")).toBe(false);
});
