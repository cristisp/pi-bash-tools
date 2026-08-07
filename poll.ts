import * as fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { formatBlockedPreview, findPendingToolCall, getFinalOutput, statusTag } from "./format.ts";
import { getConfig } from "./config.ts";
import { getAgentStatus, sleep } from "./herdr.ts";
import { updateRegistryEntry } from "./registry.ts";
import type { SubagentHerdrConfig } from "./config.ts";
import type { BlockEventInfo, BlockReason, HerdrStatus, OnUpdateCallback, SingleResult, SubagentDetails } from "./types.ts";

function emitStatusUpdate(
	onUpdate: OnUpdateCallback | undefined,
	currentResult: SingleResult,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): void {
	if (onUpdate) {
		const tag = statusTag(currentResult);
		onUpdate({
			content: [{ type: "text", text: `[${tag}] ${getFinalOutput(currentResult.messages) || "(running...)"}` }],
			details: makeDetails([currentResult]),
		});
	}
}

interface TailState {
	lastEntryAt: number;
	userMessages: number;
	lastMessageRole: string | undefined;
	steerPendingSince: number | null;
	abortedAt: number | null;
}

function trackToolCalls(
	msg: Message,
	pendingToolCalls: Map<string, { name: string; args: Record<string, any> }>,
): void {
	if (msg.role === "assistant") {
		for (const part of msg.content) {
			if (part.type === "toolCall" && typeof part.id === "string") {
				pendingToolCalls.set(part.id, { name: part.name, args: part.arguments });
			}
		}
	} else if (msg.role === "toolResult") {
		pendingToolCalls.delete(msg.toolCallId);
	}
}

function applyAssistantMessage(msg: Extract<Message, { role: "assistant" }>, currentResult: SingleResult, state: TailState): void {
	state.lastMessageRole = "assistant";
	state.steerPendingSince = null;
	if (msg.stopReason === "aborted") state.abortedAt = Date.now();
	else state.abortedAt = null;
	currentResult.usage.turns++;
	const usage = msg.usage;
	if (usage) {
		currentResult.usage.input += usage.input || 0;
		currentResult.usage.output += usage.output || 0;
		currentResult.usage.cacheRead += usage.cacheRead || 0;
		currentResult.usage.cacheWrite += usage.cacheWrite || 0;
		currentResult.usage.cost += usage.cost?.total || 0;
		currentResult.usage.contextTokens = usage.totalTokens || 0;
	}
	if (!currentResult.model && msg.model) currentResult.model = msg.model;
	if (msg.stopReason) currentResult.stopReason = msg.stopReason;
	if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
}

function processSessionMessage(
	msg: Message,
	currentResult: SingleResult,
	pendingToolCalls: Map<string, { name: string; args: Record<string, any> }>,
	state: TailState,
): void {
	currentResult.messages.push(msg);
	trackToolCalls(msg, pendingToolCalls);
	state.lastEntryAt = Date.now();
	if (msg.role === "user") {
		state.userMessages++;
		state.lastMessageRole = "user";
		if (state.steerPendingSince === null) state.steerPendingSince = Date.now();
	}
	if (msg.role === "assistant") {
		applyAssistantMessage(msg, currentResult, state);
	}
}

function detectBlock(
	currentResult: SingleResult,
	pendingToolCalls: Map<string, { name: string; args: Record<string, any> }>,
): { reason: BlockReason; preview: string | undefined } {
	const pending = findPendingToolCall(currentResult.messages, pendingToolCalls);
	const blockReason: BlockReason = pending ? "approval" : "steer";
	return {
		reason: blockReason,
		preview: pending ? formatBlockedPreview(pending.name, pending.args) : undefined,
	};
}

function evaluateIdleDone(
	prevStatus: HerdrStatus | undefined,
	sawWorking: boolean,
	hasAssistantOutput: boolean,
	settledCandidateAt: number | null,
	lastEntryAt: number,
	lastMessageRole: string | undefined,
	steerPendingSince: number | null,
	abortedAt: number | null,
	cfg: SubagentHerdrConfig,
): { settle: boolean; candidate: number | null } {
	const now = Date.now();
	let candidate = settledCandidateAt;
	if (prevStatus !== "idle" && prevStatus !== "done") {
		candidate = now;
	}
	if (sawWorking || hasAssistantOutput) {
		const hasPendingSteer =
			lastMessageRole === "user" &&
			steerPendingSince !== null &&
			now - steerPendingSince < cfg.steerTimeoutMs;
		const inAbortGrace = abortedAt !== null && now - abortedAt < cfg.abortGraceMs;
		if (hasPendingSteer || inAbortGrace) {
			candidate = null;
		} else if (
			now - (candidate ?? 0) >= cfg.settleStabilityMs &&
			now - lastEntryAt >= cfg.settleStabilityMs
		) {
			return { settle: true, candidate };
		}
	} else {
		candidate = null;
	}
	return { settle: false, candidate };
}

