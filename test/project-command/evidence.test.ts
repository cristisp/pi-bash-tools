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
