import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../herdr.ts", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../herdr.ts")>();
	return {
		...mod,
		closeTab: vi.fn(),
		createTaskTab: vi.fn(),
		getAgentStatus: vi.fn(),
		herdrCli: vi.fn(),
		launchInPane: vi.fn(),
		resolveOwnWorkspace: vi.fn(),
	};
});

vi.mock("../poll.ts", () => ({
	pollSubagent: vi.fn(),
}));

import { closeTab, createTaskTab, getAgentStatus, herdrCli, launchInPane, resolveOwnWorkspace } from "../herdr.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { pollSubagent } from "../poll.ts";
import { runReusedAgent, runSingleAgent } from "../run.ts";
import { readRegistry, registerEntry } from "../registry.ts";
import type { AgentConfig } from "../agents.ts";
import type { SingleResult, SubagentDetails } from "../types.ts";
import { makeRegistryEntry } from "./helpers.ts";

const agent: AgentConfig = {
	name: "worker",
	description: "worker agent",
	systemPrompt: "You are a worker.",
	model: "test-model",
	source: "user",
	filePath: "/tmp/worker.md",
};

function makeDetails(results: SingleResult[]): SubagentDetails {
	return { mode: "single", agentScope: "user", projectAgentsDir: null, results };
}

function countTempDirs(): number {
	try {
		return fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("pi-subagent-")).length;
	} catch {
		return 0;
	}
}

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	for (const f of ["subagent-herdr.json", "subagent-herdr.json.lock"]) {
		try {
			fs.unlinkSync(path.join(getAgentDir(), f));
		} catch {}
	}
	vi.mocked(resolveOwnWorkspace).mockResolvedValue("ws1");
	vi.mocked(createTaskTab).mockResolvedValue({ paneId: "ws1:p9", tabId: "t9" });
	vi.mocked(launchInPane).mockResolvedValue(null);
	vi.mocked(herdrCli).mockResolvedValue({ result: {} });
	vi.mocked(getAgentStatus).mockResolvedValue({ status: "working" });
	vi.mocked(pollSubagent).mockResolvedValue("settled");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("runSingleAgent", () => {
	it("launches, polls, and registers a completed session", async () => {
		const before = countTempDirs();
		const result = await runSingleAgent("/tmp", [agent], "worker", "do it", undefined, 1, undefined, undefined, makeDetails, "/sess/parent.jsonl");
		expect(result.exitCode).toBe(0);
		expect(result.label).toBe("worker-1");
		expect(result.step).toBe(1);
		expect(result.paneId).toBe("ws1:p9");
		expect(createTaskTab).toHaveBeenCalledWith("ws1", "/tmp", "worker-1");
		expect(launchInPane).toHaveBeenCalledOnce();
		const launchArgs = vi.mocked(launchInPane).mock.calls[0];
		expect(launchArgs[1]).toContain("worker-1");
		expect(launchArgs[1]).toContain("--append-system-prompt");
		expect(pollSubagent).toHaveBeenCalledWith("ws1:p9", expect.stringContaining("subagent-ws1-worker-1.jsonl"), 0, undefined, result, undefined, expect.any(Function), undefined);
		const reg = readRegistry();
		expect(reg.tabs["ws1:worker-1"]).toMatchObject({ status: "done", agent: "worker", paneId: "ws1:p9", parentSession: "/sess/parent.jsonl" });
		expect(countTempDirs()).toBe(before);
	});

	it("cleans up and unregisters on launch failure", async () => {
		vi.mocked(launchInPane).mockResolvedValue("boom");
		const before = countTempDirs();
		const result = await runSingleAgent("/tmp", [agent], "worker", "do it", undefined, undefined, undefined, undefined, makeDetails, undefined);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Could not launch subagent in pane ws1:p9 (boom)");
		expect(closeTab).toHaveBeenCalledWith("t9");
		expect(readRegistry().tabs).toEqual({});
		expect(countTempDirs()).toBe(before);
	});

	it("fails fast for unknown agents without touching herdr", async () => {
		const result = await runSingleAgent("/tmp", [agent], "ghost", "do it", undefined, undefined, undefined, undefined, makeDetails, undefined);
		expect(result).toMatchObject({ exitCode: 1, agent: "ghost", agentSource: "unknown" });
		expect(result.stderr).toContain('Unknown agent: "ghost"');
		expect(createTaskTab).not.toHaveBeenCalled();
	});

	it("reports missing workspace resolution", async () => {
		vi.mocked(resolveOwnWorkspace).mockResolvedValue("");
		const result = await runSingleAgent("/tmp", [agent], "worker", "do it", undefined, undefined, undefined, undefined, makeDetails, undefined);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Could not resolve the herdr workspace");
	});
});

describe("runReusedAgent", () => {
	it("recreates the pane and relaunches when the pane is gone", async () => {
		vi.mocked(herdrCli).mockResolvedValue({ error: { code: "pane_not_found" } });
		vi.mocked(getAgentStatus).mockResolvedValue({ status: "no-agent" });
		registerEntry(makeRegistryEntry({ status: "running" }));
		const result = await runReusedAgent("/tmp", [agent], "worker-1", "next task", undefined, undefined, makeDetails);
		expect(result.exitCode).toBe(0);
		expect(createTaskTab).toHaveBeenCalledWith("ws1", "/tmp", "worker-1");
		expect(result.paneId).toBe("ws1:p9");
		const reg = readRegistry();
		expect(reg.tabs["ws1:worker-1"]).toMatchObject({ paneId: "ws1:p9", tabId: "t9", status: "done" });
		expect(launchInPane).toHaveBeenCalledOnce();
	});

	it("prompts an existing agent", async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: "working" });
		registerEntry(makeRegistryEntry({ status: "running" }));
		const result = await runReusedAgent("/tmp", [agent], "worker-1", "next task", undefined, undefined, makeDetails);
		expect(result.exitCode).toBe(0);
		expect(herdrCli).toHaveBeenCalledWith(["agent", "prompt", "ws1:p10", "next task"]);
		expect(createTaskTab).not.toHaveBeenCalled();
	});

	it("retries prompting and reports persistent failures", async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: "working" });
		vi.mocked(herdrCli).mockResolvedValue({ error: { code: "prompt_failed" } });
		registerEntry(makeRegistryEntry({ status: "running" }));
		const result = await runReusedAgent("/tmp", [agent], "worker-1", "next task", undefined, undefined, makeDetails);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Could not prompt subagent worker-1 in pane ws1:p10 (prompt_failed)");
		const promptCalls = vi.mocked(herdrCli).mock.calls.filter((c) => c[0][0] === "agent");
		expect(promptCalls).toHaveLength(3);
	});

	it("reports relaunch failures", async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: "no-agent" });
		vi.mocked(launchInPane).mockResolvedValue("relaunch exploded");
		registerEntry(makeRegistryEntry({ status: "running" }));
		const result = await runReusedAgent("/tmp", [agent], "worker-1", "next task", undefined, undefined, makeDetails);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Could not relaunch subagent worker-1 in pane ws1:p10 (relaunch exploded)");
	});

	it("fails fast for unknown labels", async () => {
		const result = await runReusedAgent("/tmp", [agent], "ghost-1", "next task", undefined, undefined, makeDetails);
		expect(result).toMatchObject({ exitCode: 1, agent: "ghost-1", agentSource: "reuse" });
		expect(result.stderr).toContain('No subagent session labeled "ghost-1"');
		expect(createTaskTab).not.toHaveBeenCalled();
	});
});