function handleBlockedState(
	currentResult: SingleResult,
	pendingToolCalls: Map<string, { name: string; args: Record<string, any> }>,
	prevStatus: string | undefined,
	prevReason: BlockReason | undefined,
	onBlocked: ((info: BlockEventInfo) => void) | undefined,
): BlockReason | undefined {
	const { reason, preview } = detectBlock(currentResult, pendingToolCalls);
	const firstBlock = prevStatus !== "blocked";
	const reasonChanged = !firstBlock && prevReason !== reason;
	currentResult.blockReason = reason;
	currentResult.blockedPreview = preview;
	if (firstBlock) currentResult.blockedSince = Date.now();
	if (firstBlock || reasonChanged) {
		const label = currentResult.label;
		if (label) {
			updateRegistryEntry(label, {
				status: "running",
				blockedSince: currentResult.blockedSince,
				blockReason: reason,
				blockedPreview: preview,
				updatedAt: Date.now(),
			});
		}
		if (reason === "approval" && prevReason !== "approval") {
			onBlocked?.({ label: currentResult.label ?? "?", blockReason: reason, preview });
		} else if (prevReason === "approval" && reason !== "approval") {
			onBlocked?.({ label: currentResult.label ?? "?", blockReason: reason, resolved: true });
		}
	}
	return reason;
}

function clearBlockedState(currentResult: SingleResult): void {
	currentResult.blockReason = undefined;
	currentResult.blockedSince = undefined;
	currentResult.blockedPreview = undefined;
	const label = currentResult.label;
	if (label) {
		updateRegistryEntry(label, {
			blockedSince: undefined,
			blockReason: undefined,
			blockedPreview: undefined,
			updatedAt: Date.now(),
		});
	}
}

// fallow-ignore-next-line complexity
export async function pollSubagent(
	paneId: string,
	sessionFile: string,
	initialOffset: number,
	signal: AbortSignal | undefined,
	currentResult: SingleResult,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	onBlocked?: (info: BlockEventInfo) => void,
): Promise<"settled" | "failed" | "gone" | "aborted"> {
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
	};
	if (signal) {
		if (signal.aborted) wasAborted = true;
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	const startedAt = Date.now();
	let sawWorking = false;
	let lastKnownAt = Date.now();
	let settledCandidateAt: number | null = null;
	let offset = initialOffset;
	let fd: number | null = null;
	let lastEmitKey = "";
	let prevReason: BlockReason | undefined;
	const pendingToolCalls = new Map<string, { name: string; args: Record<string, any> }>();
	const tailState: TailState = {
		lastEntryAt: Date.now(),
		userMessages: 0,
		lastMessageRole: undefined,
		steerPendingSince: null,
		abortedAt: null,
	};

	const readSessionTail = () => {
		if (fd === null) {
			try {
				fd = fs.openSync(sessionFile, "r");
			} catch {
				return;
			}
		}
		let size = 0;
		try {
			size = fs.fstatSync(fd).size;
		} catch {
			return;
		}
		if (size <= offset) return;
		const chunk = Buffer.alloc(size - offset);
		fs.readSync(fd, chunk, 0, chunk.length, offset);
		const raw = chunk.toString("utf8");
		const lastNl = raw.lastIndexOf("\n");
		if (lastNl === -1) return;
		offset += lastNl + 1;
		for (const line of raw.slice(0, lastNl + 1).split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== "message" || !entry.message) continue;
			processSessionMessage(entry.message as Message, currentResult, pendingToolCalls, tailState);
		}
	};

	try {
		while (true) {
			if (wasAborted) return "aborted";
			const cfg = getConfig();
			const prevStatus = currentResult.herdrStatus;
			const { status } = await getAgentStatus(paneId);
			if (status === "working" || status === "idle" || status === "blocked" || status === "done") {
				currentResult.herdrStatus = status;
			}
			readSessionTail();
			currentResult.steered = tailState.userMessages > 1;
			if (currentResult.herdrStatus === "blocked") {
				prevReason = handleBlockedState(currentResult, pendingToolCalls, prevStatus, prevReason, onBlocked);
			} else if (prevStatus === "blocked") {
				if (prevReason === "approval") {
					onBlocked?.({ label: currentResult.label ?? "?", blockReason: "approval", resolved: true });
				}
				clearBlockedState(currentResult);
				prevReason = undefined;
			}
			const emitKey = `${status}|${currentResult.messages.length}|${currentResult.blockReason ?? ""}|${currentResult.blockedPreview ?? ""}`;
			if (emitKey !== lastEmitKey) {
				lastEmitKey = emitKey;
				emitStatusUpdate(onUpdate, currentResult, makeDetails);
			}
			if (status === "gone") return "gone";
			if (status === "working") {
				sawWorking = true;
				lastKnownAt = Date.now();
				settledCandidateAt = null;
			} else if (status === "blocked") {
				lastKnownAt = Date.now();
				settledCandidateAt = null;
			} else if (status === "idle" || status === "done") {
				lastKnownAt = Date.now();
				const { settle, candidate } = evaluateIdleDone(
					prevStatus,
					sawWorking,
					currentResult.messages.some((m) => m.role === "assistant"),
					settledCandidateAt,
					tailState.lastEntryAt,
					tailState.lastMessageRole,
					tailState.steerPendingSince,
					tailState.abortedAt,
					cfg,
				);
				settledCandidateAt = candidate;
				if (settle) return "settled";
			} else if (Date.now() - lastKnownAt > cfg.statusLossTimeoutMs) {
				currentResult.stderr = "herdr agent status was lost";
				return "failed";
			}
			if (Date.now() - startedAt > cfg.startupTimeoutMs && !sawWorking && currentResult.messages.length === 0) {
				currentResult.stderr = "subagent did not start";
				return "failed";
			}
			await sleep(cfg.pollIntervalMs);
		}
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {}
		}
		if (signal && !wasAborted) signal.removeEventListener("abort", onAbort);
	}
}
