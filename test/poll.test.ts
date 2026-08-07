import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../herdr.ts", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../herdr.ts")>();
	return {
		...mod,
		getAgentStatus: vi.fn(),
	};
});

import { getAgentStatus } from "../herdr.ts";
import { pollSubagent } from "../poll.ts";
import type { SingleResult, SubagentDetails } from "../types.ts";
import { assistantMsg, makeSingleResult, makeTempDir, toolResultMsg, userMsg, writeSessionFile } from "./helpers.ts";

function makeDetails(results: SingleResult[]): SubagentDetails {
	return { mode: "single", agentScope: "user", projectAgentsDir: null, results };
}

const INTERVAL_MS = 1500;

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("pollSubagent", () => {
	it("returns aborted immediately for an already-aborted signal", async () => {
		const dir = makeTempDir();
		const sessionFile = path.join(dir, "session.jsonl");
		fs.writeFileSync(sessionFile, "");
		const result = makeSingleResult();
		await expect(
			pollSubagent("ws1:p1", sessionFile, 0, AbortSignal.abort(), result, undefined, makeDetails),
		).resolves.toBe("aborted");
		expect(getAgentStatus).not.toHaveBeenCalled();
	});

	it("returns gone when the pane is gone", async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: "gone" });
		const dir = makeTempDir();
		const sessionFile = path.join(dir, "session.jsonl");
		fs.writeFileSync(sessionFile, "");
		const result = makeSingleResult();
		await expect(pollSubagent("ws1:p1", sessionFile, 0, undefined, result, undefined, makeDetails)).resolves.toBe("gone");
	});

	it("settles after stable idle with assistant output and tracks usage", async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = writeSessionFile(dir, "session.jsonl", [
			assistantMsg("final answer", {
				stopReason: "stop",
				usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
			}),
		]);
		vi.mocked(getAgentStatus).mockResolvedValueOnce({ status: "working" }).mockResolvedValue({ status: "idle" });
		const result = makeSingleResult();
		const promise = pollSubagent("ws1:p1", sessionFile, 0, undefined, result, undefined, makeDetails);

		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			if ((await Promise.race([promise.then(() => "done"), Promise.resolve("pending")])) === "done") break;
		}
		await expect(promise).resolves.toBe("settled");
		expect(result.herdrStatus).toBe("idle");
		expect(result.usage.turns).toBe(1);
		expect(result.usage.input).toBe(100);
		expect(result.usage.output).toBe(50);
		expect(result.usage.cacheRead).toBe(10);
		expect(result.usage.cacheWrite).toBe(5);
		expect(result.usage.contextTokens).toBe(150);
		expect(result.usage.cost).toBeCloseTo(0.001);
		expect(result.model).toBe("test-model");
		expect(result.stopReason).toBe("stop");
	});

	it("marks results as steered when the user steers multiple times", async () => {
		const dir = makeTempDir();
		const sessionFile = writeSessionFile(dir, "session.jsonl", [
			userMsg("original task"),
			assistantMsg("first answer"),
			userMsg("do it differently"),
			assistantMsg("second answer"),
		]);
		vi.mocked(getAgentStatus).mockResolvedValueOnce({ status: "working" }).mockResolvedValue({ status: "gone" });
		const result = makeSingleResult();
		await expect(pollSubagent("ws1:p1", sessionFile, 0, undefined, result, undefined, makeDetails)).resolves.toBe("gone");
		expect(result.steered).toBe(true);
	});

	it("fails with a startup timeout when nothing ever runs", async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = path.join(dir, "session.jsonl");
		fs.writeFileSync(sessionFile, "");
		vi.mocked(getAgentStatus).mockResolvedValue({ status: "idle" });
		const result = makeSingleResult();
		const promise = pollSubagent("ws1:p1", sessionFile, 0, undefined, result, undefined, makeDetails);
		for (let i = 0; i < 22; i++) {
			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			if ((await Promise.race([promise.then(() => "done"), Promise.resolve("pending")])) === "done") break;
		}
		await expect(promise).resolves.toBe("failed");
		expect(result.stderr).toBe("subagent did not start");
	});

	it("fails when agent status is lost", async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = writeSessionFile(dir, "session.jsonl", [assistantMsg("started but status unknown")]);
		vi.mocked(getAgentStatus).mockResolvedValue({ status: "unknown" });
		const result = makeSingleResult();
		const promise = pollSubagent("ws1:p1", sessionFile, 0, undefined, result, undefined, makeDetails);
		for (let i = 0; i < 44; i++) {
			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			if ((await Promise.race([promise.then(() => "done"), Promise.resolve("pending")])) === "done") break;
		}
		await expect(promise).resolves.toBe("failed");
		expect(result.stderr).toBe("herdr agent status was lost");
	});

	it("emits status updates when the state changes", async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = writeSessionFile(dir, "session.jsonl", [assistantMsg("in progress")]);
		vi.mocked(getAgentStatus).mockResolvedValueOnce({ status: "working" }).mockResolvedValue({ status: "idle" });
		const result = makeSingleResult();
		const updates: string[] = [];
		const promise = pollSubagent("ws1:p1", sessionFile, 0, undefined, result, (partial) => {
			const text = partial.content[0];
			if (text?.type === "text") updates.push(text.text);
		}, makeDetails);
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			if ((await Promise.race([promise.then(() => "done"), Promise.resolve("pending")])) === "done") break;
		}
		await expect(promise).resolves.toBe("settled");
		expect(updates.length).toBeGreaterThanOrEqual(1);
		expect(updates[updates.length - 1]).toContain("in progress");
	});

	it("detects approval blocks and notifies once", async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = writeSessionFile(dir, "session.jsonl", [
			assistantMsg("", {
				toolCalls: [{ id: "tc1", name: "bash", args: { command: "rm -rf /" } }],
			}),
		]);
		const { registerEntry, readRegistry } = await import("../registry.ts");
		registerEntry({
			label: "worker-1",
			agent: "worker",
			workspace: "ws1",
			paneId: "ws1:p1",
			tabId: "tab1",
			sessionFile,
			cwd: dir,
			status: "running",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastResult: "",
		});
		vi.mocked(getAgentStatus).mockResolvedValueOnce({ status: "blocked" }).mockResolvedValueOnce({ status: "blocked" }).mockResolvedValue({ status: "gone" });
		const result = makeSingleResult({ label: "worker-1", paneId: "ws1:p1" });
		const onBlocked = vi.fn();
		const promise = pollSubagent("ws1:p1", sessionFile, 0, undefined, result, undefined, makeDetails, onBlocked);
		for (let i = 0; i < 5; i++) {
			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			if ((await Promise.race([promise.then(() => "done"), Promise.resolve("pending")])) === "done") break;
		}
		await expect(promise).resolves.toBe("gone");
		expect(result.blockReason).toBe("approval");
		expect(result.blockedPreview).toBe("bash rm -rf /");
		expect(result.blockedSince).toBeDefined();
		expect(onBlocked).toHaveBeenCalledTimes(1);
		expect(onBlocked).toHaveBeenCalledWith({ label: "worker-1", blockReason: "approval", preview: "bash rm -rf /" });
		const reg = readRegistry();
		expect(reg.tabs["ws1:worker-1"]).toMatchObject({ status: "running", blockReason: "approval", blockedPreview: "bash rm -rf /" });
		expect(reg.tabs["ws1:worker-1"].blockedSince).toBeDefined();
	});

	it("notifies when an approval block is resolved", async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = writeSessionFile(dir, "session.jsonl", [
			assistantMsg("", {
				toolCalls: [{ id: "tc1", name: "bash", args: { command: "rm -rf /" } }],
			}),
		]);
		const { registerEntry } = await import("../registry.ts");
		registerEntry({
			label: "worker-1",
			agent: "worker",
			workspace: "ws1",
			paneId: "ws1:p1",
			tabId: "tab1",
			sessionFile,
			cwd: dir,
			status: "running",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastResult: "",
		});
		vi.mocked(getAgentStatus)
			.mockResolvedValueOnce({ status: "blocked" })
			.mockResolvedValueOnce({ status: "idle" })
			.mockResolvedValue({ status: "gone" });
		const result = makeSingleResult({ label: "worker-1", paneId: "ws1:p1" });
		const onBlocked = vi.fn();
		const promise = pollSubagent("ws1:p1", sessionFile, 0, undefined, result, undefined, makeDetails, onBlocked);
		for (let i = 0; i < 5; i++) {
			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			if ((await Promise.race([promise.then(() => "done"), Promise.resolve("pending")])) === "done") break;
		}
		await expect(promise).resolves.toBe("gone");
		expect(onBlocked).toHaveBeenCalledTimes(2);
		expect(onBlocked).toHaveBeenNthCalledWith(1, { label: "worker-1", blockReason: "approval", preview: "bash rm -rf /" });
		expect(onBlocked).toHaveBeenNthCalledWith(2, { label: "worker-1", blockReason: "approval", resolved: true });
		expect(result.blockReason).toBeUndefined();
	});

	it("notifies when an approval block resolves into a steer block", async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = writeSessionFile(dir, "session.jsonl", [
			assistantMsg("", {
				toolCalls: [{ id: "tc1", name: "bash", args: { command: "rm -rf /" } }],
			}),
		]);
		const { registerEntry } = await import("../registry.ts");
		registerEntry({
			label: "worker-1",
			agent: "worker",
			workspace: "ws1",
			paneId: "ws1:p1",
			tabId: "tab1",
			sessionFile,
			cwd: dir,
			status: "running",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastResult: "",
		});
		vi.mocked(getAgentStatus).mockImplementation(async () => {
			const raw = fs.readFileSync(sessionFile, "utf8");
			return raw.includes("instead do this") ? { status: "gone" } : { status: "blocked" };
		});
		const result = makeSingleResult({ label: "worker-1", paneId: "ws1:p1" });
		const onBlocked = vi.fn();
		const promise = pollSubagent("ws1:p1", sessionFile, 0, undefined, result, undefined, makeDetails, onBlocked);
		let appended = false;
		for (let i = 0; i < 6; i++) {
			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			if (!appended) {
				appended = true;
				fs.appendFileSync(
					sessionFile,
					`${JSON.stringify({ type: "message", message: toolResultMsg("tc1") })}\n${JSON.stringify({ type: "message", message: userMsg("instead do this") })}\n`,
				);
			}
			if ((await Promise.race([promise.then(() => "done"), Promise.resolve("pending")])) === "done") break;
		}
		await expect(promise).resolves.toBe("gone");
		expect(onBlocked).toHaveBeenCalledTimes(2);
		expect(onBlocked).toHaveBeenNthCalledWith(1, { label: "worker-1", blockReason: "approval", preview: "bash rm -rf /" });
		expect(onBlocked).toHaveBeenNthCalledWith(2, { label: "worker-1", blockReason: "steer", resolved: true });
		expect(result.blockReason).toBe("steer");
	});

	it("clears blocked state when the pane unblocks", async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = writeSessionFile(dir, "session.jsonl", [
			assistantMsg("", {
				toolCalls: [{ id: "tc1", name: "bash", args: { command: "rm -rf /" } }],
			}),
		]);
		const { registerEntry, readRegistry } = await import("../registry.ts");
		registerEntry({
			label: "worker-1",
			agent: "worker",
			workspace: "ws1",
			paneId: "ws1:p1",
			tabId: "tab1",
			sessionFile,
			cwd: dir,
			status: "running",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastResult: "",
		});
		vi.mocked(getAgentStatus).mockResolvedValueOnce({ status: "blocked" }).mockResolvedValueOnce({ status: "idle" }).mockResolvedValue({ status: "gone" });
		const result = makeSingleResult({ label: "worker-1", paneId: "ws1:p1" });
		const promise = pollSubagent("ws1:p1", sessionFile, 0, undefined, result, undefined, makeDetails);
		for (let i = 0; i < 5; i++) {
			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			if ((await Promise.race([promise.then(() => "done"), Promise.resolve("pending")])) === "done") break;
		}
		await expect(promise).resolves.toBe("gone");
		expect(result.blockReason).toBeUndefined();
		expect(result.blockedPreview).toBeUndefined();
		const reg = readRegistry();
		expect(reg.tabs["ws1:worker-1"]).toMatchObject({ status: "running" });
		expect(reg.tabs["ws1:worker-1"].blockReason).toBeUndefined();
		expect(reg.tabs["ws1:worker-1"].blockedPreview).toBeUndefined();
	});
});
