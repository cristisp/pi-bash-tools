import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { AGENT_TEMPLATES, isValidModelSpec, normalizeModelSpec, renderAgentFile } from "./templates.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

const POLL_INTERVAL_MS = 1500;
const STARTUP_TIMEOUT_MS = 30_000;
const SETTLE_STABILITY_MS = 5000;
const STATUS_LOSS_TIMEOUT_MS = 60_000;
const ABORT_GRACE_MS = 60_000;
const STEER_TIMEOUT_MS = 60_000;

const HERDR_ENV = process.env.HERDR_ENV === "1";
const HERDR_SOCKET_PATH = process.env.HERDR_SOCKET_PATH;
const HERDR_PANE_ID = process.env.HERDR_PANE_ID;
const HERDR_SESSION = process.env.HERDR_SESSION || "";
const NESTED = process.env.PI_SUBAGENT_NESTED === "1";

const REGISTRY_PATH = path.join(getAgentDir(), "subagent-herdr.json");

type HerdrStatus = "unknown" | "working" | "idle" | "blocked" | "done";

type BlockReason = "approval" | "steer";

type RegistryStatus = "running" | "done";

interface RegistryEntry {
	label: string;
	agent: string;
	workspace: string;
	paneId: string;
	tabId: string;
	sessionFile: string;
	cwd: string;
	status: RegistryStatus;
	createdAt: number;
	updatedAt: number;
	lastResult: string;
	contextTokens?: number;
	parentSession?: string;
	blockedSince?: number;
	blockReason?: BlockReason;
	blockedPreview?: string;
}

interface Registry {
	counters: Record<string, Record<string, number>>;
	tabs: Record<string, RegistryEntry>;
}

function ownWorkspaceId(): string {
	return (HERDR_PANE_ID ?? "").split(":")[0] || "default";
}

let cachedWorkspaceId: string | null | undefined;

function herdrSessionArgs(): string[] {
	return HERDR_SESSION ? ["--session", HERDR_SESSION] : [];
}

