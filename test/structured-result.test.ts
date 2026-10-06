import { describe, expect, it } from 'vitest';
import { Check } from 'typebox/value';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { SubagentDetails } from '../src/types.ts';
import { assistantMsg, makeMetrics, makeSingleResult } from './helpers.ts';
import {
	MAX_STRUCTURED_RESULTS,
	structuredContentOf,
	SubagentStructuredResultSchema,
	withStructuredContent,
} from '../src/structured-result.ts';

function detailsWith(overrides: Parameters<typeof makeSingleResult>[0] = {}): SubagentDetails {
	return {
		mode: 'parallel',
		agentScope: 'user',
		projectAgentsDir: '/Users/private/.pi/agents',
		results: [makeSingleResult(overrides)],
	};
}

describe('structuredContentOf', () => {
	it('projects a bounded outcome view and never leaks session internals', () => {
		const content = structuredContentOf(
			detailsWith({
				label: 'worker-1',
				agent: 'worker',
				herdrStatus: 'blocked',
				blockReason: 'approval',
				blockedPreview: 'awaiting approval: rm -rf',
				steered: false,
				stopReason: 'stop',
				errorMessage: 'e'.repeat(400),
				step: 2,
				delegationId: 'D-001',
				taskId: 'T-001',
				model: 'azure/gpt-5.2',
				messages: [assistantMsg('secret reasoning')],
				stderr: 'err'.repeat(200),
				metrics: makeMetrics({ toolCalls: 99 }),
				dirtyPaths: ['src/private.ts'],
				scope: { paths: ['src'] },
				readManifest: { persistedPath: '/Users/private/manifest.json' } as never,
				report: { tokens: 9999 } as never,
				usage: {
					input: 10,
					output: 20,
					cacheRead: 7,
					cacheWrite: 8,
					cost: 0.5,
					contextTokens: 300,
					turns: 2,
				},
			}),
		);
		expect(content.mode).toBe('parallel');
		expect(content.agentScope).toBe('user');
		expect(content.results).toHaveLength(1);
		const item = content.results[0];
		expect(item.label).toBe('worker-1');
		expect(item.agent).toBe('worker');
		expect(item.exitCode).toBe(0);
		expect(item.herdrStatus).toBe('blocked');
		expect(item.blockReason).toBe('approval');
		expect(item.steered).toBe(false);
		expect(item.stopReason).toBe('stop');
		expect(item.step).toBe(2);
		expect(item.delegationId).toBe('D-001');
		expect(item.taskId).toBe('T-001');
		expect(item.usage).toEqual({ input: 10, output: 20, contextTokens: 300, cost: 0.5, turns: 2 });
		expect(content.truncated).toBeUndefined();
		const json = JSON.stringify(content);
		for (const leak of [
			'messages',
			'stderr',
			'metrics',
			'dirtyPaths',
			'readManifest',
			'report',
			'projectAgentsDir',
			'blockedPreview',
			'cacheRead',
			'cacheWrite',
			'model',
			'secret reasoning',
			'/Users/private',
		]) {
			expect(json).not.toContain(leak);
		}
	});

	it('caps long error messages to the schema maximum', () => {
		const content = structuredContentOf(detailsWith({ errorMessage: 'x'.repeat(1000) }));
		expect(content.results[0].errorMessage).toHaveLength(300);
	});

	it('caps stop reasons and identifiers to the schema maximum', () => {
		const content = structuredContentOf(
			detailsWith({
				agent: 'a'.repeat(200),
				stopReason: 's'.repeat(250),
				delegationId: 'D'.repeat(200),
				taskId: 'T'.repeat(200),
			}),
		);
		const item = content.results[0];
		expect(item.agent).toHaveLength(128);
		expect(item.stopReason).toHaveLength(100);
		expect(item.delegationId).toHaveLength(128);
		expect(item.taskId).toHaveLength(128);
	});

	it('projects a refusal with its kind and caps the message', () => {
		const content = structuredContentOf({
			mode: 'single',
			agentScope: 'user',
			projectAgentsDir: null,
			results: [],
			refusal: { kind: 'composition', message: 'm'.repeat(700) },
		});
		expect(content.results).toEqual([]);
		expect(content.refusal).toEqual({ kind: 'composition', message: 'm'.repeat(600) });
	});

	it('omits the refusal field on normal results', () => {
		expect(structuredContentOf(detailsWith()).refusal).toBeUndefined();
	});

	it('caps the results array and reports truncation', () => {
		const results = Array.from({ length: MAX_STRUCTURED_RESULTS + 8 }, (_, i) =>
			makeSingleResult({ label: `worker-${i + 1}` }),
		);
		const content = structuredContentOf({
			mode: 'chain',
			agentScope: 'project',
			projectAgentsDir: null,
			results,
		});
		expect(content.results).toHaveLength(MAX_STRUCTURED_RESULTS);
		expect(content.results[0].label).toBe('worker-1');
		expect(content.results.at(-1)?.label).toBe(`worker-${MAX_STRUCTURED_RESULTS}`);
		expect(content.truncated).toBe(true);
	});

	it('keeps exactly MAX_STRUCTURED_RESULTS untruncated', () => {
		const results = Array.from({ length: MAX_STRUCTURED_RESULTS }, (_, i) =>
			makeSingleResult({ step: i + 1 }),
		);
		const content = structuredContentOf({
			mode: 'chain',
			agentScope: 'user',
			projectAgentsDir: null,
			results,
		});
		expect(content.results).toHaveLength(MAX_STRUCTURED_RESULTS);
		expect(content.truncated).toBeUndefined();
	});

	it('represents informational listings as empty results without a refusal', () => {
		// `list` and `agents` return their listing model-facing only: the projection reports the call as
		// a normal empty result rather than inventing an unbounded listing surface for scripts.
		const content = structuredContentOf({
			mode: 'single',
			agentScope: 'user',
			projectAgentsDir: null,
			results: [],
		});
		expect(content).toEqual({ mode: 'single', agentScope: 'user', results: [] });
		expect(Object.keys(content)).toEqual(['mode', 'agentScope', 'results']);
	});

	it('handles empty and single-mode details', () => {
		expect(
			structuredContentOf({
				mode: 'single',
				agentScope: 'user',
				projectAgentsDir: null,
				results: [],
			}),
		).toEqual({ mode: 'single', agentScope: 'user', results: [] });
	});
});

