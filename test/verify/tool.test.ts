/* oxlint-disable typescript/no-unsafe-type-assertion */

import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { AuthorizationOutcomeRecord } from "../../src/observability/authorization-outcome.ts";
import type { PolicyDecisionRequest, PolicyStore } from "../../src/tools/policy/types.ts";
import { createProjectCommandExecutor } from "../../src/tools/project-command/execution.ts";
import type { ProjectCommandExecutionOutcome } from "../../src/tools/project-command/execution.ts";
import {
  readNodeProjectInfo,
  resolveNodeProjectCommand,
} from "../../src/tools/project-command/node.ts";
import {
  createProjectCommandRepositoryStateReader,
  type ProjectCommandRepositoryStateReader,
} from "../../src/tools/project-command/repository-state.ts";
import type { ProjectCommandResolver } from "../../src/tools/project-command/resolution.ts";
import type { ProjectCommandExecutor } from "../../src/tools/project-command/runner.ts";
import {
  createVerifyEvidenceCache,
  isVerifyEvidenceCacheRecord,
  isVerifyEvidenceRecord,
} from "../../src/tools/verify/cache.ts";
import { validateVerifyInput } from "../../src/tools/verify/schema.ts";
import { createVerifyToolForTesting } from "../../src/tools/verify/tool.ts";
import type { VerifyToolContext } from "../../src/tools/verify/tool.ts";
import type { VerifyEvidenceRecord, VerifyPhase } from "../../src/tools/verify/types.ts";
import {
  createGitIntegrationFixtures,
  gitIntegration,
  makeRealGitExec,
} from "../git/integration-fixtures.ts";

const fixtureDirectories: string[] = [];
const gitFixtures = createGitIntegrationFixtures();

afterEach(async () => {
  await Promise.all([
    ...fixtureDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    gitFixtures.cleanup(),
  ]);
});

function context(cwd: string): VerifyToolContext {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui: { select: async () => "Allow once" },
  };
}

function policy(): PolicyStore {
  return {
    configPath: "test-policy",
    load: async (cwd) => ({
      projectPath: await realpath(cwd),
      confirmationTimeoutMs: 1000,
      document: {
        version: 2,
        environment: {
          version: 1,
          confirmationTimeoutMs: 1000,
          global: { allow: [], deny: [] },
          projects: {},
        },
        projectCommands: {
          version: 1,
          global: { allow: [], deny: [] },
          projects: {},
        },
      },
    }),
    recordDecisions: async () => undefined,
  };
}

function outcome(status: "success" | "nonzero"): ProjectCommandExecutionOutcome {
  return {
    status,
    exit: { code: status === "success" ? 0 : 1, signal: null },
    timedOut: false,
    cancelled: false,
    executed: true,
    stdout: { text: "stdout", truncated: false, totalBytes: 6, totalLines: 1 },
    stderr: {
      text: status === "success" ? "" : "failure tail",
      truncated: false,
      totalBytes: status === "success" ? 0 : 12,
      totalLines: status === "success" ? 0 : 1,
    },
  };
}

function parameterPaths(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || !("paths" in value)) return [];
  const paths = value.paths;
  return Array.isArray(paths) && paths.every((path) => typeof path === "string") ? paths : [];
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(stringValues);
}

function expectNoAnsi(value: unknown): void {
  expect(stringValues(value).some((entry) => entry.includes("\u001b"))).toBe(false);
}

function dependencies(failingScript?: string) {
  const order: string[] = [];
  const resolver: ProjectCommandResolver = async (definition, _projectPath, _signal, params) => {
    const script = definition.fixedScriptKey ?? "unknown";
    const paths = parameterPaths(params);
    return {
      definition,
      executable: "pnpm",
      args: ["run", script, ...(paths.length === 0 ? [] : ["--", ...paths])],
      displayCommand: ["pnpm", "run", script, ...paths].join(" "),
      effectiveParameters: Object.freeze({ paths }),
      scriptHash: `hash-${script}`,
      scriptKey: script,
    };
  };
  const executor = vi.fn(async (resolved) => {
    const script = resolved.scriptKey ?? "unknown";
    order.push(script);
    return outcome(script === failingScript ? "nonzero" : "success");
  });
  const repositoryStateReader: ProjectCommandRepositoryStateReader = async () => ({
    repositoryIdentity: "/repo",
    head: "HEAD",
    dirtyFilesDigest: "clean",
  });
  return { order, resolver, executor, repositoryStateReader };
}

async function projectFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bash-tools-verify-"));
  fixtureDirectories.push(directory);
  await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: {} }));
  return realpath(directory);
}

it("runs fixed phases in order, exposes omissions, and reuses unchanged evidence", async () => {
  const cwd = await projectFixture();
  const deps = dependencies();
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: deps.executor,
    repositoryStateReader: deps.repositoryStateReader,
  });
  const params = {
    omit: ["typecheck"] as const,
    scripts: { format: "format:check" },
    paths: ["src/index.ts"],
    covers: ["AC-VERIFY"],
  };
  const first = await tool.execute("verify-1", params, undefined, undefined, context(cwd));
  expect(deps.order).toEqual(["format:check", "lint", "test"]);
  expect(deps.executor.mock.calls[2]?.[0].args).toEqual(["run", "test", "--", "src/index.ts"]);
  expect(first.details).toMatchObject({
    status: "completed",
    verdict: "incomplete",
    reused: false,
    perStep: [
      { phase: "format", status: "passed", script: "format:check" },
      { phase: "lint", status: "passed" },
      { phase: "typecheck", status: "omitted", verdict: "omitted" },
      { phase: "test", status: "passed" },
    ],
    covers: ["AC-VERIFY"],
  });
  expectNoAnsi(first.details);
  expect(first.details.perStep.every((step) => step.failureTail === undefined)).toBe(true);
  expect(first.details.perStep.every((step) => Number.isInteger(step.durationMs))).toBe(true);
  expect(first.details.perStep[0]).not.toHaveProperty("resolvedCommand");
  expect(first.details.perStep[0]).not.toHaveProperty("executable");
  expect(first.details.perStep[0]).toHaveProperty("command");
  const second = await tool.execute("verify-2", params, undefined, undefined, context(cwd));
  expect(deps.order).toEqual(["format:check", "lint", "test"]);
  expect(second.details.status).toBe("unchanged");
  expect(second.details.reused).toBe(true);
  expect(second.details.perStep.every((step) => !step.executed)).toBe(true);
  const lookup = await tool.execute(
    "verify-ref",
    { ref: first.details.ref },
    undefined,
    undefined,
    context(cwd),
  );
  expect(lookup.details.status).toBe("unchanged");
  expect(lookup.details.reused).toBe(true);
  expect(lookup.details.perStep.every((step) => !step.executed)).toBe(true);
  expect(lookup.details.perStep[0]?.stdout.text).toBe("stdout");
  expectNoAnsi(lookup.details);
  expect(lookup.details.perStep[0]).toHaveProperty("resolvedCommand");
  expect(lookup.details.perStep[0]).toHaveProperty("executable");
  expect(lookup.details.perStep[0]).toHaveProperty("args");
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    tool.execute(
      "verify-aborted-valid-ref",
      { ref: first.details.ref },
      aborted.signal,
      undefined,
      context(cwd),
    ),
  ).rejects.toMatchObject({ code: "cancelled" });
  await expect(
    tool.execute(
      "verify-aborted-missing-ref",
      { ref: "vr_missing" },
      aborted.signal,
      undefined,
      context(cwd),
    ),
  ).rejects.toMatchObject({ code: "cancelled" });
  await expect(
    tool.execute("verify-missing-ref", { ref: "vr_missing" }, undefined, undefined, context(cwd)),
  ).rejects.toMatchObject({
    code: "not-found",
    message: expect.stringContaining("process-local root-session cache"),
  });
});

