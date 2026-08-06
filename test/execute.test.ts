import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeRegistryEntry, makeTempDir, stubEnv, writeAgentFile } from "./helpers.ts";

let dir: string;

beforeEach(() => {
	vi.resetModules();
	dir = makeTempDir();
	stubEnv(dir);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

function ctx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		cwd: dir,
		hasUI: false,
		sessionManager: { getSessionFile: () => undefined },
		ui: {} as ExtensionContext["ui"],
		...overrides,
	} as ExtensionContext;
}

async function loadExecute() {
	return import("../execute.ts");
}

async function seedRegistry(entries: ReturnType<typeof makeRegistryEntry>[]) {
	const { registerEntry } = await import("../registry.ts");
	for (const e of entries) registerEntry(e);
}

describe("executeSubagent validation", () => {
	it("rejects empty parameters", async () => {
		const { executeSubagent } = await loadExecute();
		const result = await executeSubagent({}, undefined, undefined, ctx());
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Invalid parameters. Provide exactly one mode (single, parallel, chain, reuse, or list).\nAvailable agents: none",
		});
	});

	it("rejects multiple modes at once", async () => {
		const { executeSubagent } = await loadExecute();
		const result = await executeSubagent({ agent: "worker", task: "x", listSubagents: true }, undefined, undefined, ctx());
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Provide exactly one mode") });
	});

	it("lists available agents in invalid responses", async () => {
		const agentsDir = path.join(dir, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		writeAgentFile(agentsDir, "worker.md", "prompt", { name: "worker", description: "d" });
		const { executeSubagent } = await loadExecute();
		const result = await executeSubagent({}, undefined, undefined, ctx());
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Available agents: worker (user)") });
	});

	it("lists subagents without entries", async () => {
		const { executeSubagent } = await loadExecute();
		const result = await executeSubagent({ listSubagents: true }, undefined, undefined, ctx());
		expect(result.content[0]).toMatchObject({ type: "text", text: "No subagent sessions yet." });
	});

	it("lists subagents with filters", async () => {
		await seedRegistry([makeRegistryEntry({ status: "running" }), makeRegistryEntry({ label: "reviewer-1", agent: "reviewer", status: "done" })]);
		const { executeSubagent } = await loadExecute();
		const result = await executeSubagent({ listSubagents: true, listStatus: "running" }, undefined, undefined, ctx());
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("worker-1") });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.not.stringContaining("reviewer-1") });
	});

	it("requires a task for reuse", async () => {
		const { executeSubagent } = await loadExecute();
		const result = await executeSubagent({ reuseLabel: "worker-1" }, undefined, undefined, ctx());
		expect(result.content[0]).toMatchObject({ type: "text", text: "Invalid parameters. reuseLabel requires a task (the next message for that session)." });
	});

	it("reports unknown reuse labels", async () => {
		const { executeSubagent } = await loadExecute();
		const result = await executeSubagent({ reuseLabel: "ghost-1", task: "hi" }, undefined, undefined, ctx());
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('No subagent session labeled "ghost-1"') });
	});

	it("reports unknown agents in single mode", async () => {
		const { executeSubagent } = await loadExecute();
		const result = await executeSubagent({ agent: "ghost", task: "x" }, undefined, undefined, ctx());
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('Unknown agent: "ghost"') });
		expect(result.details).toMatchObject({ mode: "single", results: [{ exitCode: 1, agent: "ghost" }] });
	});

	it("rejects too many parallel tasks", async () => {
		const { executeSubagent } = await loadExecute();
		const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: `a${i}`, task: `t${i}` }));
		const result = await executeSubagent({ tasks }, undefined, undefined, ctx());
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Too many parallel tasks (9)") });
	});

	it("aggregates failed parallel runs", async () => {
		const { executeSubagent } = await loadExecute();
		const result = await executeSubagent({ tasks: [{ agent: "ghost1", task: "a" }, { agent: "ghost2", task: "b" }] }, undefined, undefined, ctx());
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Parallel: 0/2 succeeded") });
		expect(result.details).toMatchObject({ mode: "parallel", results: [{ exitCode: 1 }, { exitCode: 1 }] });
	});

	it("stops chains at the first failing step", async () => {
		const { executeSubagent } = await loadExecute();
		const result = await executeSubagent({ chain: [{ agent: "ghost", task: "a" }, { agent: "worker", task: "b" }] }, undefined, undefined, ctx());
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Chain stopped at step 1 (ghost)") });
		expect(result.details).toMatchObject({ mode: "chain", results: [{ agent: "ghost", step: 1, exitCode: 1 }] });
	});

	it("cancels when project agents are not approved", async () => {
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		writeAgentFile(path.join(dir, ".pi", "agents"), "scout.md", "project prompt", { name: "scout", description: "project scout" });
		const confirm = vi.fn().mockResolvedValue(false);
		const { executeSubagent } = await loadExecute();
		const result = await executeSubagent({ agent: "scout", task: "x", agentScope: "project" }, undefined, undefined, ctx({ hasUI: true, ui: { confirm } as never }));
		expect(result.content[0]).toMatchObject({ type: "text", text: "Canceled: project-local agents not approved." });
		expect(confirm).toHaveBeenCalledWith("Run project-local agents?", expect.stringContaining("scout"));
	});

	it("runs project agents without UI confirm", async () => {
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		writeAgentFile(path.join(dir, ".pi", "agents"), "scout.md", "project prompt", { name: "scout", description: "project scout" });
		const { executeSubagent } = await loadExecute();
		const result = await executeSubagent({ agent: "scout", task: "x", agentScope: "project" }, undefined, undefined, ctx());
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.not.stringContaining("Canceled: project-local agents not approved") });
	});
});

describe("executeSubagent nested guard", () => {
	it("blocks nested subagents when PI_SUBAGENT_NESTED is set", async () => {
		vi.resetModules();
		vi.stubEnv("PI_SUBAGENT_NESTED", "1");
		const { executeSubagent } = await import("../execute.ts");
		const result = await executeSubagent({ agent: "worker", task: "x" }, undefined, undefined, ctx());
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Nested subagents are disabled") });
		expect(result.details).toMatchObject({ mode: "single", results: [] });
	});
});
