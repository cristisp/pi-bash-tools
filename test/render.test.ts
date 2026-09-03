import { Container, Text } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { renderSubagentCall, renderSubagentResult } from '../src/render.ts';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { registerEntry } from '../src/registry.ts';
import type { SingleResult, SubagentDetails } from '../src/types.ts';
import {
	assistantMsg,
	makeRegistryEntry,
	makeSingleResult,
	makeTempDir,
	stubEnv,
} from './helpers.ts';

function textOf(out: Text | Container): string {
	return (out as unknown as { text?: string }).text ?? '';
}

const theme = {
	fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
	bold: (t: string) => `*${t}*`,
	dim: (t: string) => `~${t}~`,
} as unknown as Theme;

function result(
	details: SubagentDetails,
	contentText = 'fallback',
): AgentToolResult<SubagentDetails> {
	return { content: [{ type: 'text', text: contentText }], details };
}

function singleDetails(results: SingleResult[]): SubagentDetails {
	return { mode: 'single', agentScope: 'user', projectAgentsDir: null, results };
}

function renderResult(details: SubagentDetails, expanded: boolean, contentText?: string) {
	return renderSubagentResult(result(details, contentText), expanded, theme);
}

describe('renderSubagentCall', () => {
	it('renders single mode with task preview', () => {
		const text = textOf(renderSubagentCall({ agent: 'worker', task: 'do the thing' }, theme));
		expect(text).toContain('*subagent *');
		expect(text).toContain('<accent>worker</accent>');
		expect(text).toContain('<muted> [user]</muted>');
		expect(text).toContain('<dim>do the thing</dim>');
	});
	it('renders orchestration identity on calls', () => {
		const text = textOf(
			renderSubagentCall(
				{
					agent: 'worker',
					task: 'do the thing',
					tier: 2,
					taskId: 'T-001',
					workflowMode: 'remediation',
					reviewMode: 'validation',
				},
				theme,
			),
		);
		expect(text).toContain('tier:2');
		expect(text).toContain('task:T-001');
		expect(text).toContain('mode:remediation');
		expect(text).toContain('review:validation');
	});
	it('truncates long tasks', () => {
		const long = 'x'.repeat(100);
		const text = textOf(renderSubagentCall({ agent: 'worker', task: long }, theme));
		expect(text).toContain('...');
	});
	it('renders chain mode with up to 3 steps', () => {
		const text = textOf(
			renderSubagentCall(
				{
					chain: [
						{ agent: 'a1', task: 'step 1 {previous}' },
						{ agent: 'a2', task: 'step 2' },
						{ agent: 'a3', task: 'step 3' },
						{ agent: 'a4', task: 'step 4' },
					],
				},
				theme,
			),
		);
		expect(text).toContain('chain (4 steps)');
		expect(text).toContain('<accent>a1</accent>');
		expect(text).toContain('... +1 more');
		expect(text).not.toContain('{previous}');
	});
	it('renders parallel mode', () => {
		const text = textOf(
			renderSubagentCall(
				{
					tasks: [
						{ agent: 'a1', task: 't1' },
						{ agent: 'a2', task: 't2' },
					],
				},
				theme,
			),
		);
		expect(text).toContain('parallel (2 tasks)');
		expect(text).toContain('<accent>a1</accent>');
	});
	it('renders reuse and list modes', () => {
		expect(textOf(renderSubagentCall({ reuseLabel: 'worker-1', task: 'next' }, theme))).toContain(
			'reuse worker-1',
		);
		expect(textOf(renderSubagentCall({ listSubagents: true }, theme))).toContain(
			'<accent>list</accent>',
		);
	});
	it('shows the reused session state when the registry has it', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		try {
			registerEntry(
				makeRegistryEntry({
					label: 'reviewer-2',
					agent: 'reviewer',
					status: 'done',
					contextTokens: 85000,
					reuseCount: 2,
					tasks: ['review auth', 'review api'],
				}),
			);
			const text = textOf(
				renderSubagentCall({ reuseLabel: 'reviewer-2', task: 're-review auth' }, theme),
			);
			expect(text).toContain('reuse reviewer-2');
			expect(text).toContain('ctx:85k');
			expect(text).toContain('reused 2x');
			expect(text).toContain('2 tasks so far');
		} finally {
			vi.unstubAllEnvs();
		}
	});
	it('warns when reusing a session with very large context', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		try {
			registerEntry(
				makeRegistryEntry({
					label: 'worker-9',
					contextTokens: 200000,
				}),
			);
			const text = textOf(renderSubagentCall({ reuseLabel: 'worker-9', task: 'next' }, theme));
			expect(text).toContain('<warning>ctx:200k</warning>');
		} finally {
			vi.unstubAllEnvs();
		}
	});
	it('renders agents listing mode', () => {
		const text = textOf(renderSubagentCall({ agents: true }, theme));
		expect(text).toContain('<accent>agents</accent>');
	});
	it('shows the agent scope', () => {
		const text = textOf(
			renderSubagentCall({ agent: 'scout', task: 'x', agentScope: 'project' }, theme),
		);
		expect(text).toContain('[project]');
	});
});