it("omits authorization-outcome records when session identity is unavailable", async () => {
  const cwd = await projectFixture();
  const deps = dependencies();
  const records: AuthorizationOutcomeRecord[] = [];
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: deps.executor,
    repositoryStateReader: deps.repositoryStateReader,
    authorizationOutcomeRecorder: (record) => {
      records.push(record);
    },
  });

  const observed = await tool.execute(
    "verify-observability-1",
    { omit: ["typecheck"] as const },
    undefined,
    undefined,
    {
      ...context(cwd),
      sessionManager: { getSessionId: () => "verify-observability-session" },
    },
  );
  expect(observed.details.status).toBe("completed");
  expect(records.map((record) => record.sessionId)).toEqual(["verify-observability-session"]);

  const withoutSession = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: deps.executor,
    repositoryStateReader: deps.repositoryStateReader,
    authorizationOutcomeRecorder: (record) => {
      records.push(record);
    },
  });
  const unobserved = await withoutSession.execute(
    "verify-observability-2",
    { omit: ["typecheck"] as const },
    undefined,
    undefined,
    context(cwd),
  );
  expect(unobserved.details.status).toBe("completed");
  expect(records).toHaveLength(1);
  expect(records[0]?.sessionId).toBe("verify-observability-session");
});

it("does not reuse evidence when repository state changes during authorization", async () => {
  const cwd = await projectFixture();
  const deps = dependencies();
  let dirtyFilesDigest = "initial";
  const repositoryStateReader: ProjectCommandRepositoryStateReader = async () => ({
    repositoryIdentity: "/repo",
    head: "HEAD",
    dirtyFilesDigest,
  });
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: deps.executor,
    repositoryStateReader,
  });
  const input = { omit: ["typecheck"] as const };
  await tool.execute("verify-race-1", input, undefined, undefined, context(cwd));
  expect(deps.executor).toHaveBeenCalledTimes(3);

  let releaseAuthorization: () => void = () => undefined;
  const authorizationPaused = new Promise<void>((resolve) => {
    releaseAuthorization = resolve;
  });
  let authorizationStarted: () => void = () => undefined;
  const authorizationStartedPromise = new Promise<void>((resolve) => {
    authorizationStarted = resolve;
  });
  const pending = tool.execute("verify-race-2", input, undefined, undefined, {
    ...context(cwd),
    ui: {
      select: async () => {
        authorizationStarted();
        await authorizationPaused;
        return "Allow once";
      },
    },
  });
  await authorizationStartedPromise;
  dirtyFilesDigest = "changed-during-authorization";
  releaseAuthorization();
  const second = await pending;
  expect(second.details.status).toBe("completed");
  expect(second.details.reused).toBe(false);
  expect(deps.executor).toHaveBeenCalledTimes(6);
});

it("does not persist evidence when configured repository state becomes unavailable", async () => {
  const cwd = await projectFixture();
  const deps = dependencies();
  let reads = 0;
  const cache = {
    get: vi.fn(() => undefined),
    getByRef: vi.fn(() => undefined),
    set: vi.fn(),
  };
  const repositoryStateReader: ProjectCommandRepositoryStateReader = async () => {
    reads += 1;
    return reads === 1
      ? { repositoryIdentity: "/repo", head: "HEAD", dirtyFilesDigest: "initial" }
      : undefined;
  };
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: deps.executor,
    repositoryStateReader,
    cache,
  });
  const result = await tool.execute(
    "verify-state-unavailable",
    { omit: ["typecheck"] },
    undefined,
    undefined,
    context(cwd),
  );
  expect(result.details.status).toBe("completed");
  expect(result.details.reused).toBe(false);
  expect(deps.executor).toHaveBeenCalledTimes(3);
  expect(cache.set).not.toHaveBeenCalled();
});

it("does not persist evidence when final repository-state validation fails", async () => {
  const cwd = await projectFixture();
  const deps = dependencies();
  let reads = 0;
  const cache = {
    get: vi.fn(() => undefined),
    getByRef: vi.fn(() => undefined),
    set: vi.fn(),
  };
  const repositoryStateReader: ProjectCommandRepositoryStateReader = async () => {
    reads += 1;
    if (reads > 2) throw new Error("state unavailable");
    return { repositoryIdentity: "/repo", head: "HEAD", dirtyFilesDigest: "stable" };
  };
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: deps.executor,
    repositoryStateReader,
    cache,
  });
  const result = await tool.execute(
    "verify-final-state-failure",
    { omit: ["typecheck"] },
    undefined,
    undefined,
    context(cwd),
  );
  expect(result.details.status).toBe("completed");
  expect(result.details.ref).toBeUndefined();
  expect(result.details.reused).toBe(false);
  expect(deps.executor).toHaveBeenCalledTimes(3);
  expect(cache.set).not.toHaveBeenCalled();
});

it("keeps every omitted phase visible while running the remaining phase", async () => {
  const cwd = await projectFixture();
  const deps = dependencies();
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: deps.executor,
    repositoryStateReader: deps.repositoryStateReader,
  });
  const result = await tool.execute(
    "verify-omissions",
    { omit: ["format", "lint", "typecheck"] },
    undefined,
    undefined,
    context(cwd),
  );
  expect(deps.order).toEqual(["test"]);
  expect(result.details).toMatchObject({
    verdict: "incomplete",
    perStep: [
      { phase: "format", status: "omitted" },
      { phase: "lint", status: "omitted" },
      { phase: "typecheck", status: "omitted" },
      { phase: "test", status: "passed" },
    ],
  });
});

it("binds authorization prompts to the selected script fingerprint", async () => {
  const cwd = await projectFixture();
  const deps = dependencies();
  let scriptBody = "initial";
  const resolver: ProjectCommandResolver = async (...args) => ({
    ...(await deps.resolver(...args)),
    scriptHash: scriptBody,
  });
  const titles: string[] = [];
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver,
    executor: deps.executor,
    repositoryStateReader: deps.repositoryStateReader,
  });
  const authorizedContext = (projectPath: string): VerifyToolContext => ({
    ...context(projectPath),
    ui: {
      select: async (title) => {
        titles.push(title);
        return "Allow once";
      },
    },
  });
  await tool.execute(
    "verify-auth-1",
    { omit: ["typecheck"] },
    undefined,
    undefined,
    authorizedContext(cwd),
  );
  scriptBody = "changed";
  await tool.execute(
    "verify-auth-2",
    { omit: ["typecheck"] },
    undefined,
    undefined,
    authorizedContext(cwd),
  );
  expect(titles).toHaveLength(2);
  expect(titles[0]).toContain("script-sha256:initial");
  expect(titles[1]).toContain("script-sha256:changed");
});

