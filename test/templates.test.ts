import { describe, expect, it } from 'vitest';
import {
	AGENT_TEMPLATES,
	isValidModelSpec,
	normalizeModelSpec,
	renderAgentFile,
} from '../src/templates.ts';

describe('isValidModelSpec', () => {
	it('accepts provider/model specs', () => {
		expect(isValidModelSpec('github-copilot/gpt-5.6-luna')).toBe(true);
		expect(isValidModelSpec('cortecs/deepseek-v4-flash-0731')).toBe(true);
	});
	it('accepts thinking levels case-insensitively', () => {
		expect(isValidModelSpec('provider/model:high')).toBe(true);
		expect(isValidModelSpec('provider/model:High')).toBe(true);
		expect(isValidModelSpec('provider/model:off')).toBe(true);
		expect(isValidModelSpec('provider/model:max')).toBe(true);
	});
	it('rejects unknown levels and malformed specs', () => {
		expect(isValidModelSpec('provider/model:ultra')).toBe(false);
		expect(isValidModelSpec('no-slash')).toBe(false);
		expect(isValidModelSpec('/missing-provider')).toBe(false);
		expect(isValidModelSpec('provider/')).toBe(false);
		expect(isValidModelSpec('')).toBe(false);
		expect(isValidModelSpec('provider/model:')).toBe(false);
	});
});

describe('normalizeModelSpec', () => {
	it('lowercases valid thinking levels', () => {
		expect(normalizeModelSpec('p/m:HIGH')).toBe('p/m:high');
		expect(normalizeModelSpec('p/m:Low')).toBe('p/m:low');
	});
	it('leaves specs without levels untouched', () => {
		expect(normalizeModelSpec('p/m')).toBe('p/m');
	});
	it('trims whitespace', () => {
		expect(normalizeModelSpec('  p/m:high  ')).toBe('p/m:high');
	});
});

describe('renderAgentFile', () => {
	it('renders frontmatter with name, description, tools, and model', () => {
		const out = renderAgentFile(AGENT_TEMPLATES[0], 'test-model:high');
		expect(out).toContain('---');
		expect(out).toContain('name: planner');
		expect(out).toContain(
			'description: Creates implementation plans from context and requirements',
		);
		expect(out).toContain(
			'tools: read, grep, find, codegraph_explore, codegraph_callers, codegraph_callees, codegraph_impact, codegraph_affected, codegraph_sync',
		);
		expect(out).toContain('model: test-model:high');
		expect(out).toContain('## Goal');
	});
	it('omits tools when the template has none', () => {
		const out = renderAgentFile(
			{ filename: 'x.md', name: 'x', description: 'd', body: 'body text' },
			'm',
		);
		expect(out).not.toContain('tools:');
		expect(out).toContain('body text');
	});
	it('includes the full codegraph toolset in every restricted template', () => {
		const codegraphTools = [
			'codegraph_explore',
			'codegraph_callers',
			'codegraph_callees',
			'codegraph_impact',
			'codegraph_affected',
			'codegraph_sync',
		];
		for (const t of AGENT_TEMPLATES) {
			if (!t.tools) continue;
			for (const tool of codegraphTools) {
				expect(t.tools, `${t.name} must include ${tool}`).toContain(tool);
			}
		}
	});
	it('carries the codegraph usage guidance in every template body', () => {
		for (const t of AGENT_TEMPLATES) {
			expect(t.body, `${t.name} must carry codegraph guidance`).toContain('## Codegraph usage');
			expect(t.body, `${t.name} must teach the .codegraph check`).toContain(
				'First check that `.codegraph` exists',
			);
		}
	});
	it('offers the docs lookup tools to planner, reviewer, and scout', () => {
		for (const name of ['planner', 'reviewer', 'scout']) {
			const t = AGENT_TEMPLATES.find((a) => a.name === name);
			expect(t?.tools, `${name} must whitelist resolve-library-id`).toContain('resolve-library-id');
			expect(t?.tools, `${name} must whitelist query-docs`).toContain('query-docs');
			expect(t?.body, `${name} must carry docs lookup guidance`).toContain(
				'resolve-library-id first',
			);
		}
	});
	it('gives the worker the docs lookup guidance too', () => {
		const worker = AGENT_TEMPLATES.find((t) => t.name === 'worker');
		expect(worker?.tools).toBeUndefined();
		expect(worker?.body).toContain('resolve-library-id first');
	});
	it('produces parseable frontmatter for every template', () => {
		for (const t of AGENT_TEMPLATES) {
			const out = renderAgentFile(t, 'm:high');
			expect(out.startsWith('---\n')).toBe(true);
			expect(out).toContain(`name: ${t.name}`);
			expect(out).toContain(`description: ${t.description}`);
			expect(out).toMatch(/model: m:high\n---/);
		}
	});
});