describe('renderSubagentResult - fallbacks', () => {
	it('falls back to content text without details', () => {
		const out = renderSubagentResult(
			{ content: [{ type: 'text', text: 'plain' }], details: undefined as never },
			false,
			theme,
		);
		expect(out).toBeInstanceOf(Text);
		expect(textOf(out)).toBe('plain');
	});
	it('falls back to content text for empty results', () => {
		const out = renderResult(singleDetails([]), false, 'empty-ish');
		expect(textOf(out)).toBe('empty-ish');
	});
	it('falls back to content for unknown modes', () => {
		const out = renderSubagentResult(
			{
				content: [{ type: 'text', text: 'mystery' }],
				details: {
					mode: 'mystery' as never,
					agentScope: 'user',
					projectAgentsDir: null,
					results: [makeSingleResult()],
				},
			},
			false,
			theme,
		);
		expect(textOf(out)).toBe('mystery');
	});
	it('falls back to no output for non-text content', () => {
		const out = renderSubagentResult(
			{ content: [{ type: 'image', url: 'x' }] as never, details: undefined as never },
			false,
			theme,
		);
		expect(textOf(out)).toBe('(no output)');
	});
});

describe('renderSubagentResult - single collapsed', () => {
	it('renders a successful single result collapsed', () => {
		const r = makeSingleResult({
			label: 'worker-1',
			paneId: 'ws1:p1',
			messages: [],
			usage: {
				...makeSingleResult().usage,
				turns: 1,
				input: 10,
				output: 20,
				cost: 0.001,
				contextTokens: 30,
			},
			metrics: {
				durationMs: 1500,
				toolCalls: 2,
				failedToolCalls: 0,
				repeatedReads: 0,
				messageCount: 3,
				taskChars: 10,
				outputChars: 20,
				maxContextTokens: 1000,
				turns: 1,
				blockEvents: 0,
				approvalMs: 0,
				steerMs: 0,
			},
		});
		const text = textOf(renderResult(singleDetails([r]), false));
		expect(text).toContain('<success>✓</success>');
		expect(text).toContain('*worker-1*');
		expect(text).toContain('pane ws1:p1');
		expect(text).toContain('(no output)');
		expect(text).toContain('1 turn ↑10 ↓20 $0.0010 ctx:30');
		expect(text).toContain('time:1.5s tools:2 msgs:3 io:10/20 max-ctx:1.0k');
	});
	it('renders explicit root and parent-pane attribution', () => {
		const text = textOf(
			renderResult(
				singleDetails([
					makeSingleResult({
						delegationId: 'delegation-1',
						rootSession: '/tmp/root.jsonl',
						parentPaneId: 'ws1:p0',
					}),
				]),
				false,
			),
		);
		expect(text).toContain('delegation-1');
		expect(text).toContain('parent pane ws1:p0');
		expect(text).toContain('root session /tmp/root.jsonl');
	});
	it('renders hunk and out-of-scope attribution', () => {
		const text = textOf(
			renderResult(
				singleDetails([
					makeSingleResult({
						scope: { hunks: ['src/run.ts@@1,4'], outOfScope: ['docs/'] },
					}),
				]),
				false,
			),
		);
		expect(text).toContain('hunks src/run.ts@@1,4');
		expect(text).toContain('out of scope docs/');
	});
	it('renders a failed single result with stop reason', () => {
		const r = makeSingleResult({
			label: 'solo-1',
			exitCode: 1,
			stopReason: 'error',
			errorMessage: 'boom',
		});
		const text = textOf(renderResult(singleDetails([r]), false));
		expect(text).toContain('<error>✗</error>');
		expect(text).toContain('<error>[error]</error>');
		expect(text).toContain('<error>boom</error>');
	});
	it('shows stderr for failures without an error message', () => {
		const r = makeSingleResult({
			label: 'security-reviewer',
			agentSource: 'unknown',
			exitCode: 1,
			stderr: 'Unknown agent: "security-reviewer". Available agents: "reviewer".',
		});
		const text = textOf(renderResult(singleDetails([r]), false));
		expect(text).not.toContain('(no output)');
		expect(text).toContain('Unknown agent: "security-reviewer"');
	});
	it('renders a blocked single result', () => {
		const r = makeSingleResult({
			label: 'worker-1',
			paneId: 'ws1:p1',
			herdrStatus: 'blocked',
			blockReason: 'approval',
			blockedPreview: 'run?',
		});
		const text = textOf(renderResult(singleDetails([r]), false));
		expect(text).toContain('awaiting approval: run?');
	});
	it('marks steered results', () => {
		const r = makeSingleResult({ label: 'worker-1', steered: true });
		const text = textOf(renderResult(singleDetails([r]), false));
		expect(text).toContain('[steered]');
	});
});