it("validates exact script names and explicit omissions", () => {
  expect(
    validateVerifyInput({ scripts: { typecheck: "type-check", lint: "lint-fix" } }),
  ).toMatchObject({
    scripts: { typecheck: "type-check", lint: "lint-fix" },
  });
  expect(() => validateVerifyInput({ omit: ["format", "lint", "typecheck", "test"] })).toThrow(
    "at least one phase",
  );
  expect(() =>
    validateVerifyInput({ omit: ["typecheck"], scripts: { typecheck: "types" } }),
  ).toThrow("omitted verify phases");
  expect(() => validateVerifyInput({ scripts: { lint: "lint;rm -rf /" } })).toThrow(
    "exact package scripts",
  );
});

it("reports a missing typecheck script as a resolution failure unless omitted", async () => {
  const cwd = await projectFixture();
  const deps = dependencies();
  const resolver: ProjectCommandResolver = async (definition, ...args) => {
    if (definition.fixedScriptKey === "typecheck") throw new Error("missing script");
    return deps.resolver(definition, ...args);
  };
  const executor = vi.fn(deps.executor);
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver,
    executor,
    repositoryStateReader: deps.repositoryStateReader,
  });
  await expect(
    tool.execute("verify-missing-typecheck", {}, undefined, undefined, context(cwd)),
  ).rejects.toMatchObject({ code: "resolution-failure" });
  expect(executor).not.toHaveBeenCalled();
});

it("preserves cancellation during command resolution", async () => {
  const cwd = await projectFixture();
  const controller = new AbortController();
  const deps = dependencies();
  const resolver: ProjectCommandResolver = async (definition, projectPath, signal, params) => {
    await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    return deps.resolver(definition, projectPath, signal, params);
  };
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver,
    executor: deps.executor,
    repositoryStateReader: deps.repositoryStateReader,
  });
  const pending = tool.execute(
    "verify-cancel",
    { omit: ["typecheck"] },
    controller.signal,
    undefined,
    context(cwd),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  expect(deps.executor).not.toHaveBeenCalled();
});

it("detaches a cancelled shared consumer without aborting the producer", async () => {
  const cwd = await projectFixture();
  const deps = dependencies();
  let signalAborted = false;
  let release: (value: ProjectCommandExecutionOutcome) => void = () => undefined;
  const execution = new Promise<ProjectCommandExecutionOutcome>((resolve) => {
    release = resolve;
  });
  let executorStarted: () => void = () => undefined;
  const executorStartedPromise = new Promise<void>((resolve) => {
    executorStarted = resolve;
  });
  const executor = vi.fn(async (_resolved, _projectPath, signal) => {
    signal?.addEventListener("abort", () => {
      signalAborted = true;
    });
    executorStarted();
    return execution;
  });
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor,
    repositoryStateReader: deps.repositoryStateReader,
  });
  const controller = new AbortController();
  const input = { omit: ["format", "lint", "typecheck"] as const };
  const producer = tool.execute(
    "verify-shared-producer",
    input,
    undefined,
    undefined,
    context(cwd),
  );
  await executorStartedPromise;
  const consumer = tool.execute(
    "verify-shared-consumer",
    input,
    controller.signal,
    undefined,
    context(cwd),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(executor).toHaveBeenCalledTimes(1);

  controller.abort();
  await expect(consumer).rejects.toMatchObject({ code: "cancelled" });
  expect(signalAborted).toBe(false);

  release(outcome("success"));
  const result = await producer;
  expect(result.details.verdict).toBe("incomplete");
  expect(result.details.perStep[3]).toMatchObject({ phase: "test", status: "passed" });
  expect(executor).toHaveBeenCalledTimes(1);
});

it("rejects contradictory persisted evidence", () => {
  const chunk = { text: "", truncated: false, totalBytes: 0, totalLines: 0 };
  const step = (phase: "format" | "lint" | "typecheck" | "test") => ({
    phase,
    status: "passed" as const,
    verdict: "passed" as const,
    command: `pnpm run ${phase}`,
    resolvedCommand: `pnpm run ${phase}`,
    executable: "pnpm",
    args: ["run", phase],
    script: phase,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    executed: true,
    stdout: chunk,
    stderr: chunk,
  });
  const record = {
    cacheFormatVersion: 3 as const,
    key: "request-key",
    ref: "vr_request-key",
    projectPath: "/tmp/verify-project",
    repositoryState: {
      repositoryIdentity: "/repo",
      workingDirectory: "/tmp/verify-project",
      head: "HEAD",
      dirtyFilesDigest: "clean",
    },
    resolvedCommands: ["pnpm run format"],
    perStep: [step("format"), step("lint"), step("typecheck"), step("test")],
    verdict: "passed" as const,
    covers: [],
    createdAt: 0,
  };
  expect(isVerifyEvidenceRecord(record, record.key)).toBe(true);
  expect(isVerifyEvidenceRecord({ ...record, cacheFormatVersion: 1 }, record.key)).toBe(false);
  const alias = { key: `ref:${record.ref}`, record };
  expect(isVerifyEvidenceCacheRecord(alias, `ref:${record.ref}`)).toBe(true);
  expect(isVerifyEvidenceCacheRecord(record, `ref:${record.ref}`)).toBe(true);
  expect(
    isVerifyEvidenceCacheRecord(
      { key: `ref:${record.ref}`, record: { ...record, cacheFormatVersion: 2 } },
      `ref:${record.ref}`,
    ),
  ).toBe(true);
  expect(
    isVerifyEvidenceCacheRecord({ ...record, cacheFormatVersion: 2 }, `ref:${record.ref}`),
  ).toBe(false);
  expect(isVerifyEvidenceCacheRecord({ ...alias, key: "ref:other-ref" }, "ref:other-ref")).toBe(
    false,
  );
  expect(
    isVerifyEvidenceCacheRecord(
      { ...alias, record: { ...record, ref: "vr_other-ref" } },
      `ref:${record.ref}`,
    ),
  ).toBe(false);
  expect(
    isVerifyEvidenceRecord(
      {
        ...record,
        verdict: "passed",
        perStep: [
          step("format"),
          { ...step("lint"), status: "failed", verdict: "failed" },
          step("typecheck"),
          step("test"),
        ],
      },
      record.key,
    ),
  ).toBe(false);
  expect(isVerifyEvidenceRecord({ ...record, resolvedCommands: [] }, record.key)).toBe(false);
  expect(
    isVerifyEvidenceRecord(
      {
        ...record,
        perStep: [
          { ...step("format"), command: "", resolvedCommand: "" },
          step("lint"),
          step("typecheck"),
          step("test"),
        ],
      },
      record.key,
    ),
  ).toBe(false);
  expect(
    isVerifyEvidenceRecord(
      {
        ...record,
        verdict: "failed",
        perStep: [
          { ...step("format"), status: "failed", verdict: "failed" },
          step("lint"),
          step("typecheck"),
          step("test"),
        ],
      },
      record.key,
    ),
  ).toBe(false);
  expect(
    isVerifyEvidenceRecord(
      {
        ...record,
        perStep: [
          { ...step("format"), executed: false },
          step("lint"),
          step("typecheck"),
          step("test"),
        ],
      },
      record.key,
    ),
  ).toBe(false);
  expect(
    isVerifyEvidenceRecord(
      {
        ...record,
        repositoryState: {
          ...record.repositoryState,
          workingDirectory: "/tmp/other-project",
        },
      },
      record.key,
    ),
  ).toBe(false);
  expect(
    isVerifyEvidenceRecord(
      {
        ...record,
        perStep: [
          {
            ...step("format"),
            stdout: { ...chunk, totalBytes: 0.5 },
          },
          step("lint"),
          step("typecheck"),
          step("test"),
        ],
      },
      record.key,
    ),
  ).toBe(false);
  expect(
    isVerifyEvidenceRecord(
      {
        ...record,
        verdict: "failed",
        failureTail: `${String.fromCodePoint(0x1b)}[31munsafe`,
        perStep: [
          { ...step("format"), status: "failed", verdict: "failed" },
          step("lint"),
          step("typecheck"),
          step("test"),
        ],
      },
      record.key,
    ),
  ).toBe(false);
});