describe('withStructuredContent', () => {
	it('preserves model-facing content and details and attaches the projection', () => {
		const details = detailsWith({ label: 'worker-1', delegationId: 'D-1' });
		const content = [{ type: 'text' as const, text: 'worker-1 completed' }];
		const result = withStructuredContent<SubagentDetails>({
			content,
			details,
		} as AgentToolResult<SubagentDetails>);
		expect(result.content).toBe(content);
		expect(result.details).toBe(details);
		expect(result.structuredContent).toEqual(structuredContentOf(details));
		expect(JSON.stringify(result)).toContain('"structuredContent"');
	});

	it('keeps the isError flag and the refusal of a refused result', () => {
		const details: SubagentDetails = {
			mode: 'single',
			agentScope: 'user',
			projectAgentsDir: null,
			results: [],
			refusal: { kind: 'nested', message: 'Nested subagents are disabled.' },
		};
		const content = [{ type: 'text' as const, text: 'Nested subagents are disabled.' }];
		const result = withStructuredContent({ content, details, isError: true });
		expect(result.isError).toBe(true);
		expect(result.content).toBe(content);
		expect(result.structuredContent.refusal).toEqual(details.refusal);
	});
});

describe('SubagentStructuredResultSchema', () => {
	it('validates projected results', () => {
		const content = structuredContentOf(
			detailsWith({
				label: 'worker-1',
				agent: 'worker',
				agentSource: 'reuse',
				herdrStatus: 'blocked',
				blockReason: 'steer',
				steered: true,
				stopReason: 'aborted',
				errorMessage: 'x'.repeat(300),
				step: 1,
				delegationId: 'D-1',
				taskId: 'T-1',
				usage: {
					input: 1,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0.01,
					contextTokens: 10,
					turns: 1,
				},
			}),
		);
		expect(Check(SubagentStructuredResultSchema, content)).toBe(true);
	});

	it('rejects capped-limit violations', () => {
		const tooLong = structuredContentOf(
			detailsWith({ errorMessage: 'x'.repeat(1000), label: 'l'.repeat(200) }),
		);
		expect(Check(SubagentStructuredResultSchema, tooLong)).toBe(true);
		tooLong.results[0].agent = 'a'.repeat(129);
		expect(Check(SubagentStructuredResultSchema, tooLong)).toBe(false);
		tooLong.results[0].agent = 'a'.repeat(128);
		tooLong.results[0].errorMessage = 'x'.repeat(301);
		expect(Check(SubagentStructuredResultSchema, tooLong)).toBe(false);
		tooLong.results[0].errorMessage = 'x'.repeat(300);
		tooLong.results[0].label = 'l'.repeat(129);
		expect(Check(SubagentStructuredResultSchema, tooLong)).toBe(false);
		tooLong.results[0].label = 'l'.repeat(128);
		tooLong.results[0].stopReason = 's'.repeat(101);
		expect(Check(SubagentStructuredResultSchema, tooLong)).toBe(false);
		tooLong.results[0].stopReason = 's'.repeat(100);
		tooLong.results[0].delegationId = 'D'.repeat(129);
		expect(Check(SubagentStructuredResultSchema, tooLong)).toBe(false);
		tooLong.results[0].delegationId = 'D'.repeat(128);
		tooLong.results[0].taskId = 'T'.repeat(129);
		expect(Check(SubagentStructuredResultSchema, tooLong)).toBe(false);
		tooLong.results[0].taskId = 'T'.repeat(128);
		expect(Check(SubagentStructuredResultSchema, tooLong)).toBe(true);
		const tooMany = structuredContentOf(detailsWith());
		for (let i = 0; i < MAX_STRUCTURED_RESULTS; i++) {
			tooMany.results.push(makeSingleResult({ label: `extra-${i}` }));
		}
		tooMany.truncated = true;
		expect(Check(SubagentStructuredResultSchema, tooMany)).toBe(false);
	});

	it('validates refusals and rejects unknown kinds or overlong messages', () => {
		const content = structuredContentOf({
			mode: 'single',
			agentScope: 'user',
			projectAgentsDir: null,
			results: [],
			refusal: { kind: 'spawn-boundary', message: 'outside the session root' },
		});
		expect(Check(SubagentStructuredResultSchema, content)).toBe(true);
		expect(
			Check(SubagentStructuredResultSchema, {
				...content,
				refusal: { kind: 'bogus', message: 'x' },
			}),
		).toBe(false);
		expect(
			Check(SubagentStructuredResultSchema, {
				...content,
				refusal: { kind: 'spawn-boundary', message: 'x'.repeat(601) },
			}),
		).toBe(false);
		expect(
			Check(SubagentStructuredResultSchema, {
				...content,
				refusal: { kind: 'spawn-boundary', message: 'x'.repeat(600), extra: true },
			}),
		).toBe(false);
	});

	it('rejects unknown enum values and undeclared fields', () => {
		const content = structuredContentOf(detailsWith());
		expect(Check(SubagentStructuredResultSchema, { ...content, mode: 'bogus' })).toBe(false);
		expect(Check(SubagentStructuredResultSchema, { ...content, agentScope: 'everyone' })).toBe(
			false,
		);
		// The schema sets additionalProperties: false so projection drift fails validation instead of
		// silently passing, both at the top level and inside a result item.
		expect(Check(SubagentStructuredResultSchema, { ...content, extra: true })).toBe(false);
		expect(
			Check(SubagentStructuredResultSchema, {
				...content,
				results: [{ ...content.results[0], messages: [] }],
			}),
		).toBe(false);
		expect(
			Check(SubagentStructuredResultSchema, {
				...content,
				results: [{ ...content.results[0], usage: { input: 1, output: 2, cacheRead: 3 } }],
			}),
		).toBe(false);
	});
});