describe('renderSubagentResult - single expanded', () => {
	it('renders expanded single results as containers', () => {
		const r = makeSingleResult({
			label: 'worker-1',
			task: 'do it',
			messages: [],
			paneId: 'ws1:p1',
		});
		const out = renderResult(singleDetails([r]), true);
		expect(out).toBeInstanceOf(Container);
	});
	it('renders expanded single results with output markdown and pane', () => {
		const r = makeSingleResult({
			label: 'worker-1',
			paneId: 'ws1:p1',
			messages: [assistantMsg('final answer')],
		});
		const out = renderResult(singleDetails([r]), true);
		expect(out).toBeInstanceOf(Container);
	});
	it('renders expanded single errors with blocked info', () => {
		const r = makeSingleResult({
			label: 'worker-1',
			paneId: 'ws1:p1',
			exitCode: 1,
			errorMessage: 'boom',
			herdrStatus: 'blocked',
			blockReason: 'approval',
			blockedPreview: 'run?',
		});
		const out = renderResult(singleDetails([r]), true);
		expect(out).toBeInstanceOf(Container);
	});
});

describe('renderSubagentResult - display items', () => {
	it('renders display items with tool calls', () => {
		const messages = [
			assistantMsg('first line\nsecond line\nthird line\nfourth line'),
			assistantMsg('short', { toolCalls: [{ id: 't1', name: 'bash', args: { command: 'ls' } }] }),
		];
		const r = makeSingleResult({ label: 'worker-1', messages });
		const text = textOf(renderResult(singleDetails([r]), false));
		expect(text).toContain('$ ');
		expect(text).toContain('ls');
		expect(text).toContain('first line');
		expect(text).not.toContain('fourth line');
	});
	it('truncates many display items in collapsed mode', () => {
		const messages = [];
		for (let i = 0; i < 15; i++) messages.push(assistantMsg(`item ${i}`));
		const r = makeSingleResult({ label: 'worker-1', messages });
		const text = textOf(renderResult(singleDetails([r]), false));
		expect(text).toContain('earlier items');
		expect(text).toContain('item 14');
		expect(text).not.toContain('item 0');
		expect(text).toContain('Ctrl+O to expand');
	});
});

