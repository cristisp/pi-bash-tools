import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

vi.mock("../herdr.ts", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../herdr.ts")>();
	return {
		...mod,
		closeTab: vi.fn(),
		getAgentStatus: vi.fn(),
	};
});

import { closeTab, getAgentStatus } from "../herdr.ts";
import { makeRegistryEntry, makeTempDir, stubEnv } from "./helpers.ts";

let dir: string;

function mockPi() {
	const pi = {
		on: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
	};
	return pi;
}

async function loadIndex() {
	vi.resetModules();
	return import("../index.ts");
}

beforeEach(() => {
	vi.resetModules();
	dir = makeTempDir();
	stubEnv(dir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

describe("extension registration", () => {
	it("registers tools, commands, and handlers when herdr env is present", async () => {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);

		const toolNames = pi.registerTool.mock.calls.map((c) => c[0].name);
		expect(toolNames).toEqual(["subagent", "subagent_close"]);

		const commandNames = pi.registerCommand.mock.calls.map((c) => c[0]);
		expect(commandNames).toEqual(["setup-subagents", "kill-session-subagents"]);

		const events = pi.on.mock.calls.map((c) => c[0]);
		expect(events).toContain("session_start");
		expect(events).toContain("input");
	});
});

describe("input handler", () => {
	async function getInputHandler() {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);
		const call = pi.on.mock.calls.find((c) => c[0] === "input");
		expect(call).toBeDefined();
		return call![1];
	}

	it("passes through when no sessions are linked", async () => {
		const handler = await getInputHandler();
		const ctx = { sessionManager: { getSessionFile: () => "/sess/a.jsonl" }, ui: { notify: vi.fn() } };
		const out = await handler({}, ctx);
		expect(out).toEqual({ action: "continue" });
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("passes through for running linked sessions", async () => {
		const { registerEntry } = await import("../registry.ts");
		registerEntry(makeRegistryEntry({ parentSession: "/sess/a.jsonl", status: "running" }));
		const handler = await getInputHandler();
		const ctx = { sessionManager: { getSessionFile: () => "/sess/a.jsonl" }, ui: { notify: vi.fn() } };
		const out = await handler({}, ctx);
		expect(out).toEqual({ action: "continue" });
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("passes through while a done session is working again", async () => {
		const { registerEntry } = await import("../registry.ts");
		registerEntry(makeRegistryEntry({ parentSession: "/sess/a.jsonl", status: "done" }));
		vi.mocked(getAgentStatus).mockResolvedValue({ status: "working" });
		const handler = await getInputHandler();
		const ctx = { sessionManager: { getSessionFile: () => "/sess/a.jsonl" }, ui: { notify: vi.fn() } };
		const out = await handler({}, ctx);
		expect(out).toEqual({ action: "continue" });
	});

	it("intercepts input for read-only done sessions", async () => {
		const { registerEntry } = await import("../registry.ts");
		registerEntry(makeRegistryEntry({ parentSession: "/sess/a.jsonl", sessionFile: "/sess/a.jsonl", status: "done" }));
		vi.mocked(getAgentStatus).mockResolvedValue({ status: "done" });
		const handler = await getInputHandler();
		const ctx = { sessionManager: { getSessionFile: () => "/sess/a.jsonl" }, ui: { notify: vi.fn() } };
		const out = await handler({}, ctx);
		expect(out).toEqual({ action: "handled" });
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("read-only"), "warning");
	});
});

describe("subagent_close tool", () => {
	async function getCloseTool() {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);
		const tool = pi.registerTool.mock.calls.find((c) => c[0].name === "subagent_close");
		expect(tool).toBeDefined();
		return tool![0];
	}

	it("reports unknown labels", async () => {
		const tool = await getCloseTool();
		const ctx = { sessionManager: { getSessionFile: () => "/sess/a.jsonl" }, ui: { notify: vi.fn() } };
		const out = await tool.execute("c1", { label: "ghost-1" }, undefined, undefined, ctx);
		expect(out.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("No session-linked subagent labeled \"ghost-1\"") });
		expect(closeTab).not.toHaveBeenCalled();
	});

	it("closes a specific linked subagent", async () => {
		const { registerEntry } = await import("../registry.ts");
		registerEntry(makeRegistryEntry({ parentSession: "/sess/a.jsonl" }));
		const tool = await getCloseTool();
		const ctx = { sessionManager: { getSessionFile: () => "/sess/a.jsonl" }, ui: { notify: vi.fn() } };
		const out = await tool.execute("c1", { label: "worker-1" }, undefined, undefined, ctx);
		expect(out.content[0]).toMatchObject({ type: "text", text: "Closed 1 subagent(s): ws1:worker-1" });
		expect(closeTab).toHaveBeenCalledWith("tab10");
	});

	it("closes all linked subagents without a label", async () => {
		const { registerEntry } = await import("../registry.ts");
		registerEntry(makeRegistryEntry({ parentSession: "/sess/a.jsonl" }));
		registerEntry(makeRegistryEntry({ label: "reviewer-1", agent: "reviewer", paneId: "ws1:p11", tabId: "tab11", parentSession: "/sess/a.jsonl" }));
		const tool = await getCloseTool();
		const ctx = { sessionManager: { getSessionFile: () => "/sess/a.jsonl" }, ui: { notify: vi.fn() } };
		const out = await tool.execute("c1", {}, undefined, undefined, ctx);
		expect(out.content[0]).toMatchObject({ type: "text", text: "Closed 2 subagent(s): ws1:worker-1, ws1:reviewer-1" });
		expect(closeTab).toHaveBeenCalledTimes(2);
	});
});

describe("commands", () => {
	async function getCommand(name: string) {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);
		const cmd = pi.registerCommand.mock.calls.find((c) => c[0] === name);
		expect(cmd).toBeDefined();
		return cmd![1];
	}

	it("kill-session-subagents closes linked sessions and notifies", async () => {
		const { registerEntry } = await import("../registry.ts");
		registerEntry(makeRegistryEntry({ parentSession: "/sess/a.jsonl" }));
		const cmd = await getCommand("kill-session-subagents");
		const ctx = { sessionManager: { getSessionFile: () => "/sess/a.jsonl" }, ui: { notify: vi.fn() } };
		await cmd.handler({}, ctx);
		expect(closeTab).toHaveBeenCalledWith("tab10");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Closed 1 subagent(s): ws1:worker-1", "info");
	});

	it("setup-subagents warns without UI", async () => {
		const cmd = await getCommand("setup-subagents");
		const ctx = { hasUI: false, ui: { notify: vi.fn() } };
		await cmd.handler({}, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("/setup-subagents needs an interactive session", "warning");
	});

	it("setup-subagents creates agent files with a valid model", async () => {
		const cmd = await getCommand("setup-subagents");
		const input = vi.fn().mockResolvedValue("github-copilot/gpt-5.6-luna:high");
		const confirm = vi.fn().mockResolvedValue(true);
		const notify = vi.fn();
		const ctx = { hasUI: true, ui: { input, confirm, notify } };
		await cmd.handler({}, ctx);
		const agentsDir = path.join(dir, "agents");
		expect(fs.existsSync(path.join(agentsDir, "worker.md"))).toBe(true);
		expect(fs.existsSync(path.join(agentsDir, "planner.md"))).toBe(true);
		expect(fs.existsSync(path.join(agentsDir, "reviewer.md"))).toBe(true);
		expect(fs.existsSync(path.join(agentsDir, "scout.md"))).toBe(true);
		const worker = fs.readFileSync(path.join(agentsDir, "worker.md"), "utf-8");
		expect(worker).toContain("model: github-copilot/gpt-5.6-luna:high");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("4 created"), "info");
	});

	it("setup-subagents retries invalid models and aborts on cancel", async () => {
		const cmd = await getCommand("setup-subagents");
		const input = vi.fn().mockResolvedValueOnce("not a model").mockResolvedValueOnce(undefined);
		const notify = vi.fn();
		const ctx = { hasUI: true, ui: { input, confirm: vi.fn(), notify } };
		await cmd.handler({}, ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Invalid model \"not a model\""), "warning");
		expect(notify).toHaveBeenCalledWith("/setup-subagents canceled", "info");
	});

	it("setup-subagents overwrites existing files after confirm", async () => {
		const agentsDir = path.join(dir, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), "old");
		const cmd = await getCommand("setup-subagents");
		const input = vi.fn().mockResolvedValue("p/m:off");
		const confirm = vi.fn().mockResolvedValue(true);
		const notify = vi.fn();
		const ctx = { hasUI: true, ui: { input, confirm, notify } };
		await cmd.handler({}, ctx);
		expect(confirm).toHaveBeenCalledWith("Overwrite existing agent files?", expect.stringContaining("worker.md"));
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("3 created, 1 updated"), "info");
	});

	it("setup-subagents aborts when the model stays invalid", async () => {
		const cmd = await getCommand("setup-subagents");
		const input = vi.fn().mockResolvedValue("nope");
		const notify = vi.fn();
		const ctx = { hasUI: true, ui: { input, confirm: vi.fn(), notify } };
		await cmd.handler({}, ctx);
		expect(notify).toHaveBeenCalledWith("/setup-subagents aborted: invalid model spec", "error");
	});
});
