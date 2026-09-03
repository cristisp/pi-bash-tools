import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { getConfig } from './config.ts';
import { isOpaqueId } from './delegation.ts';
import { sanitizeSegment, withFileLock } from './registry-store.ts';
import type { FlowManifest, FlowParticipant } from './types.ts';

const MAX_PARTICIPANTS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const REPORTS_SUBDIR = 'reports';
export const PREDIGEST_SUBDIR = 'predigest';
const MANIFEST_NAME = 'flow.json';

export function flowsRoot(): string {
	return path.join(getAgentDir(), 'subagent-herdr', 'flows');
}

export function flowDirFor(flowId: string): string {
	return path.join(flowsRoot(), sanitizeSegment(flowId));
}

export function flowManifestPath(flowId: string): string {
	return path.join(flowDirFor(flowId), MANIFEST_NAME);
}

export function flowReportsDir(flowId: string): string {
	return path.join(flowDirFor(flowId), REPORTS_SUBDIR);
}

function readManifest(flowId: string): FlowManifest | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(flowManifestPath(flowId), 'utf-8'));
		if (parsed && typeof parsed === 'object' && typeof parsed.flowId === 'string')
			return parsed as FlowManifest;
	} catch {}
	return null;
}

function writeManifest(flowId: string, manifest: FlowManifest): void {
	const dir = flowDirFor(flowId);
	const target = flowManifestPath(flowId);
	const tmp = `${target}.tmp`;
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, target);
	} catch {
		try {
			fs.unlinkSync(tmp);
		} catch {}
	}
}

/**
 * Creates the flow directory (plus the reports namespace) and its manifest.
 * Every operation is best-effort: orchestration must keep working when the
 * store is unwritable.
 */
export function ensureFlow(options: {
	flowId: string | undefined;
	rootSession?: string;
}): FlowManifest | null {
	if (!isOpaqueId(options.flowId)) return null;
	const flowId = options.flowId;
	try {
		const dir = flowDirFor(flowId);
		fs.mkdirSync(flowReportsDir(flowId), { recursive: true });
		fs.mkdirSync(path.join(dir, PREDIGEST_SUBDIR), { recursive: true });
		return withFileLock(path.join(dir, '.lock'), () => {
			const existing = readManifest(flowId);
			if (existing) return existing;
			const now = Date.now();
			const manifest: FlowManifest = {
				v: 1,
				flowId,
				rootSession: options.rootSession ?? null,
				createdAt: now,
				lastUsedAt: now,
				participants: [],
			};
			writeManifest(flowId, manifest);
			return manifest;
		});
	} catch {
		return null;
	}
}

export function recordFlowParticipant(options: {
	flowId: string | undefined;
	label: string;
	agent: string;
}): void {
	if (!isOpaqueId(options.flowId)) return;
	const flowId = options.flowId;
	if (!fs.existsSync(flowManifestPath(flowId))) return;
	try {
		withFileLock(path.join(flowDirFor(flowId), '.lock'), () => {
			const manifest = readManifest(flowId);
			if (!manifest) return;
			const now = Date.now();
			const known = new Set(manifest.participants.map((p) => p.label));
			const participant: FlowParticipant = {
				label: options.label,
				agent: options.agent,
				firstSeenAt: now,
			};
			const participants = known.has(options.label)
				? manifest.participants
				: [...manifest.participants, participant];
			writeManifest(flowId, {
				...manifest,
				lastUsedAt: now,
				participants: participants.slice(-MAX_PARTICIPANTS),
			});
		});
	} catch {}
}

function manifestAge(manifestPath: string, now: number): number {
	try {
		const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
		const lastUsedAt = typeof parsed?.lastUsedAt === 'number' ? parsed.lastUsedAt : 0;
		return now - lastUsedAt;
	} catch {
		try {
			return now - fs.statSync(manifestPath).mtimeMs;
		} catch {
			return 0;
		}
	}
}

/** Removes flow directories that have been idle past the retention window. */
export function pruneFlows(retentionDays?: number): string[] {
	const days = retentionDays ?? getConfig().flowRetentionDays;
	const now = Date.now();
	const removed: string[] = [];
	let entries: string[];
	try {
		entries = fs.readdirSync(flowsRoot());
	} catch {
		return removed;
	}
	for (const entry of entries) {
		const dir = path.join(flowsRoot(), entry);
		const manifestPath = path.join(dir, MANIFEST_NAME);
		if (!fs.existsSync(manifestPath)) continue;
		if (manifestAge(manifestPath, now) < days * DAY_MS) continue;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			removed.push(entry);
		} catch {}
	}
	return removed;
}
