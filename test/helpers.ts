import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { vi } from 'vitest';
import type { Message, Usage } from '@earendil-works/pi-ai';
import type { RegistryEntry, SingleResult } from '../src/types.ts';
import { makeEmptyUsage } from '../src/types.ts';

export function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-herdr-test-'));
}

export function stubEnv(dir: string, paneId = 'ws1:p1'): void {
	vi.stubEnv('PI_CODING_AGENT_DIR', dir);
	vi.stubEnv('HERDR_PANE_ID', paneId);
	vi.stubEnv('HERDR_SESSION', paneId.split(':')[0]);
}

export function assistantMsg(
	text: string,
	opts: {
		stopReason?: string;
		usage?: Partial<Usage>;
		model?: string;
		errorMessage?: string;
		toolCalls?: { id: string; name: string; args: Record<string, any> }[];
	} = {},
): Message {
	return {
		role: 'assistant',
		content: [
			...(opts.toolCalls ?? []).map((tc) => ({
				type: 'toolCall' as const,
				id: tc.id,
				name: tc.name,
				arguments: tc.args,
			})),
			{ type: 'text' as const, text },
		],
		api: 'cli',
		provider: 'test',
		model: opts.model ?? 'test-model',
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			...opts.usage,
		},
		stopReason: (opts.stopReason ?? 'stop') as Message extends { stopReason: infer S } ? S : never,
		errorMessage: opts.errorMessage,
		timestamp: Date.now(),
	};
}

export function userMsg(text: string): Message {
	return { role: 'user', content: [{ type: 'text' as const, text }], timestamp: Date.now() };
}

export function toolResultMsg(toolCallId: string): Message {
	return {
		role: 'toolResult',
		toolCallId,
		toolName: 'bash',
		content: [{ type: 'text' as const, text: 'ok' }],
		isError: false,
		timestamp: Date.now(),
	};
}

export function makeSingleResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: 'worker',
		agentSource: 'user',
		task: 'do the thing',
		exitCode: 0,
		messages: [],
		stderr: '',
		usage: makeEmptyUsage(),
		...overrides,
	};
}

export function makeRegistryEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
	const now = Date.now();
	return {
		label: 'worker-1',
		agent: 'worker',
		workspace: 'ws1',
		paneId: 'ws1:p10',
		tabId: 'tab10',
		sessionFile: '/tmp/sessions/subagent-ws1-worker-1.jsonl',
		cwd: '/tmp',
		status: 'done',
		createdAt: now,
		updatedAt: now,
		lastResult: 'done',
		...overrides,
	};
}

export function writeAgentFile(
	dir: string,
	filename: string,
	body: string,
	frontmatter: Record<string, string>,
): string {
	const fm = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${v}`)
		.join('\n');
	const filePath = path.join(dir, filename);
	fs.writeFileSync(filePath, `---\n${fm}\n---\n\n${body}`);
	return filePath;
}

export function writeSessionFile(dir: string, filename: string, messages: Message[]): string {
	const filePath = path.join(dir, filename);
	const lines = messages.map((m) => JSON.stringify({ type: 'message', message: m }));
	fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
	return filePath;
}