it("rejects durable records with unsafe tails or fractional durations", async () => {
  const cwd = await projectFixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "bash-tools-verify-compat-"));
  fixtureDirectories.push(cacheRoot);
  const previousFlow = process.env.PI_ORCHESTRATION_FLOW;
  const previousScope = process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
  process.env.PI_ORCHESTRATION_FLOW = "verify-compat-flow";
  process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE = "flow";
  try {
    const chunk = { text: "", truncated: false, totalBytes: 0, totalLines: 0 };
    const phases: readonly VerifyPhase[] = ["format", "lint", "typecheck", "test"];
    const steps = phases.map((phase) => ({
      phase,
      status: "passed" as const,
      verdict: "passed" as const,
      command: `pnpm run ${phase}`,
      resolvedCommand: `pnpm run ${phase}`,
      executable: "pnpm",
      args: ["run", phase],
      script: phase,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      executed: true,
      stdout: chunk,
      stderr: chunk,
    }));
    const record: VerifyEvidenceRecord = {
      cacheFormatVersion: 3,
      key: "compatibility-key",
      ref: "vr_compatibility-key",
      projectPath: cwd,
      resolvedCommands: steps.map((step) => step.command),
      perStep: steps,
      verdict: "passed",
      covers: ["compatibility"],
      createdAt: 0,
    };
    const writer = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
    writer.set(record);
    expect(createVerifyEvidenceCache({ rootDirectory: cacheRoot }).get(record.key)).toEqual(record);
    const ansi = `${String.fromCodePoint(0x1b)}[31m${"failure ".repeat(2_000)}${String.fromCodePoint(0x1b)}[0m`;
    const invalidRecord: VerifyEvidenceRecord = {
      ...record,
      perStep: record.perStep.map((step, index) =>
        index === 0 ? { ...step, durationMs: 1.5, failureTail: ansi } : step,
      ),
    };
    const cacheDirectory = join(cacheRoot, "flows", "verify-compat-flow", "project-command");
    const files = (await readdir(cacheDirectory)).filter((file) => file.endsWith(".json"));
    expect(files.length).toBe(1);
    await Promise.all(
      files.map((file) => writeFile(join(cacheDirectory, file), JSON.stringify(invalidRecord))),
    );
    const reloaded = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
    expect(reloaded.get(record.key)).toBeUndefined();
    expect(reloaded.getByRef(record.ref)).toBeUndefined();
  } finally {
    if (previousFlow === undefined) delete process.env.PI_ORCHESTRATION_FLOW;
    else process.env.PI_ORCHESTRATION_FLOW = previousFlow;
    if (previousScope === undefined) delete process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
    else process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE = previousScope;
  }
});

it("persists flow evidence, resolves refs, and invalidates changed repository state", async () => {
  const cwd = await projectFixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "bash-tools-verify-cache-"));
  fixtureDirectories.push(cacheRoot);
  const previousFlow = process.env.PI_ORCHESTRATION_FLOW;
  const previousScope = process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
  process.env.PI_ORCHESTRATION_FLOW = "verify-flow-test";
  process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE = "flow";
  try {
    const firstDeps = dependencies();
    const firstTool = createVerifyToolForTesting({
      policy: policy(),
      resolver: firstDeps.resolver,
      executor: firstDeps.executor,
      repositoryStateReader: firstDeps.repositoryStateReader,
      cache: createVerifyEvidenceCache({ rootDirectory: cacheRoot }),
    });
    const input = { omit: ["typecheck"] as const };
    const first = await firstTool.execute(
      "verify-flow-1",
      input,
      undefined,
      undefined,
      context(cwd),
    );

    const secondDeps = dependencies();
    const secondTool = createVerifyToolForTesting({
      policy: policy(),
      resolver: secondDeps.resolver,
      executor: secondDeps.executor,
      repositoryStateReader: secondDeps.repositoryStateReader,
      cache: createVerifyEvidenceCache({ rootDirectory: cacheRoot }),
    });
    const second = await secondTool.execute(
      "verify-flow-2",
      input,
      undefined,
      undefined,
      context(cwd),
    );
    expect(second.details.status).toBe("unchanged");
    expect(secondDeps.order).toEqual([]);
    const lookup = await secondTool.execute(
      "verify-flow-ref",
      { ref: first.details.ref },
      undefined,
      undefined,
      context(cwd),
    );
    expect(lookup.details.perStep[0]?.stdout.text).toBe("stdout");
    const flowDirectory = join(cacheRoot, "flows", "verify-flow-test", "project-command");
    const files = (await readdir(flowDirectory)).filter((file) => file.endsWith(".json"));
    expect(files.length).toBe(1);
    await Promise.all(files.map((file) => writeFile(join(flowDirectory, file), "{}")));
    await expect(
      secondTool.execute(
        "verify-corrupt-ref",
        { ref: first.details.ref },
        undefined,
        undefined,
        context(cwd),
      ),
    ).rejects.toMatchObject({ code: "not-found" });

    const changedDeps = dependencies();
    const changedTool = createVerifyToolForTesting({
      policy: policy(),
      resolver: changedDeps.resolver,
      executor: changedDeps.executor,
      repositoryStateReader: async () => ({
        repositoryIdentity: "/repo",
        head: "changed",
        dirtyFilesDigest: "clean",
      }),
      cache: createVerifyEvidenceCache({ rootDirectory: cacheRoot }),
    });
    const changed = await changedTool.execute(
      "verify-flow-3",
      input,
      undefined,
      undefined,
      context(cwd),
    );
    expect(changed.details.status).toBe("completed");
    expect(changedDeps.order).toEqual(["format:check", "lint", "test"]);
  } finally {
    if (previousFlow === undefined) delete process.env.PI_ORCHESTRATION_FLOW;
    else process.env.PI_ORCHESTRATION_FLOW = previousFlow;
    if (previousScope === undefined) delete process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
    else process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE = previousScope;
  }
});