function herdrCli(args: string[]): Promise<any> {
	return new Promise((resolve, reject) => {
		execFile(
			"herdr",
			[...args, ...herdrSessionArgs()],
			{ timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
			(err, stdout, stderr) => {
				for (const out of [stdout, stderr]) {
					if (out) {
						try {
							resolve(JSON.parse(out));
							return;
						} catch {}
					}
				}
				if (err) {
					reject(new Error(`herdr ${args[0]} failed: ${err.message}`));
					return;
				}
				resolve({});
			},
		);
	});
}

function herdrErrorCode(resp: any): string | undefined {
	return resp?.error?.code;
}

function herdrErrorText(resp: any): string {
	const e = resp?.error;
	if (!e) return "";
	if (typeof e === "string") return e;
	const parts: string[] = [];
	if (typeof e.code === "string") parts.push(e.code);
	if (typeof e.message === "string") parts.push(e.message);
	else if (typeof e.detail === "string") parts.push(e.detail);
	return parts.join(": ");
}

function readRegistry(): Registry {
	try {
		const raw = fs.readFileSync(REGISTRY_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && typeof parsed.tabs === "object" && typeof parsed.counters === "object") {
			return parsed as Registry;
		}
	} catch {}
	return { counters: {}, tabs: {} };
}

function writeRegistry(reg: Registry): void {
	const tmp = `${REGISTRY_PATH}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, REGISTRY_PATH);
	} catch {}
}

function withRegistryFileLock<T>(fn: () => T): T {
	const lockPath = `${REGISTRY_PATH}.lock`;
	const deadline = Date.now() + 10_000;
	while (true) {
		try {
			const fd = fs.openSync(lockPath, "wx");
			fs.closeSync(fd);
			try {
				return fn();
			} finally {
				try {
					fs.unlinkSync(lockPath);
				} catch {}
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				if (Date.now() - fs.statSync(lockPath).mtimeMs > 5000) {
					fs.unlinkSync(lockPath);
					continue;
				}
			} catch {}
			if (Date.now() > deadline) throw new Error("subagent-herdr registry lock timeout");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	}
}

function mutateRegistry(mutate: (reg: Registry) => void): void {
	withRegistryFileLock(() => {
		const reg = readRegistry();
		mutate(reg);
		writeRegistry(reg);
	});
}

function sanitizeName(name: string): string {
	return name.replace(/[^\w.-]+/g, "_");
}

function sessionFileFor(ws: string, label: string): string {
	const dir = path.join(getAgentDir(), "sessions");
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {}
	return path.join(dir, `subagent-${ws}-${label}.jsonl`);
}

function allocateLabel(agent: string): { label: string; sessionFile: string } {
	const ws = ownWorkspaceId();
	let label = "";
	mutateRegistry((reg) => {
		const counters = reg.counters[ws] ?? (reg.counters[ws] = {});
		let n = (counters[agent] ?? 0) + 1;
		label = `${sanitizeName(agent)}-${n}`;
		while (fs.existsSync(sessionFileFor(ws, label))) {
			n++;
			label = `${sanitizeName(agent)}-${n}`;
		}
		counters[agent] = n;
	});
	return { label, sessionFile: sessionFileFor(ws, label) };
}

function registerEntry(entry: RegistryEntry): void {
	mutateRegistry((reg) => {
		reg.tabs[`${entry.workspace}:${entry.label}`] = entry;
	});
}

function updateRegistryEntry(label: string, patch: Partial<RegistryEntry>): void {
	mutateRegistry((reg) => {
		const entry = reg.tabs[`${ownWorkspaceId()}:${label}`];
		if (!entry) return;
		Object.assign(entry, patch);
	});
}

function removeRegistryEntry(label: string): void {
	mutateRegistry((reg) => {
		delete reg.tabs[`${ownWorkspaceId()}:${label}`];
	});
}

function sessionLinkedEntries(sessionFile: string | undefined): RegistryEntry[] {
	if (!sessionFile) return [];
	return Object.values(readRegistry().tabs).filter((e) => e.parentSession === sessionFile);
}

async function closeSubagentEntries(entries: RegistryEntry[]): Promise<string> {
	const closed: string[] = [];
	for (const entry of entries) {
		await closeTab(entry.tabId);
		mutateRegistry((reg) => {
			delete reg.tabs[`${entry.workspace}:${entry.label}`];
		});
		closed.push(`${entry.workspace}:${entry.label}`);
	}
	return closed.join(", ");
}

async function closeSubagentFlow(
	entries: RegistryEntry[],
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
): Promise<AgentToolResult<unknown>> {
	if (entries.length === 0) {
		return { content: [{ type: "text", text: "No subagents are linked to this session." }], details: {} };
	}
	const running = entries.filter((e) => e.status === "running");
	const summary = entries
		.map((e) => {
			let line = `${e.workspace}:${e.label}  ${e.status}`;
			if (e.status === "running") {
				const blocked = registryBlockedInfo(e);
				line += blocked ? ` (${blocked})` : " (still running)";
			}
			return line;
		})
		.join("\n");
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm(
			"Close subagents?",
			`The following subagents will be closed (tab closed, removed from registry, session files preserved):\n\n${summary}${running.length > 0 ? `\n\n⚠ ${running.length} still running - closing them kills in-flight work` : ""}`,
		);
		if (!ok) {
			return { content: [{ type: "text", text: "Canceled - no subagents were closed." }], details: {} };
		}
	}
	const closed = await closeSubagentEntries(entries);
	return { content: [{ type: "text", text: `Closed ${entries.length} subagent(s): ${closed}` }], details: {} };
}

async function reconcileRegistry(): Promise<void> {
	let entries: RegistryEntry[];
	try {
		entries = Object.values(readRegistry().tabs);
	} catch {
		return;
	}
	for (const entry of entries) {
		let paneAlive = true;
		try {
			const resp = await herdrCli(["pane", "get", entry.paneId]);
			paneAlive = herdrErrorCode(resp) !== "pane_not_found";
		} catch {
			return;
		}
		if (!paneAlive) {
			mutateRegistry((reg) => {
				delete reg.tabs[`${entry.workspace}:${entry.label}`];
			});
			continue;
		}
		if (entry.status !== "running") continue;
		const s1 = await getAgentStatus(entry.paneId);
		if (s1.status !== "idle" && s1.status !== "done" && s1.status !== "no-agent") continue;
		await sleep(5000);
		const s2 = await getAgentStatus(entry.paneId);
		if (s2.status === "idle" || s2.status === "done" || s2.status === "no-agent") {
			updateRegistryEntry(entry.label, { status: "done", updatedAt: Date.now() });
		}
	}
}

async function resolveOwnWorkspace(): Promise<string> {
	if (cachedWorkspaceId !== undefined) return cachedWorkspaceId ?? "";
	if (!HERDR_PANE_ID) return "";
	try {
		const resp = await herdrCli(["pane", "get", HERDR_PANE_ID]);
		const ws = resp?.result?.pane?.workspace_id;
		cachedWorkspaceId = typeof ws === "string" && ws ? ws : null;
	} catch {
		cachedWorkspaceId = null;
	}
	return cachedWorkspaceId ?? "";
}

async function createTaskTab(workspaceId: string, cwd: string, label: string): Promise<{ paneId: string; tabId: string }> {
	const resp = await herdrCli(["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus"]);
	const code = herdrErrorCode(resp);
	if (code) throw new Error(`herdr tab create failed: ${code}`);
	const paneId = resp?.result?.root_pane?.pane_id;
	const tabId = resp?.result?.tab?.tab_id;
	if (typeof paneId !== "string" || !paneId || typeof tabId !== "string" || !tabId) {
		throw new Error("herdr tab create returned no pane/tab id");
	}
	return { paneId, tabId };
}

async function getAgentStatus(paneId: string): Promise<{ status: HerdrStatus | "no-agent" | "gone" }> {
	try {
		const resp = await herdrCli(["agent", "get", paneId]);
		const code = herdrErrorCode(resp);
		if (code === "agent_not_found") return { status: "no-agent" };
		if (code === "pane_not_found") return { status: "gone" };
		const s = resp?.result?.agent?.agent_status;
		if (s === "working" || s === "idle" || s === "blocked" || s === "done" || s === "unknown") return { status: s };
		return { status: "unknown" };
	} catch {
		return { status: "unknown" };
	}
}

async function closeTab(tabId: string): Promise<void> {
	try {
		await herdrCli(["tab", "close", tabId]);
	} catch {}
}

function shellQuote(s: string): string {
	return `'${s.replaceAll("'", "'\\''")}'`;
}

function buildLaunchCommand(
	agent: AgentConfig,
	label: string,
	sessionPath: string,
	taskFilePath: string,
	systemPromptPath: string | null,
): string {
	const parts: string[] = ["PI_SUBAGENT_NESTED=1", "pi"];
	parts.push("--name", shellQuote(label));
	parts.push("--session", shellQuote(sessionPath));
	if (agent.model) parts.push("--model", shellQuote(agent.model));
	if (agent.tools && agent.tools.length > 0) parts.push("--tools", shellQuote(agent.tools.join(",")));
	if (systemPromptPath) parts.push("--append-system-prompt", shellQuote(systemPromptPath));
	parts.push(`"$(cat ${shellQuote(taskFilePath)})"`);
	return parts.join(" ");
}

async function launchInPane(paneId: string, command: string): Promise<string | null> {
	await sleep(500);
	let textSent = false;
	let keySent = false;
	let launchError = "";
	for (let attempt = 0; attempt < 3 && !keySent; attempt++) {
		try {
			if (!textSent) {
				const resp = await herdrCli(["pane", "send-text", paneId, command]);
				const code = herdrErrorCode(resp);
				if (code) {
					launchError = herdrErrorText(resp) || code;
				} else {
					textSent = true;
					launchError = "";
				}
			}
			if (textSent) {
				const keyResp = await herdrCli(["pane", "send-keys", paneId, "enter"]);
				const keyCode = herdrErrorCode(keyResp);
				if (keyCode) {
					launchError = `submit failed: ${herdrErrorText(keyResp) || keyCode}`;
				} else {
					keySent = true;
				}
			}
		} catch (err) {
			launchError = (err as Error).message;
		}
		if (!keySent && attempt < 2) await sleep(1000);
	}
	return keySent ? null : launchError;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown" | "reuse";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	herdrStatus?: HerdrStatus;
	paneId?: string;
	tabId?: string;
	label?: string;
	steered?: boolean;
	blockReason?: BlockReason;
	blockedSince?: number;
	blockedPreview?: string;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function formatClockTime(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatBlockedPreview(name: string, args: Record<string, any>): string {
	const argPath =
		typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
	let preview = argPath ? `${name} ${argPath}` : name;
	if (typeof args.command === "string") {
		const cmd = args.command.replace(/\s+/g, " ").trim();
		preview = name === "bash" ? `bash ${cmd}` : `${name} ${cmd}`;
	}
	return preview.length > 90 ? `${preview.slice(0, 87)}...` : preview;
}

function findPendingToolCall(
	messages: Message[],
	pendingToolCalls: Map<string, { name: string; args: Record<string, any> }>,
): { name: string; args: Record<string, any> } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "toolCall" && pendingToolCalls.has(part.id)) {
				return { name: part.name, args: part.arguments };
			}
		}
	}
	return undefined;
}

function blockedSummaryLine(r: SingleResult): string {
	const reason =
		r.blockReason === "approval"
			? `awaiting approval${r.blockedPreview ? `: ${r.blockedPreview}` : ""}`
			: "needs input";
	const since = r.blockedSince ? `, since ${formatClockTime(r.blockedSince)}` : "";
	const tab = r.label ? `tab ${r.paneId?.split(":")[0] ?? ""}:${r.label}` : "its tab";
	const action = r.blockReason === "approval" ? "approve/reject" : "steer";
	return `blocked - ${reason}${since} (${action} in ${tab})`;
}

function statusTag(r: SingleResult): string {
	if (r.herdrStatus === "blocked") {
		return r.blockReason === "approval"
			? r.blockedPreview
				? `blocked - awaiting approval: ${r.blockedPreview}`
				: "blocked - awaiting approval"
			: "blocked - needs input";
	}
	if (r.herdrStatus === "idle" || r.herdrStatus === "done") return "settling";
	if (r.herdrStatus === "working") return "working";
	return "starting";
}

function registryBlockedInfo(e: RegistryEntry): string | null {
	if (e.status !== "running" || !e.blockedSince) return null;
	const since = formatClockTime(e.blockedSince);
	const reason =
		e.blockReason === "approval"
			? `awaiting approval${e.blockedPreview ? `: ${e.blockedPreview}` : ""}`
			: "needs input";
	return `blocked since ${since} (${reason})`;
}

function completionPatch(currentResult: SingleResult): Partial<RegistryEntry> {
	const patch: Partial<RegistryEntry> = {
		status: "done",
		lastResult: getResultOutput(currentResult),
		updatedAt: Date.now(),
		blockedSince: undefined,
		blockReason: undefined,
		blockedPreview: undefined,
	};
	if (currentResult.usage.contextTokens > 0) {
		patch.contextTokens = currentResult.usage.contextTokens;
	}
	return patch;
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

const ABORT_ERROR = new Error("Subagent was aborted");

function makeEmptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

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

async function pollSubagent(
	paneId: string,
	sessionFile: string,
	initialOffset: number,
	signal: AbortSignal | undefined,
	currentResult: SingleResult,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	onBlocked?: (info: { label: string; blockReason: BlockReason; preview?: string }) => void,
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
	let lastEntryAt = Date.now();
	let lastKnownAt = Date.now();
	let settledCandidateAt: number | null = null;
	let offset = initialOffset;
	let fd: number | null = null;
	let lastEmitKey = "";
	let userMessages = 0;
	let lastMessageRole: string | undefined;
	let abortedAt: number | null = null;
	let steerPendingSince: number | null = null;
	let prevReason: BlockReason | undefined;
	const pendingToolCalls = new Map<string, { name: string; args: Record<string, any> }>();

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
			const msg = entry.message as Message;
			currentResult.messages.push(msg);
			if (msg.role === "assistant") {
				for (const part of msg.content) {
					if (part.type === "toolCall" && typeof part.id === "string") {
						pendingToolCalls.set(part.id, { name: part.name, args: part.arguments });
					}
				}
			} else if (msg.role === "toolResult") {
				pendingToolCalls.delete(msg.toolCallId);
			}
			lastEntryAt = Date.now();
			if (msg.role === "user") {
				userMessages++;
				lastMessageRole = "user";
				if (steerPendingSince === null) steerPendingSince = Date.now();
			}
			if (msg.role === "assistant") {
				lastMessageRole = "assistant";
				steerPendingSince = null;
				if (msg.stopReason === "aborted") abortedAt = Date.now();
				else abortedAt = null;
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
		}
	};

	try {
		while (true) {
			if (wasAborted) return "aborted";
			const prevStatus = currentResult.herdrStatus;
			const { status } = await getAgentStatus(paneId);
			if (status === "working" || status === "idle" || status === "blocked" || status === "done") {
				currentResult.herdrStatus = status;
			}
			readSessionTail();
			currentResult.steered = userMessages > 1;
			if (currentResult.herdrStatus === "blocked") {
				const pending = findPendingToolCall(currentResult.messages, pendingToolCalls);
				const blockReason: BlockReason = pending ? "approval" : "steer";
				const preview = pending ? formatBlockedPreview(pending.name, pending.args) : undefined;
				const firstBlock = prevStatus !== "blocked";
				const reasonChanged = !firstBlock && prevReason !== blockReason;
				currentResult.blockReason = blockReason;
				currentResult.blockedPreview = preview;
				if (firstBlock) currentResult.blockedSince = Date.now();
				if (firstBlock || reasonChanged) {
					const label = currentResult.label;
					if (label) {
						updateRegistryEntry(label, {
							status: "running",
							blockedSince: currentResult.blockedSince,
							blockReason,
							blockedPreview: preview,
							updatedAt: Date.now(),
						});
					}
					if (blockReason === "approval" && prevReason !== "approval") {
						onBlocked?.({ label: currentResult.label ?? "?", blockReason, preview });
					}
				}
				prevReason = blockReason;
			} else if (prevStatus === "blocked") {
				currentResult.blockReason = undefined;
				currentResult.blockedSince = undefined;
				currentResult.blockedPreview = undefined;
				prevReason = undefined;
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
				if (prevStatus !== "idle" && prevStatus !== "done") {
					settledCandidateAt = Date.now();
				}
				if (sawWorking || currentResult.messages.some((m) => m.role === "assistant")) {
					const hasPendingSteer =
						lastMessageRole === "user" &&
						steerPendingSince !== null &&
						Date.now() - steerPendingSince < STEER_TIMEOUT_MS;
					const inAbortGrace = abortedAt !== null && Date.now() - abortedAt < ABORT_GRACE_MS;
					if (hasPendingSteer || inAbortGrace) {
						settledCandidateAt = null;
					} else if (
						Date.now() - (settledCandidateAt ?? 0) >= SETTLE_STABILITY_MS &&
						Date.now() - lastEntryAt >= SETTLE_STABILITY_MS
					) {
						return "settled";
					}
				} else {
					settledCandidateAt = null;
				}
			} else if (Date.now() - lastKnownAt > STATUS_LOSS_TIMEOUT_MS) {
				currentResult.stderr = "herdr agent status was lost";
				return "failed";
			}
			if (Date.now() - startedAt > STARTUP_TIMEOUT_MS && !sawWorking && currentResult.messages.length === 0) {
				currentResult.stderr = "subagent did not start";
				return "failed";
			}
			await sleep(POLL_INTERVAL_MS);
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

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	parentSession: string | undefined,
	onBlocked?: (info: { label: string; blockReason: BlockReason; preview?: string }) => void,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: makeEmptyUsage(),
			step,
		};
	}

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: makeEmptyUsage(),
		model: agent.model,
		step,
	};

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let tmpTaskDir: string | null = null;
	let tmpTaskPath: string | null = null;
	let tabId: string | null = null;
	let label = "";

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
		}
		const taskTmp = await writePromptToTempFile(agent.name, `Task: ${task}`);
		tmpTaskDir = taskTmp.dir;
		tmpTaskPath = taskTmp.filePath;

		const alloc = allocateLabel(agent.name);
		label = alloc.label;
		currentResult.label = label;
		const sessionPath = alloc.sessionFile;

		const workspaceId = await resolveOwnWorkspace();
		if (!workspaceId) {
			currentResult.exitCode = 1;
			currentResult.stderr = `Could not resolve the herdr workspace for pane ${HERDR_PANE_ID ?? "(none)"}.`;
			return currentResult;
		}

		const created = await createTaskTab(workspaceId, cwd ?? defaultCwd, label);
		tabId = created.tabId;
		currentResult.paneId = created.paneId;
		currentResult.tabId = created.tabId;
		registerEntry({
			label,
			agent: agent.name,
			workspace: ownWorkspaceId(),
			paneId: created.paneId,
			tabId: created.tabId,
			sessionFile: sessionPath,
			cwd: cwd ?? defaultCwd,
			status: "running",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastResult: "",
			contextTokens: 0,
			parentSession,
		});

		const command = buildLaunchCommand(agent, label, sessionPath, tmpTaskPath, tmpPromptPath);
		const launchError = await launchInPane(created.paneId, command);
		if (launchError) {
			currentResult.exitCode = 1;
			currentResult.stderr = `Could not launch subagent in pane ${created.paneId} (${launchError}).`;
			await closeTab(tabId);
			removeRegistryEntry(label);
			return currentResult;
		}

		const outcome = await pollSubagent(
			created.paneId,
			sessionPath,
			0,
			signal,
			currentResult,
			onUpdate,
			makeDetails,
			onBlocked,
		);

		if (outcome === "aborted") {
			await closeTab(tabId);
			removeRegistryEntry(label);
			throw ABORT_ERROR;
		}
		if (outcome === "gone") {
			currentResult.exitCode = 1;
			currentResult.stderr = `Subagent pane ${created.paneId} was closed before the task completed.`;
			removeRegistryEntry(label);
			return currentResult;
		}
		if (outcome === "failed") {
			currentResult.exitCode = 1;
			await closeTab(tabId);
			removeRegistryEntry(label);
			return currentResult;
		}

		updateRegistryEntry(label, completionPatch(currentResult));
		return currentResult;
	} catch (err) {
		if (err === ABORT_ERROR) throw err;
		currentResult.exitCode = 1;
		currentResult.stderr = (err as Error).message || String(err);
		if (tabId) await closeTab(tabId);
		if (label) removeRegistryEntry(label);
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {}
		if (tmpTaskPath)
			try {
				fs.unlinkSync(tmpTaskPath);
			} catch {}
		if (tmpTaskDir)
			try {
				fs.rmdirSync(tmpTaskDir);
			} catch {}
	}
}

async function runReusedAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	label: string,
	task: string,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	onBlocked?: (info: { label: string; blockReason: BlockReason; preview?: string }) => void,
): Promise<SingleResult> {
	const reg = readRegistry();
	const entry = reg.tabs[`${ownWorkspaceId()}:${label}`];

	if (!entry) {
		return {
			agent: label,
			agentSource: "reuse",
			task,
			exitCode: 1,
			messages: [],
			stderr: `No subagent session labeled "${label}". Use listSubagents to see available sessions.`,
			usage: makeEmptyUsage(),
		};
	}
	const agent = agents.find((a) => a.name === entry.agent);
	const currentResult: SingleResult = {
		agent: entry.agent,
		agentSource: "reuse",
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: makeEmptyUsage(),
		model: agent?.model,
		label,
		paneId: entry.paneId,
		tabId: entry.tabId,
	};

	try {
		updateRegistryEntry(label, { status: "running", updatedAt: Date.now() });

		let paneId = entry.paneId;
		let tabId = entry.tabId;
		const paneResp = await herdrCli(["pane", "get", paneId]);
		if (herdrErrorCode(paneResp) === "pane_not_found") {
			const workspaceId = await resolveOwnWorkspace();
			if (!workspaceId) {
				currentResult.exitCode = 1;
				currentResult.stderr = `Could not resolve the herdr workspace for pane ${HERDR_PANE_ID ?? "(none)"}.`;
				return currentResult;
			}
			const created = await createTaskTab(workspaceId, entry.cwd || defaultCwd, label);
			paneId = created.paneId;
			tabId = created.tabId;
			currentResult.paneId = paneId;
			currentResult.tabId = tabId;
			updateRegistryEntry(label, { paneId, tabId, updatedAt: Date.now() });
		}

		const { status } = await getAgentStatus(paneId);
		if (status === "no-agent") {
			let relaunchError: string | null = "no agent";
			if (agent) {
				const taskTmp = await writePromptToTempFile(entry.agent, `Task: ${task}`);
				const command = buildLaunchCommand(agent, label, entry.sessionFile, taskTmp.filePath, null);
				relaunchError = await launchInPane(paneId, command);
				try {
					fs.unlinkSync(taskTmp.filePath);
				} catch {}
				try {
					fs.rmdirSync(taskTmp.dir);
				} catch {}
			}
			if (relaunchError) {
				currentResult.exitCode = 1;
				currentResult.stderr = `Could not relaunch subagent ${label} in pane ${paneId} (${relaunchError}).`;
				return currentResult;
			}
		} else {
			let submitted = false;
			let promptError = "";
			for (let attempt = 0; attempt < 3 && !submitted; attempt++) {
				try {
					const resp = await herdrCli(["agent", "prompt", paneId, task]);
					const code = herdrErrorCode(resp);
					if (code) {
						promptError = herdrErrorText(resp) || code;
					} else {
						submitted = true;
					}
				} catch (err) {
					promptError = (err as Error).message;
				}
				if (!submitted && attempt < 2) await sleep(1000);
			}
			if (!submitted) {
				currentResult.exitCode = 1;
				currentResult.stderr = `Could not prompt subagent ${label} in pane ${paneId} (${promptError}).`;
				return currentResult;
			}
		}

		let initialOffset = 0;
		try {
			initialOffset = fs.statSync(entry.sessionFile).size;
		} catch {}

		const outcome = await pollSubagent(paneId, entry.sessionFile, initialOffset, signal, currentResult, onUpdate, makeDetails, onBlocked);

		if (outcome === "aborted") {
			throw ABORT_ERROR;
		}
		if (outcome === "gone") {
			currentResult.exitCode = 1;
			currentResult.stderr = `Subagent pane ${paneId} was closed before the task completed.`;
			return currentResult;
		}
		if (outcome === "failed") {
			currentResult.exitCode = 1;
			return currentResult;
		}

		updateRegistryEntry(label, completionPatch(currentResult));
		return currentResult;
	} catch (err) {
		if (err === ABORT_ERROR) throw err;
		currentResult.exitCode = 1;
		currentResult.stderr = (err as Error).message || String(err);
		return currentResult;
	}
}

function listSubagents(filter: { label?: string; status?: string; verbose?: boolean }): string {
	const reg = readRegistry();
	const matchLabel = (e: RegistryEntry) => {
		if (!filter.label) return true;
		const qualified = `${e.workspace}:${e.label}`;
		return qualified === filter.label || e.label === filter.label;
	};
	const entries = Object.values(reg.tabs)
		.filter((e) => matchLabel(e) && (!filter.status || e.status === filter.status))
		.sort((a, b) => a.label.localeCompare(b.label));
	if (entries.length === 0) {
		const why = filter.label || filter.status ? " (no matches for the given filters)" : "";
		return `No subagent sessions yet${why}.`;
	}
	const lines = entries.map((e) => {
		const previewLen = filter.verbose ? 4000 : 80;
		const last = e.lastResult ? e.lastResult.replace(/\s+/g, " ").trim().slice(0, previewLen) : "-";
		const ctx = e.contextTokens && e.contextTokens > 0 ? `ctx:${formatTokens(e.contextTokens)}` : null;
		const blocked = registryBlockedInfo(e);
		return `${e.workspace}:${e.label}  ${e.status.padEnd(8)}${blocked ? `  ${blocked}` : ""}${ctx ? `  ${ctx}` : ""}  pane ${e.paneId || "-"}  ${e.sessionFile}\n    last: ${last}`;
	});
	return `Subagent sessions (registry: ${REGISTRY_PATH}):\n\n${lines.join("\n")}`;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode, or the message to send when reusing a session)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	listSubagents: Type.Optional(Type.Boolean({ description: "List existing subagent sessions (labels, status, panes, session files)" })),
	listLabel: Type.Optional(Type.String({ description: "With listSubagents: only show the session with this label (bare or workspace-qualified, e.g. worker-1 or w8:worker-1)" })),
	listStatus: Type.Optional(Type.String({ description: "With listSubagents: only show sessions with this status (running or done)" })),
	listVerbose: Type.Optional(Type.Boolean({ description: "With listSubagents: show the full last result instead of an 80-char preview" })),
	reuseLabel: Type.Optional(Type.String({ description: "Continue an existing subagent session in place (preserving its context); send `task` as the next message" })),
});

export default function (pi: ExtensionAPI) {
	if (!HERDR_ENV || !HERDR_SOCKET_PATH || !HERDR_PANE_ID) return;
	if (!NESTED) {
		reconcileRegistry().catch(() => {});
		pi.on("session_start", () => {
			reconcileRegistry().catch(() => {});
		});
	}

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Each subagent runs as a live pi session in its own herdr tab, labeled <agent>-<n> (e.g. worker-1, reviewer-2); the numbering is persistent.",
			"Tabs stay open after finishing until closed manually; sessions can be reused (preserving context).",
			`Registry of all subagent sessions: ${REGISTRY_PATH} (read it to find reusable sessions and their session files).`,
			`Registry entries include ctx:<tokens> - the context size at the last completed turn; use it to decide between reuseLabel and a fresh session.`,
			"Labels are scoped per herdr workspace: each workspace has its own worker-1, worker-2, ... numbering and session files.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"A session becomes read-only once its result is delivered to the main agent; reuseLabel + task makes it interactive again for a new task.",
			"Steers typed into a running subagent's tab are folded into its final outcome and marked [steered] in the result.",
			"listSubagents: true lists all sessions; listLabel/listStatus/listVerbose filter the listing (single entry, status, full last result).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const hasList = params.listSubagents === true;
			const hasReuse = typeof params.reuseLabel === "string";
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle) + Number(hasList) + Number(hasReuse);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			const onBlocked: ((info: { label: string; blockReason: BlockReason; preview?: string }) => void) | undefined =
				ctx.hasUI
					? (info) => {
							ctx.ui.notify(
								`Subagent ${ownWorkspaceId()}:${info.label} is awaiting approval${info.preview ? `: ${info.preview}` : ""} (approve/reject in its tab)`,
								"warning",
							);
						}
					: undefined;

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode (single, parallel, chain, reuse, or list).\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (NESTED) {
				const mode = hasChain ? "chain" : hasTasks ? "parallel" : hasReuse ? "reuse" : hasList ? "list" : "single";
				return {
					content: [
						{
							type: "text",
							text: "Nested subagents are disabled: this session is itself a subagent (PI_SUBAGENT_NESTED is set), so it cannot spawn its own subagents.",
						},
					],
					details: makeDetails(mode as "single")([]),
				};
			}

			if (hasList) {
				return {
					content: [{ type: "text", text: listSubagents({ label: params.listLabel, status: params.listStatus, verbose: params.listVerbose }) }],
					details: makeDetails("single")([]),
				};
			}

			if (hasReuse) {
				if (!params.task) {
					return {
						content: [{ type: "text", text: "Invalid parameters. reuseLabel requires a task (the next message for that session)." }],
						details: makeDetails("single")([]),
					};
				}
				const result = await runReusedAgent(
					ctx.cwd,
					agents,
					params.reuseLabel!,
					params.task,
					signal,
					onUpdate,
					makeDetails("single"),
					onBlocked,
				);
				const isError = isFailedResult(result);
				if (isError) {
					return {
						content: [{ type: "text", text: `Reuse ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						sessionFile,
						onBlocked,
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};
				}

				const allResults: SingleResult[] = new Array(params.tasks.length);

				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: makeEmptyUsage(),
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						sessionFile,
						onBlocked,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.label ?? r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					sessionFile,
					onBlocked,
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.reuseLabel) {
				const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("accent", `reuse ${args.reuseLabel}`) +
						theme.fg("muted", ` [${scope}]`) +
						`\n  ${theme.fg("dim", preview)}`,
					0,
					0,
				);
			}
			if (args.listSubagents) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", "list") + theme.fg("muted", ` [${scope}]`),
					0,
					0,
				);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);
				const displayName = r.label ?? r.agent;

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(displayName))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (r.steered) header += ` ${theme.fg("warning", "[steered]")}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					if (r.herdrStatus === "blocked")
						container.addChild(new Text(theme.fg("warning", blockedSummaryLine(r)), 0, 0));
					if (r.paneId) container.addChild(new Text(theme.fg("muted", `pane ${r.paneId}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(displayName))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (r.steered) text += ` ${theme.fg("warning", "[steered]")}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (r.herdrStatus === "blocked") text += `\n${theme.fg("warning", blockedSummaryLine(r))}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				if (r.paneId) text += `\n${theme.fg("muted", `pane ${r.paneId}`)}`;
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const hasBlocked = details.results.some((r) => r.herdrStatus === "blocked");
				const hasFailed = details.results.some((r) => r.exitCode !== 0 && r.herdrStatus !== "blocked");
				const icon =
					hasBlocked && !hasFailed
						? theme.fg("warning", "⏸")
						: successCount === details.results.length
							? theme.fg("success", "✓")
							: theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon =
							r.herdrStatus === "blocked"
								? theme.fg("warning", "⏸")
								: r.exitCode === 0
									? theme.fg("success", "✓")
									: theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						const displayName = r.label ?? r.agent;

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", displayName)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (r.herdrStatus === "blocked")
							container.addChild(new Text(theme.fg("warning", blockedSummaryLine(r)), 0, 0));

						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon =
						r.herdrStatus === "blocked"
							? theme.fg("warning", "⏸")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					const displayName = r.label ?? r.agent;
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", displayName)} ${rIcon}`;
					if (r.herdrStatus === "blocked") text += `\n${theme.fg("warning", blockedSummaryLine(r))}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						const displayName = r.label ?? r.agent;

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── ") + theme.fg("accent", displayName)}${r.steered ? ` ${theme.fg("warning", "[steered]")}` : ""} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? r.herdrStatus === "blocked"
								? theme.fg("warning", "⚠")
								: theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					const displayName = r.label ?? r.agent;
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", displayName)}${r.steered ? ` ${theme.fg("warning", "[steered]")}` : ""} ${rIcon}`;
					if (r.herdrStatus === "blocked") {
						text += `\n${theme.fg("warning", blockedSummaryLine(r))}`;
					} else if (displayItems.length === 0) {
						if (r.exitCode === -1) {
							text += `\n${theme.fg(
								"muted",
								r.herdrStatus === "idle" || r.herdrStatus === "done" ? "(settling...)" : "(running...)",
							)}`;
						} else {
							text += `\n${theme.fg("muted", "(no output)")}`;
						}
					} else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	if (!NESTED) {
		pi.registerTool({
			name: "subagent_close",
			label: "Close Subagents",
			description: [
				"Close subagents linked to the current session: closes their herdr tabs and removes them from the registry (session files are preserved).",
				"May only be used when the user explicitly asks to close subagents - never autonomously.",
				"Without a label, closes all subagents linked to this session.",
				"With a label, closes only that session-linked subagent (e.g. to retire a broken session the user wants stopped).",
			].join(" "),
			parameters: Type.Object({
				label: Type.Optional(
					Type.String({ description: "Label of a session-linked subagent to close (e.g. worker-1). Omit to close all session-linked subagents." }),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
				const entries = sessionLinkedEntries(sessionFile);
				if (params.label) {
					const target = entries.find((e) => e.label === params.label);
					if (!target) {
						return {
							content: [
								{
									type: "text",
									text: `No session-linked subagent labeled "${params.label}". Session-linked subagents: ${entries.map((e) => e.label).join(", ") || "(none)"}`,
								},
							],
							details: {},
						};
					}
					return closeSubagentFlow([target], ctx);
				}
				return closeSubagentFlow(entries, ctx);
			},
		});

		pi.registerCommand("setup-subagents", {
			description:
				"Create or update the planner, reviewer, scout, and worker agent files in ~/.pi/agent/agents with a chosen model (provider/model(:thinking_level), e.g. github-copilot/gpt-5.6-luna:high)",
			handler: async (_args, ctx) => {
				if (!ctx.hasUI) {
					ctx.ui.notify("/setup-subagents needs an interactive session", "warning");
					return;
				}
				let model: string | undefined;
				for (let attempt = 0; attempt < 3; attempt++) {
					model = await ctx.ui.input(
						"Model for the four subagents (provider/model(:thinking_level), e.g. github-copilot/gpt-5.6-luna:high or cortecs/deepseek-v4-flash-0731)",
						"e.g. github-copilot/gpt-5.6-luna:high or cortecs/deepseek-v4-flash-0731",
					);
					if (model === undefined) {
						ctx.ui.notify("/setup-subagents canceled", "info");
						return;
					}
					model = model.trim();
					if (model && isValidModelSpec(model)) {
						model = normalizeModelSpec(model);
						break;
					}
					if (attempt < 2) {
						ctx.ui.notify(
							`Invalid model "${model}". Use provider/model(:thinking_level) with level off, minimal, low, medium, high, xhigh, or max - e.g. github-copilot/gpt-5.6-luna:high`,
							"warning",
						);
					}
				}
				if (!model || !isValidModelSpec(model)) {
					ctx.ui.notify("/setup-subagents aborted: invalid model spec", "error");
					return;
				}
				const agentsDir = path.join(getAgentDir(), "agents");
				const existing = AGENT_TEMPLATES.filter((t) => fs.existsSync(path.join(agentsDir, t.filename)));
				if (existing.length > 0) {
					const ok = await ctx.ui.confirm(
						"Overwrite existing agent files?",
						`These files already exist and would be overwritten:\n${existing.map((t) => `- ${t.filename}`).join("\n")}\n\nContinue with model: ${model}`,
					);
					if (!ok) {
						ctx.ui.notify("/setup-subagents canceled - no files changed", "info");
						return;
					}
				}
				fs.mkdirSync(agentsDir, { recursive: true });
				let created = 0;
				let updated = 0;
				for (const t of AGENT_TEMPLATES) {
					const file = path.join(agentsDir, t.filename);
					const existed = fs.existsSync(file);
					fs.writeFileSync(file, renderAgentFile(t, model));
					if (existed) updated++;
					else created++;
				}
				ctx.ui.notify(`Subagents ready - ${created} created, ${updated} updated with model ${model}`, "info");
			},
		});

		pi.registerCommand("kill-session-subagents", {
			description: "Close all subagents linked to this session: closes their herdr tabs and removes them from the registry (session files preserved)",
			handler: async (_args, ctx) => {
				const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
				const entries = sessionLinkedEntries(sessionFile);
				const result = await closeSubagentFlow(entries, ctx);
				const first = result.content[0];
				if (first && first.type === "text") {
					ctx.ui.notify(first.text, "info");
				}
			},
		});
	}

	pi.on("input", async (event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		const reg = readRegistry();
		for (const entry of Object.values(reg.tabs)) {
			if (entry.sessionFile !== sessionFile || entry.status === "running") continue;
			const { status } = await getAgentStatus(entry.paneId);
			if (status === "working" || status === "blocked") {
				return { action: "continue" };
			}
			ctx.ui.notify(
				`Subagent session ${entry.label} is read-only (its result was delivered). Reuse it via the subagent tool to make it interactive again.`,
				"warning",
			);
			return { action: "handled" };
		}
		return { action: "continue" };
	});
}
