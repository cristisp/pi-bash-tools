import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { formatTokens, registryBlockedInfo } from './format.ts';
import {
	closeTab,
	getAgentStatus,
	herdrCli,
	herdrErrorCode,
	ownWorkspaceId,
	sleep,
} from './herdr.ts';
import { mutateRegistry, readRegistry, REGISTRY_PATH, sanitizeSegment } from './registry-store.ts';
import type { RegistryEntry } from './types.ts';

function sanitizeName(name: string): string {
	return name.replace(/[^\w.-]+/g, '_');
}

function displayWorkspace(workspace: string, workspaceName?: string): string {
	const name = workspaceName?.trim();
	return name ? `${name} (${workspace})` : workspace;
}

function sessionFileFor(ws: string, label: string): string {
	const dir = path.join(getAgentDir(), 'sessions');
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {}
	return path.join(dir, `subagent-${sanitizeSegment(ws)}-${sanitizeSegment(label)}.jsonl`);
}

export function allocateLabel(agent: string): { label: string; sessionFile: string } {
	const ws = ownWorkspaceId();
	let label = '';
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

export function registerEntry(entry: RegistryEntry): void {
	mutateRegistry((reg) => {
		reg.tabs[`${entry.workspace}:${entry.label}`] = entry;
	});
}

export function updateRegistryEntry(label: string, patch: Partial<RegistryEntry>): void {
	mutateRegistry((reg) => {
		const entry = reg.tabs[`${ownWorkspaceId()}:${label}`];
		if (!entry) return;
		Object.assign(entry, patch);
	});
}

export function removeRegistryEntry(label: string): void {
	mutateRegistry((reg) => {
		delete reg.tabs[`${ownWorkspaceId()}:${label}`];
	});
}

export function findEntry(label: string, parentSession?: string): RegistryEntry | undefined {
	const entry = readRegistry().tabs[`${ownWorkspaceId()}:${label}`];
	if (!entry || (parentSession !== undefined && entry.parentSession !== parentSession))
		return undefined;
	return entry;
}

export function sessionLinkedEntries(sessionFile: string | undefined): RegistryEntry[] {
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
	return closed.join(', ');
}

export async function closeSubagentFlow(
	entries: RegistryEntry[],
	ctx: Pick<ExtensionContext, 'hasUI' | 'ui'>,
): Promise<AgentToolResult<unknown>> {
	if (entries.length === 0) {
		return {
			content: [{ type: 'text', text: 'No subagents are linked to this session.' }],
			details: {},
		};
	}
	const running = entries.filter((e) => e.status === 'running');
	const summary = entries
		.map((e) => {
			let line = `${e.workspace}:${e.label}  ${e.status}`;
			if (e.status === 'running') {
				const blocked = registryBlockedInfo(e);
				line += blocked ? ` (${blocked})` : ' (still running)';
			}
			return line;
		})
		.join('\n');
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm(
			'Close subagents?',
			`The following subagents will be closed (tab closed, removed from registry, session files preserved):\n\n${summary}${running.length > 0 ? `\n\n⚠ ${running.length} still running - closing them kills in-flight work` : ''}`,
		);
		if (!ok) {
			return {
				content: [{ type: 'text', text: 'Canceled - no subagents were closed.' }],
				details: {},
			};
		}
	}
	const closed = await closeSubagentEntries(entries);
	return {
		content: [{ type: 'text', text: `Closed ${entries.length} subagent(s): ${closed}` }],
		details: {},
	};
}

export async function reconcileRegistry(): Promise<void> {
	let entries: RegistryEntry[];
	try {
		entries = Object.values(readRegistry().tabs);
	} catch {
		return;
	}
	for (const entry of entries) {
		let paneAlive = true;
		try {
			const resp = await herdrCli(['pane', 'get', entry.paneId]);
			paneAlive = herdrErrorCode(resp) !== 'pane_not_found';
		} catch {
			return;
		}
		if (!paneAlive) {
			mutateRegistry((reg) => {
				delete reg.tabs[`${entry.workspace}:${entry.label}`];
			});
			continue;
		}
		if (entry.status !== 'running') continue;
		const s1 = await getAgentStatus(entry.paneId);
		if (s1.status !== 'idle' && s1.status !== 'done' && s1.status !== 'no-agent') continue;
		await sleep(5000);
		const s2 = await getAgentStatus(entry.paneId);
		if (s2.status === 'idle' || s2.status === 'done' || s2.status === 'no-agent') {
			updateRegistryEntry(entry.label, { status: 'done', updatedAt: Date.now() });
		}
	}
}

export function listSubagents(filter: {
	label?: string;
	status?: string;
	verbose?: boolean;
	parentSession?: string;
}): string {
	const reg = readRegistry();
	const workspace = ownWorkspaceId();
	const matchLabel = (e: RegistryEntry) => {
		if (!filter.label) return true;
		const qualified = `${e.workspace}:${e.label}`;
		return qualified === filter.label || e.label === filter.label;
	};
	const entries = Object.values(reg.tabs)
		.filter(
			(e) =>
				(filter.parentSession === undefined || e.workspace === workspace) &&
				(filter.parentSession === undefined || e.parentSession === filter.parentSession) &&
				matchLabel(e) &&
				(!filter.status || e.status === filter.status),
		)
		.toSorted((a, b) => a.label.localeCompare(b.label));
	if (entries.length === 0) {
		const why = filter.label || filter.status ? ' (no matches for the given filters)' : '';
		return `No subagent sessions yet${why}.`;
	}
	const activeWorkspaceName = entries.find(
		(e) => e.workspace === workspace && e.workspaceName?.trim(),
	)?.workspaceName;
	const lines = entries.map((e) => {
		const previewLen = filter.verbose ? 4000 : 80;
		const last = e.lastResult ? e.lastResult.replace(/\s+/g, ' ').trim().slice(0, previewLen) : '-';
		const ctx =
			e.contextTokens && e.contextTokens > 0 ? `ctx:${formatTokens(e.contextTokens)}` : null;
		const reuse = e.reuseCount && e.reuseCount > 0 ? `reused:${e.reuseCount}` : null;
		const tasks = e.tasks && e.tasks.length > 0 ? `tasks:${e.tasks.length}` : null;
		const blocked = registryBlockedInfo(e);
		const meta = [blocked, ctx, reuse, tasks].filter(Boolean).join('  ');
		return `${displayWorkspace(e.workspace, e.workspaceName)}:${e.label}  reuseLabel: ${e.label}  ${e.status.padEnd(8)}${meta ? `  ${meta}` : ''}  pane ${e.paneId || '-'}  ${e.sessionFile}\n    last: ${last}`;
	});
	if (filter.parentSession === undefined) {
		return `Subagent sessions (registry: ${REGISTRY_PATH}):\n\n${lines.join('\n')}`;
	}
	return `Subagent sessions (active Pi session: ${filter.parentSession}, active workspace: ${displayWorkspace(workspace, activeWorkspaceName)}, registry: ${REGISTRY_PATH}):\n\n${lines.join('\n')}`;
}