function oversizedTotalsRecord(key: string, projectPath: string): VerifyEvidenceRecord {
  const chunk = {
    text: "x".repeat(50 * 1024),
    truncated: true,
    totalBytes: 136_119,
    totalLines: 1_768,
  };
  const phases: readonly VerifyPhase[] = ["format", "lint", "typecheck", "test"];
  const steps = phases.map((phase) => ({
    phase,
    status: "passed" as const,
    verdict: "passed" as const,
    command: `pnpm run ${phase}`,
    resolvedCommand: `pnpm run ${phase}`,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    executed: true,
    stdout: chunk,
    stderr: chunk,
  }));
  return {
    cacheFormatVersion: 3,
    key,
    ref: `vr_${key.slice(0, 24)}`,
    projectPath,
    resolvedCommands: steps.map((step) => step.command),
    perStep: steps,
    verdict: "passed",
    covers: ["AC-001"],
    createdAt: 0,
  };
}

function withFlowScope(flowId: string | undefined, run: () => Promise<void>): Promise<void> {
  const previousFlow = process.env.PI_ORCHESTRATION_FLOW;
  const previousScope = process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
  if (flowId === undefined) {
    delete process.env.PI_ORCHESTRATION_FLOW;
    delete process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
  } else {
    process.env.PI_ORCHESTRATION_FLOW = flowId;
    process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE = "flow";
  }
  return run().finally(() => {
    if (previousFlow === undefined) delete process.env.PI_ORCHESTRATION_FLOW;
    else process.env.PI_ORCHESTRATION_FLOW = previousFlow;
    if (previousScope === undefined) delete process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
    else process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE = previousScope;
  });
}

it("round-trips flow evidence with oversized step output totals on the same instance", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "bash-tools-verify-oversized-"));
  fixtureDirectories.push(cacheRoot);
  await withFlowScope("verify-oversized-flow", async () => {
    const record = oversizedTotalsRecord("oversized-totals-key", "/tmp/verify-project");
    const cache = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
    cache.set(record);
    expect(cache.get(record.key)).toEqual(record);
    expect(cache.getByRef(record.ref)).toEqual(record);
  });
});

it("shares flow evidence with oversized totals across cache instances", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "bash-tools-verify-oversized-shared-"));
  fixtureDirectories.push(cacheRoot);
  await withFlowScope("verify-oversized-shared-flow", async () => {
    const record = oversizedTotalsRecord("shared-oversized-key", "/tmp/verify-project");
    createVerifyEvidenceCache({ rootDirectory: cacheRoot }).set(record);
    const consumer = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
    expect(consumer.get(record.key)).toEqual(record);
    expect(consumer.getByRef(record.ref)).toEqual(record);
  });
});

it("resolves a root-published oversized-totals ref from a flow seat and refuses another flow", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "bash-tools-verify-root-publish-"));
  fixtureDirectories.push(cacheRoot);
  await withFlowScope(undefined, async () => {
    const record = {
      ...oversizedTotalsRecord("root-published-key", "/tmp/verify-project"),
      repositoryState: {
        repositoryIdentity: "/repo",
        workingDirectory: "/tmp/verify-project",
        head: "HEAD",
        dirtyFilesDigest: "clean",
      },
    };
    const producer = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
    producer.set(record);
    const published = producer.publish?.(record.ref, "publish-flow", "/repo");
    expect(published?.publication).toMatchObject({
      flowId: "publish-flow",
      producerScope: "root",
      published: true,
    });
    await withFlowScope("publish-flow", async () => {
      const seat = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
      expect(seat.getByRef(record.ref)).toEqual(published);
      expect(seat.getByRef(record.ref, "publish-flow")).toEqual(published);
    });
    await withFlowScope("other-flow", async () => {
      const otherSeat = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
      expect(otherSeat.getByRef(record.ref)).toBeUndefined();
      expect(otherSeat.getByRef(record.ref, "publish-flow")).toBeUndefined();
      expect((await readdir(join(cacheRoot, "flows"))).sort()).toEqual(["publish-flow"]);
    });
  });
});

it("publishes flow evidence with oversized totals and keeps distinct publication failures", async () => {
  const cwd = await projectFixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "bash-tools-verify-publish-seat-"));
  fixtureDirectories.push(cacheRoot);
  await withFlowScope("publish-seat-flow", async () => {
    const deps = dependencies();
    const executor = vi.fn(async (resolved: Parameters<ProjectCommandExecutor>[0]) => {
      const executed = await deps.executor(resolved);
      return {
        ...executed,
        stdout: { ...executed.stdout, truncated: true, totalBytes: 136_119, totalLines: 1_768 },
      };
    });
    const cache = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
    const tool = createVerifyToolForTesting({
      policy: policy(),
      resolver: deps.resolver,
      executor,
      repositoryStateReader: deps.repositoryStateReader,
      cache,
    });
    const published = await tool.execute(
      "verify-publish-seat",
      { omit: ["typecheck"] as const, publish: { flowId: "publish-seat-flow" } },
      undefined,
      undefined,
      context(cwd),
    );
    expect(published.details.publication).toMatchObject({
      flowId: "publish-seat-flow",
      published: true,
    });
    expect(published.details.perStep[0]?.stdout.totalBytes).toBe(136_119);
    expect(published.details.perStep[0]?.stdout.totalLines).toBe(1_768);

    await expect(
      tool.execute(
        "verify-publish-seat-wrong-flow",
        {
          omit: ["typecheck"] as const,
          covers: ["MISMATCH"],
          publish: { flowId: "other-flow" },
        },
        undefined,
        undefined,
        context(cwd),
      ),
    ).rejects.toThrow("no compatible stable evidence was stored");

    const unreadableTool = createVerifyToolForTesting({
      policy: policy(),
      resolver: deps.resolver,
      executor,
      repositoryStateReader: async () => undefined,
      cache,
    });
    await expect(
      unreadableTool.execute(
        "verify-publish-seat-unreadable",
        {
          omit: ["typecheck"] as const,
          covers: ["UNREADABLE"],
          publish: { flowId: "publish-seat-flow" },
        },
        undefined,
        undefined,
        context(cwd),
      ),
    ).rejects.toThrow("repository state is unreadable or changed during execution");
  });
});

it("runs actual package-manager scripts with configured names", async () => {
  const cwd = await projectFixture();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      packageManager: "npm@10.0.0",
      scripts: {
        "fmt-check": 'node -e "process.exit(0)"',
        "lint-fix": 'node -e "process.exit(0)"',
        "test-run": 'node -e "process.exit(0)"',
      },
    }),
  );
  await expect(
    readNodeProjectInfo(cwd, { approvedPackageManagerDirectories: [dirname(process.execPath)] }),
  ).resolves.toMatchObject({
    scripts: ["fmt-check", "lint-fix", "test-run"],
    packageManager: { executableAvailable: true },
  });
  const resolver: ProjectCommandResolver = (definition, projectPath, _signal, parameters) =>
    resolveNodeProjectCommand(definition, projectPath, parameters, {
      approvedPackageManagerDirectories: [dirname(process.execPath)],
    });
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver,
    executor: createProjectCommandExecutor(),
    repositoryStateReader: undefined,
  });
  const result = await tool.execute(
    "verify-real-scripts",
    {
      omit: ["typecheck"],
      scripts: { format: "fmt-check", lint: "lint-fix", test: "test-run" },
    },
    undefined,
    undefined,
    context(cwd),
  );
  expect(result.details.verdict).toBe("incomplete");
  expect(
    result.details.perStep.every((step) => step.status === "passed" || step.status === "omitted"),
  ).toBe(true);
});

