import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PolicyStore } from "../../src/tools/policy/types.ts";
import { createProjectCommandExecutor } from "../../src/tools/project-command/execution.ts";
import type { ProjectCommandExecutionOutcome } from "../../src/tools/project-command/execution.ts";
import type { ProjectCommandExecutor } from "../../src/tools/project-command/runner.ts";
import type { ProjectCommandRepositoryStateReader } from "../../src/tools/project-command/repository-state.ts";
import type { ProjectCommandResolver } from "../../src/tools/project-command/resolution.ts";
import {
  readNodeProjectInfo,
  resolveNodeProjectCommand,
} from "../../src/tools/project-command/node.ts";
import {
  createVerifyEvidenceCache,
  isVerifyEvidenceCacheRecord,
  isVerifyEvidenceRecord,
} from "../../src/tools/verify/cache.ts";
import { createVerifyToolForTesting } from "../../src/tools/verify/tool.ts";
import { validateVerifyInput } from "../../src/tools/verify/schema.ts";
import type { VerifyToolContext } from "../../src/tools/verify/tool.ts";
import type { VerifyEvidenceRecord, VerifyPhase } from "../../src/tools/verify/types.ts";

const fixtureDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
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
  await expect(
    tool.execute("verify-missing-ref", { ref: "vr_missing" }, undefined, undefined, context(cwd)),
  ).rejects.toMatchObject({
    code: "not-found",
    message: expect.stringContaining("process-local root-session cache"),
  });
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
    cacheFormatVersion: 1 as const,
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
  const alias = { key: `ref:${record.ref}`, record };
  expect(isVerifyEvidenceCacheRecord(alias, `ref:${record.ref}`)).toBe(true);
  expect(isVerifyEvidenceCacheRecord(record, `ref:${record.ref}`)).toBe(false);
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
});

it("rejects pre-remediation durable records with unsafe tails or fractional durations", async () => {
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
      cacheFormatVersion: 1,
      key: "compatibility-key",
      ref: "vr_compatibility-key",
      projectPath: cwd,
      resolvedCommands: steps.map((step) => step.command),
      perStep: steps,
      verdict: "passed",
      covers: ["compatibility"],
      createdAt: 0,
    };
    createVerifyEvidenceCache({ rootDirectory: cacheRoot }).set(record);
    const ansi = `${String.fromCodePoint(0x1b)}[31m${"failure ".repeat(2_000)}${String.fromCodePoint(0x1b)}[0m`;
    const invalidRecord: VerifyEvidenceRecord = {
      ...record,
      perStep: record.perStep.map((step, index) =>
        index === 0 ? { ...step, durationMs: 1.5, failureTail: ansi } : step,
      ),
    };
    const cacheDirectory = join(cacheRoot, "flows", "verify-compat-flow", "project-command");
    const files = await readdir(cacheDirectory);
    await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          const filePath = join(cacheDirectory, file);
          const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            !("key" in parsed) ||
            typeof parsed.key !== "string"
          ) {
            return;
          }
          if (parsed.key === record.key) {
            await writeFile(filePath, JSON.stringify(invalidRecord));
          } else if (parsed.key === `ref:${record.ref}`) {
            await writeFile(filePath, JSON.stringify({ key: parsed.key, record: invalidRecord }));
          }
        }),
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
    const files = await readdir(flowDirectory);
    const entries = await Promise.all(
      files.map(async (file) => {
        const filePath = join(flowDirectory, file);
        return { filePath, parsed: JSON.parse(await readFile(filePath, "utf8")) as unknown };
      }),
    );
    const refEntry = entries.find(({ parsed }) => {
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        "key" in parsed &&
        typeof parsed.key === "string" &&
        parsed.key.startsWith("ref:") &&
        "record" in parsed
      );
    });
    if (
      refEntry !== undefined &&
      typeof refEntry.parsed === "object" &&
      refEntry.parsed !== null &&
      "record" in refEntry.parsed
    ) {
      const serialized = JSON.stringify(refEntry.parsed.record);
      if (serialized !== undefined) await writeFile(refEntry.filePath, serialized);
    }
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