describe('renderSubagentResult - chain', () => {
	it('renders chain results collapsed with steps and totals', () => {
		const usage = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.001,
			contextTokens: 3,
			turns: 1,
		};
		const results = [
			makeSingleResult({ label: 'worker-1', step: 1, usage }),
			makeSingleResult({ label: 'reviewer-1', agent: 'reviewer', step: 2, usage }),
		];
		const details: SubagentDetails = {
			mode: 'chain',
			agentScope: 'user',
			projectAgentsDir: null,
			results,
		};
		const text = textOf(renderResult(details, false));
		expect(text).toContain('chain');
		expect(text).toContain('2/2 steps');
		expect(text).toContain('─── Step 1:');
		expect(text).toContain('Total:');
	});
	it('renders chain results expanded as containers', () => {
		const results = [makeSingleResult({ label: 'worker-1', step: 1 })];
		const details: SubagentDetails = {
			mode: 'chain',
			agentScope: 'user',
			projectAgentsDir: null,
			results,
		};
		const out = renderResult(details, true);
		expect(out).toBeInstanceOf(Container);
	});
	it('renders blocked chain steps expanded', () => {
		const r = makeSingleResult({
			label: 'worker-1',
			paneId: 'ws1:p1',
			step: 2,
			herdrStatus: 'blocked',
			blockReason: 'steer',
			blockedSince: Date.now(),
		});
		const details: SubagentDetails = {
			mode: 'chain',
			agentScope: 'user',
			projectAgentsDir: null,
			results: [r],
		};
		const out = renderResult(details, true);
		expect(out).toBeInstanceOf(Container);
	});
});

describe('renderSubagentResult - parallel', () => {
	it('renders parallel results with running placeholders', () => {
		const results = [makeSingleResult({ label: 'worker-1', exitCode: -1, herdrStatus: 'idle' })];
		const details: SubagentDetails = {
			mode: 'parallel',
			agentScope: 'user',
			projectAgentsDir: null,
			results,
		};
		const text = textOf(renderResult(details, false));
		expect(text).toContain('⏳');
		expect(text).toContain('(settling...)');
	});
	it('renders parallel results expanded once settled', () => {
		const results = [
			makeSingleResult({ label: 'worker-1', exitCode: 0 }),
			makeSingleResult({ label: 'worker-2', exitCode: 1 }),
		];
		const details: SubagentDetails = {
			mode: 'parallel',
			agentScope: 'user',
			projectAgentsDir: null,
			results,
		};
		const out = renderResult(details, true);
		expect(out).toBeInstanceOf(Container);
	});
	it('renders parallel live states', () => {
		const blocked = makeSingleResult({ label: 'worker-1', exitCode: -1, herdrStatus: 'blocked' });
		const blockedText = textOf(
			renderResult(
				{ mode: 'parallel', agentScope: 'user', projectAgentsDir: null, results: [blocked] },
				false,
			),
		);
		expect(blockedText).toContain('⚠');
		const running = makeSingleResult({ label: 'worker-1', exitCode: -1, herdrStatus: 'working' });
		const runningText = textOf(
			renderResult(
				{ mode: 'parallel', agentScope: 'user', projectAgentsDir: null, results: [running] },
				false,
			),
		);
		expect(runningText).toContain('(running...)');
		const done = makeSingleResult({ label: 'worker-1', exitCode: 0, herdrStatus: 'done' });
		const doneText = textOf(
			renderResult(
				{ mode: 'parallel', agentScope: 'user', projectAgentsDir: null, results: [done] },
				false,
			),
		);
		expect(doneText).toContain('(no output)');
	});
});