it("records per-step and aggregate timeout failures", async () => {
  const cwd = await projectFixture();
  const deps = dependencies();
  const delayedExecutor: ProjectCommandExecutor = async (_resolved, _projectPath, signal) => {
    if (signal === undefined) throw new Error("missing step signal");
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return outcome("nonzero");
  };
  const stepTimedOutTool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: delayedExecutor,
    repositoryStateReader: deps.repositoryStateReader,
    aggregateTimeoutMs: 1000,
    stepTimeoutMs: 5,
  });
  const stepTimedOut = await stepTimedOutTool.execute(
    "verify-step-timeout",
    { omit: ["typecheck"] },
    undefined,
    undefined,
    context(cwd),
  );
  expect(stepTimedOut.details.perStep[0]).toMatchObject({
    status: "failed",
    reason: "step timeout",
  });
  const rejectingExecutor: ProjectCommandExecutor = async (_resolved, _projectPath, signal) => {
    if (signal === undefined) throw new Error("missing step signal");
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("terminated executor");
  };
  const rejectionTool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: rejectingExecutor,
    repositoryStateReader: deps.repositoryStateReader,
    aggregateTimeoutMs: 1000,
    stepTimeoutMs: 5,
  });
  const rejected = await rejectionTool.execute(
    "verify-timeout-rejection",
    { omit: ["typecheck"] },
    undefined,
    undefined,
    context(cwd),
  );
  expect(rejected.details.perStep[0]).toMatchObject({
    status: "failed",
    reason: "step timeout",
  });

  const aggregateTimedOutTool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: delayedExecutor,
    repositoryStateReader: deps.repositoryStateReader,
    aggregateTimeoutMs: 10,
    stepTimeoutMs: 1000,
  });
  const aggregateTimedOut = await aggregateTimedOutTool.execute(
    "verify-aggregate-timeout",
    { omit: ["typecheck"] },
    undefined,
    undefined,
    context(cwd),
  );
  expect(aggregateTimedOut.details.perStep[0]).toMatchObject({
    status: "failed",
    reason: "aggregate timeout",
  });
});

it("stops after failure by default and continues when requested", async () => {
  const cwd = await projectFixture();
  const deps = dependencies("lint");
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: deps.executor,
    repositoryStateReader: deps.repositoryStateReader,
  });
  const first = await tool.execute(
    "verify-1",
    { omit: ["typecheck"] },
    undefined,
    undefined,
    context(cwd),
  );
  expect(deps.order).toEqual(["format:check", "lint"]);
  expect(first.details).toMatchObject({
    verdict: "failed",
    perStep: [
      { phase: "format", status: "passed" },
      { phase: "lint", status: "failed", failureTail: "failure tail" },
      { phase: "typecheck", status: "omitted" },
      { phase: "test", status: "not-run" },
    ],
  });
  expect(first.details.failureTail).toBeUndefined();

  const continued = dependencies("lint");
  const continuedTool = createVerifyToolForTesting({
    policy: policy(),
    resolver: continued.resolver,
    executor: continued.executor,
    repositoryStateReader: continued.repositoryStateReader,
  });
  const continuedResult = await continuedTool.execute(
    "verify-2",
    { omit: ["typecheck"], continueOnFailure: true },
    undefined,
    undefined,
    context(cwd),
  );
  expect(continued.order).toEqual(["format:check", "lint", "test"]);
  expect(continuedResult.details.failureTail).toBeUndefined();
  expect(
    continuedResult.details.perStep.filter((step) => step.failureTail !== undefined),
  ).toHaveLength(1);
});

it("limits failure tails to failed steps and strips ANSI escapes", async () => {
  const cwd = await projectFixture();
  const deps = dependencies("lint");
  const ansiOutput = `\u001b[31m${"failure ".repeat(2_000)}\u001b[0m`;
  const executor: ProjectCommandExecutor = vi.fn(async (resolved) => {
    const script = resolved.scriptKey ?? "unknown";
    const current = outcome(script === "lint" ? "nonzero" : "success");
    return script === "lint"
      ? {
          ...current,
          stderr: {
            text: ansiOutput,
            truncated: false,
            totalBytes: ansiOutput.length,
            totalLines: 1,
          },
        }
      : current;
  });
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor,
    repositoryStateReader: deps.repositoryStateReader,
  });
  const result = await tool.execute(
    "verify-ansi-failure",
    { omit: ["typecheck"] },
    undefined,
    undefined,
    context(cwd),
  );
  expect(result.details.perStep[0]?.failureTail).toBeUndefined();
  expectNoAnsi(result.details);
  const lintStep = result.details.perStep[1];
  expect(lintStep?.failureTail).toBeDefined();
  expect(lintStep?.failureTail).not.toContain("\u001b");
  expect(lintStep?.failureTail?.length).toBeLessThanOrEqual(8 * 1024);
  const lookup = await tool.execute(
    "verify-ansi-failure-ref",
    { ref: result.details.ref },
    undefined,
    undefined,
    context(cwd),
  );
  expectNoAnsi(lookup.details);
  expect(lookup.details.perStep[1]?.stderr.text).not.toContain("\u001b");
  expect(lookup.details.perStep[1]?.stderr.totalBytes).toBe(ansiOutput.length);
});

it("sanitizes every escape class from failure tails so records stay readable on the flow disk path", async () => {
  const cwd = await projectFixture();
  const deps = dependencies("lint");
  const escapeClasses = [
    `\u001b[38:2:0:0:0mcolon-sgr\u001b[39:2:0:0:0m`,
    `\u001b[2Knon-sgr-csi\u001b[H`,
    `\u001b]0;window title\u0007osc-bel\u001b]8;;http://x\u001b\\osc-st`,
    `lone\u001bescape`,
    `\u001b]unterminated-osc`,
  ];
  const rawStderr = escapeClasses.join("|");
  const executor: ProjectCommandExecutor = vi.fn(async (resolved) => {
    const script = resolved.scriptKey ?? "unknown";
    const current = outcome(script === "lint" ? "nonzero" : "success");
    return script === "lint"
      ? {
          ...current,
          stderr: {
            text: rawStderr,
            truncated: false,
            totalBytes: rawStderr.length,
            totalLines: 1,
          },
        }
      : current;
  });
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor,
    repositoryStateReader: deps.repositoryStateReader,
  });
  const result = await tool.execute(
    "verify-escape-classes",
    { omit: ["typecheck"] },
    undefined,
    undefined,
    context(cwd),
  );
  const lintStep = result.details.perStep[1];
  expect(lintStep?.status).toBe("failed");
  expect(lintStep?.failureTail).toBeDefined();
  expect(lintStep?.failureTail).not.toContain("\u001b");
  expect(lintStep?.failureTail).toContain("colon-sgr");
  expect(lintStep?.failureTail).toContain("non-sgr-csi");
  expect(lintStep?.failureTail).toContain("osc-bel");
  expect(lintStep?.failureTail).toContain("osc-st");
  expect(lintStep?.failureTail).toContain("lone");
  expect(lintStep?.failureTail).toContain("escape");
  expect(lintStep?.failureTail).not.toContain("unterminated-osc");
  expect(lintStep?.failureTail).not.toContain("]");
  expectNoAnsi(result.details);

  const lookup = await tool.execute(
    "verify-escape-classes-ref",
    { ref: result.details.ref },
    undefined,
    undefined,
    context(cwd),
  );
  expectNoAnsi(lookup.details);
  expect(lookup.details.ref).toBe(result.details.ref);
  expect(lookup.details.failureTail).toBe(lintStep?.failureTail);
});

