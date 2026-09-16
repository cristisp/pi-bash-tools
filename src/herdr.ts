import { execFile } from 'node:child_process';
import { getConfig } from './config.ts';
import type { HerdrStatus } from './types.ts';

export const HERDR_ENV = process.env.HERDR_ENV === '1';
export const HERDR_SOCKET_PATH = process.env.HERDR_SOCKET_PATH;
export const HERDR_PANE_ID = process.env.HERDR_PANE_ID;
export const HERDR_WORKSPACE_ID = process.env.HERDR_WORKSPACE_ID;
const HERDR_SESSION = process.env.HERDR_SESSION || '';
export const NESTED = process.env.PI_SUBAGENT_NESTED === '1';

export function ownWorkspaceId(): string {
	return HERDR_WORKSPACE_ID || (HERDR_PANE_ID ?? '').split(':')[0] || 'default';
}

let cachedWorkspaceId: string | null | undefined;
const workspaceNameCache = new Map<string, Promise<string | undefined>>();

function herdrSessionArgs(): string[] {
	return HERDR_SESSION ? ['--session', HERDR_SESSION] : [];
}

export function herdrCli(args: string[]): Promise<any> {
	return new Promise((resolve, reject) => {
		execFile(
			'herdr',
			[...args, ...herdrSessionArgs()],
			{ timeout: getConfig().herdrCliTimeoutMs, maxBuffer: 4 * 1024 * 1024 },
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

const HERDR_REPORT_METADATA_TIMEOUT_MS = 3000;

export function herdrCliReportMetadata(args: string[]): Promise<void> {
	return new Promise((resolve) => {
		try {
			execFile(
				'herdr',
				[...args],
				{ timeout: HERDR_REPORT_METADATA_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
				() => resolve(),
			);
		} catch {
			resolve();
		}
	});
}

export function herdrErrorCode(resp: any): string | undefined {
	return resp?.error?.code;
}

export function herdrErrorText(resp: any): string {
	const e = resp?.error;
	if (!e) return '';
	if (typeof e === 'string') return e;
	const parts: string[] = [];
	if (typeof e.code === 'string') parts.push(e.code);
	if (typeof e.message === 'string') parts.push(e.message);
	else if (typeof e.detail === 'string') parts.push(e.detail);
	return parts.join(': ');
}

export async function resolveOwnWorkspace(): Promise<string> {
	if (HERDR_WORKSPACE_ID) return HERDR_WORKSPACE_ID;
	if (cachedWorkspaceId !== undefined) return cachedWorkspaceId ?? '';
	if (!HERDR_PANE_ID) return '';
	try {
		const resp = await herdrCli(['pane', 'get', HERDR_PANE_ID]);
		const ws = resp?.result?.pane?.workspace_id;
		cachedWorkspaceId = typeof ws === 'string' && ws ? ws : null;
	} catch {
		cachedWorkspaceId = null;
	}
	return cachedWorkspaceId ?? '';
}

export function resolveWorkspaceName(workspaceId: string): Promise<string | undefined> {
	const cached = workspaceNameCache.get(workspaceId);
	if (cached) return cached;

	const lookup = Promise.resolve()
		.then(() => herdrCli(['workspace', 'get', workspaceId]))
		.then((resp) => {
			const label = resp?.result?.workspace?.label;
			return typeof label === 'string' && label.trim() ? label.trim() : undefined;
		})
		.catch(() => undefined);
	workspaceNameCache.set(workspaceId, lookup);
	return lookup;
}

export async function createTaskTab(
	workspaceId: string,
	cwd: string,
	label: string,
): Promise<{ paneId: string; tabId: string }> {
	const resp = await herdrCli([
		'tab',
		'create',
		'--workspace',
		workspaceId,
		'--cwd',
		cwd,
		'--label',
		label,
		'--no-focus',
	]);
	const code = herdrErrorCode(resp);
	if (code) throw new Error(`herdr tab create failed: ${code}`);
	const paneId = resp?.result?.root_pane?.pane_id;
	const tabId = resp?.result?.tab?.tab_id;
	if (typeof paneId !== 'string' || !paneId || typeof tabId !== 'string' || !tabId) {
		throw new Error('herdr tab create returned no pane/tab id');
	}
	return { paneId, tabId };
}

export async function getAgentStatus(
	paneId: string,
): Promise<{ status: HerdrStatus | 'no-agent' | 'gone' }> {
	try {
		const resp = await herdrCli(['agent', 'get', paneId]);
		const code = herdrErrorCode(resp);
		if (code === 'agent_not_found') return { status: 'no-agent' };
		if (code === 'pane_not_found') return { status: 'gone' };
		const s = resp?.result?.agent?.agent_status;
		if (s === 'working' || s === 'idle' || s === 'blocked' || s === 'done' || s === 'unknown')
			return { status: s };
		return { status: 'unknown' };
	} catch {
		return { status: 'unknown' };
	}
}

export async function closeTab(tabId: string): Promise<void> {
	try {
		await herdrCli(['tab', 'close', tabId]);
	} catch {}
}

// fallow-ignore-next-line complexity
export async function launchInPane(paneId: string, command: string): Promise<string | null> {
	await sleep(500);
	let textSent = false;
	let keySent = false;
	let launchError = '';
	for (let attempt = 0; attempt < 3 && !keySent; attempt++) {
		try {
			if (!textSent) {
				const resp = await herdrCli(['pane', 'send-text', paneId, command]);
				const code = herdrErrorCode(resp);
				if (code) {
					launchError = herdrErrorText(resp) || code;
				} else {
					textSent = true;
					launchError = '';
				}
			}
			if (textSent) {
				const keyResp = await herdrCli(['pane', 'send-keys', paneId, 'enter']);
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

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