it("reruns fresh evidence without changing its stable reference", async () => {
  const cwd = await projectFixture();
  const deps = dependencies();
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: deps.executor,
    repositoryStateReader: deps.repositoryStateReader,
  });
  const input = { omit: ["typecheck"] as const };
  const first = await tool.execute("verify-fresh-1", input, undefined, undefined, context(cwd));
  const fresh = await tool.execute(
    "verify-fresh-2",
    { ...input, fresh: true },
    undefined,
    undefined,
    context(cwd),
  );
  expect(deps.executor).toHaveBeenCalledTimes(6);
  expect(fresh.details).toMatchObject({
    status: "completed",
    reused: false,
    ref: first.details.ref,
  });
});

it("reports recorded, matching, changed, and unreadable repository state on lookup", async () => {
  const cwd = await projectFixture();
  const deps = dependencies();
  let state: { repositoryIdentity: string; head: string; dirtyFilesDigest: string } | undefined = {
    repositoryIdentity: "/repo",
    head: "HEAD",
    dirtyFilesDigest: "clean",
  };
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: deps.executor,
    repositoryStateReader: async () => state,
  });
  const completed = await tool.execute(
    "verify-state-lookup",
    { omit: ["typecheck"] },
    undefined,
    undefined,
    context(cwd),
  );
  const matching = await tool.execute(
    "verify-state-matching",
    { ref: completed.details.ref },
    undefined,
    undefined,
    context(cwd),
  );
  expect(matching.details).toMatchObject({
    repositoryStateStatus: "matches",
    recordedRepositoryState: { head: "HEAD" },
    currentRepositoryState: { head: "HEAD" },
  });

  state = { ...state, head: "changed" };
  const mismatch = await tool.execute(
    "verify-state-mismatch",
    { ref: completed.details.ref },
    undefined,
    undefined,
    context(cwd),
  );
  expect(mismatch.details).toMatchObject({
    repositoryStateStatus: "mismatch",
    recordedRepositoryState: { head: "HEAD" },
    currentRepositoryState: { head: "changed" },
  });

  state = undefined;
  const unreadable = await tool.execute(
    "verify-state-unreadable",
    { ref: completed.details.ref },
    undefined,
    undefined,
    context(cwd),
  );
  expect(unreadable.details).toMatchObject({
    repositoryStateStatus: "unreadable",
    recordedRepositoryState: { head: "HEAD" },
  });
  expect(unreadable.details).not.toHaveProperty("currentRepositoryState");
});

it("publishes only stable root evidence to an explicitly requested flow", async () => {
  const cwd = await projectFixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "bash-tools-verify-publish-"));
  fixtureDirectories.push(cacheRoot);
  const previousFlow = process.env.PI_ORCHESTRATION_FLOW;
  const previousScope = process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
  vi.stubEnv("PI_ORCHESTRATION_FLOW", undefined);
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", undefined);
  try {
    const deps = dependencies();
    const cache = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
    const tool = createVerifyToolForTesting({
      policy: policy(),
      resolver: deps.resolver,
      executor: deps.executor,
      repositoryStateReader: deps.repositoryStateReader,
      cache,
    });
    const published = await tool.execute(
      "verify-publish",
      { omit: ["typecheck"], publish: { flowId: "publish-flow" } },
      undefined,
      undefined,
      context(cwd),
    );
    expect(published.details).toMatchObject({
      ref: expect.stringMatching(/^vr_/u),
      publication: { flowId: "publish-flow", published: true },
      provenance: { scope: "flow", flowId: "publish-flow" },
    });

    vi.stubEnv("PI_ORCHESTRATION_FLOW", "publish-flow");
    vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
    const lookup = await tool.execute(
      "verify-publish-lookup",
      { ref: published.details.ref, flowId: "publish-flow" },
      undefined,
      undefined,
      context(cwd),
    );
    expect(lookup.details).toMatchObject({
      ref: published.details.ref,
      publication: { flowId: "publish-flow", published: true },
      provenance: { scope: "flow", flowId: "publish-flow" },
    });
  } finally {
    if (previousFlow === undefined) delete process.env.PI_ORCHESTRATION_FLOW;
    else process.env.PI_ORCHESTRATION_FLOW = previousFlow;
    if (previousScope === undefined) delete process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
    else process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE = previousScope;
  }
});

gitIntegration("verify publication with a tracked deletion", () => {
  it("publishes flow evidence for a recorded repository state with a tracked deletion", async () => {
    const repository = await gitFixtures.createRepository();
    await rm(join(repository.directory, "README.md"));
    const observedState = await createProjectCommandRepositoryStateReader(makeRealGitExec())(
      repository.directory,
      undefined,
    );
    expect(observedState).toBeDefined();
    const cacheRoot = await mkdtemp(join(tmpdir(), "bash-tools-verify-publish-deletion-"));
    fixtureDirectories.push(cacheRoot);
    const previousFlow = process.env.PI_ORCHESTRATION_FLOW;
    const previousScope = process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
    vi.stubEnv("PI_ORCHESTRATION_FLOW", undefined);
    vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", undefined);
    try {
      const deps = dependencies();
      const cache = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
      const tool = createVerifyToolForTesting({
        policy: policy(),
        resolver: deps.resolver,
        executor: deps.executor,
        repositoryStateReader: async () => observedState,
        cache,
      });
      const published = await tool.execute(
        "verify-publish-deletion",
        { omit: ["typecheck"], publish: { flowId: "publish-deletion-flow" } },
        undefined,
        undefined,
        context(repository.directory),
      );
      expect(published.details).toMatchObject({
        ref: expect.stringMatching(/^vr_/u),
        publication: { flowId: "publish-deletion-flow", published: true },
        provenance: { scope: "flow", flowId: "publish-deletion-flow" },
      });
      expect(published.details.repositoryState?.dirtyFilesDigest).toBe(
        observedState?.dirtyFilesDigest,
      );
    } finally {
      if (previousFlow === undefined) delete process.env.PI_ORCHESTRATION_FLOW;
      else process.env.PI_ORCHESTRATION_FLOW = previousFlow;
      if (previousScope === undefined) delete process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
      else process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE = previousScope;
    }
  });
});

it("binds verify authorization to scripts, excludes paths, and persists project allows across scopes", async () => {
  const cwd = await projectFixture();
  let storedIdentity: { commandId: string; fingerprint: string } | undefined;
  const selections = vi.fn(async () => "Allow for this project");
  const flowPolicy: PolicyStore = {
    configPath: "flow-policy",
    load: async (projectPath) => ({
      projectPath: await realpath(projectPath),
      confirmationTimeoutMs: 1000,
      document: {
        version: 2,
        environment: {
          version: 1,
          confirmationTimeoutMs: 1000,
          global: { allow: [], deny: [] },
          projects: {},
        },
        projectCommands: {
          version: 1,
          global: { allow: [], deny: [] },
          projects:
            storedIdentity === undefined
              ? {}
              : {
                  [await realpath(projectPath)]: {
                    allow: [storedIdentity],
                    deny: [],
                  },
                },
        },
      },
    }),
    recordDecisions: async (_projectPath, requests: readonly PolicyDecisionRequest[]) => {
      const request = requests[0];
      if (request?.kind === "project-command" && request.decision === "allow-project") {
        storedIdentity = request.identity;
      }
    },
  };
  const previousFlow = process.env.PI_ORCHESTRATION_FLOW;
  const previousScope = process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "verify-auth-flow");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  try {
    const deps = dependencies();
    const tool = createVerifyToolForTesting({
      policy: flowPolicy,
      resolver: deps.resolver,
      executor: deps.executor,
      repositoryStateReader: deps.repositoryStateReader,
    });
    await tool.execute(
      "verify-auth-paths-1",
      { omit: ["typecheck"], paths: ["src/one.ts"] },
      undefined,
      undefined,
      { ...context(cwd), ui: { select: selections } },
    );
    await tool.execute(
      "verify-auth-paths-2",
      { omit: ["typecheck"], paths: ["src/two.ts"] },
      undefined,
      undefined,
      { ...context(cwd), ui: { select: selections } },
    );
    expect(selections).toHaveBeenCalledTimes(1);

    vi.stubEnv("PI_ORCHESTRATION_FLOW", undefined);
    vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", undefined);
    await tool.execute(
      "verify-auth-session",
      { omit: ["typecheck"], paths: ["src/two.ts"] },
      undefined,
      undefined,
      { ...context(cwd), ui: { select: selections } },
    );
    expect(selections).toHaveBeenCalledTimes(1);

    await tool.execute(
      "verify-auth-changed-scripts",
      { omit: ["typecheck", "format"], paths: ["src/two.ts"] },
      undefined,
      undefined,
      { ...context(cwd), ui: { select: selections } },
    );
    expect(selections).toHaveBeenCalledTimes(2);
  } finally {
    if (previousFlow === undefined) delete process.env.PI_ORCHESTRATION_FLOW;
    else process.env.PI_ORCHESTRATION_FLOW = previousFlow;
    if (previousScope === undefined) delete process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
    else process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE = previousScope;
  }
});

it("records one aggregate invocation for execution, reuse, and lookup", async () => {
  const cwd = await projectFixture();
  const deps = dependencies();
  const records: unknown[] = [];
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: deps.executor,
    repositoryStateReader: deps.repositoryStateReader,
    invocationRecorder: (record) => records.push(record),
  });
  const first = await tool.execute(
    "verify-record-1",
    { omit: ["typecheck"] },
    undefined,
    undefined,
    context(cwd),
  );
  await tool.execute(
    "verify-record-2",
    { omit: ["typecheck"] },
    undefined,
    undefined,
    context(cwd),
  );
  await tool.execute(
    "verify-record-lookup",
    { ref: first.details.ref },
    undefined,
    undefined,
    context(cwd),
  );
  expect(records).toHaveLength(3);
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ commandId: "verify", aggregate: true, ref: first.details.ref }),
    ]),
  );
  expect(
    records.every(
      (record) =>
        record && typeof record === "object" && "aggregate" in record && record.aggregate === true,
    ),
  ).toBe(true);
});

it("emits distinct verify lookup telemetry outcomes without changing error wording", async () => {
  const cwd = await projectFixture();
  const deps = dependencies();
  const records: unknown[] = [];
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: deps.executor,
    repositoryStateReader: deps.repositoryStateReader,
    invocationRecorder: (record) => records.push(record),
  });
  const first = await tool.execute(
    "verify-outcome-1",
    { omit: ["typecheck"] },
    undefined,
    undefined,
    context(cwd),
  );
  await tool.execute(
    "verify-outcome-lookup",
    { ref: first.details.ref },
    undefined,
    undefined,
    context(cwd),
  );
  const hitRecord = records.find(
    (record) =>
      record &&
      typeof record === "object" &&
      "toolCallId" in record &&
      record.toolCallId === "verify-outcome-lookup",
  ) as { lookup?: { attempted: boolean; success: boolean; outcome?: string } } | undefined;
  expect(hitRecord?.lookup).toEqual({ attempted: true, success: true, outcome: "success" });

  const missing = await tool
    .execute("verify-outcome-miss", { ref: "vr_missing" }, undefined, undefined, context(cwd))
    .catch((error: unknown) => error);
  expect(missing).toMatchObject({ code: "not-found" });
  expect(missing).toHaveProperty(
    "message",
    "validation ref not found in the process-local root-session cache. Root-session refs are process-scoped and are not durable across processes.",
  );
  const missRecord = records.find(
    (record) =>
      record &&
      typeof record === "object" &&
      "toolCallId" in record &&
      record.toolCallId === "verify-outcome-miss",
  ) as
    | { lookup?: { attempted: boolean; success: boolean; failure?: string; outcome?: string } }
    | undefined;
  expect(missRecord?.lookup).toEqual({
    attempted: true,
    success: false,
    failure: "not-found",
    outcome: "not-found",
  });

  const wrongFlow = await tool
    .execute(
      "verify-outcome-wrong-flow",
      { ref: "vr_flowrefs", flowId: "flow-b" },
      undefined,
      undefined,
      context(cwd),
    )
    .catch((error: unknown) => error);
  expect(wrongFlow).toMatchObject({ code: "not-found" });
  expect(wrongFlow).toHaveProperty(
    "message",
    "validation ref not found in the effective flow scope flow-b. A flow lookup requires the same effective flow scope; environment variables alone do not authorize a lookup.",
  );
  const wrongFlowRecord = records.find(
    (record) =>
      record &&
      typeof record === "object" &&
      "toolCallId" in record &&
      record.toolCallId === "verify-outcome-wrong-flow",
  ) as
    | { lookup?: { attempted: boolean; success: boolean; failure?: string; outcome?: string } }
    | undefined;
  expect(wrongFlowRecord?.lookup).toEqual({
    attempted: true,
    success: false,
    failure: "not-found",
    outcome: "unauthorized-flow",
  });
});

it("keeps the record failure pointer without duplicating complete step tails by ref", async () => {
  const cwd = await projectFixture();
  const deps = dependencies("lint");
  const tool = createVerifyToolForTesting({
    policy: policy(),
    resolver: deps.resolver,
    executor: deps.executor,
    repositoryStateReader: deps.repositoryStateReader,
  });
  const completed = await tool.execute(
    "verify-failure-ref",
    { omit: ["typecheck"] },
    undefined,
    undefined,
    context(cwd),
  );
  const lookup = await tool.execute(
    "verify-failure-ref-lookup",
    { ref: completed.details.ref },
    undefined,
    undefined,
    context(cwd),
  );
  expect(completed.details.failureTail).toBeUndefined();
  expect(completed.details.perStep[1]?.failureTail).toBe("failure tail");
  expect(lookup.details.failureTail).toBe("failure tail");
  expectNoAnsi(lookup.details);
  expect(lookup.details.perStep[1]).toHaveProperty("resolvedCommand");
  expect(lookup.details.perStep[1]).toHaveProperty("executable");
  expect(lookup.details.perStep[1]).not.toHaveProperty("failureTail");
  expect(lookup.details.perStep[1]?.stdout.text).toBe("stdout");
});
