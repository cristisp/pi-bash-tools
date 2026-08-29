import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverAgents } from '../src/agents.ts';
import { makeTempDir, stubEnv, writeAgentFile } from './helpers.ts';

let dir: string;

beforeEach(() => {
	dir = makeTempDir();
	stubEnv(dir);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

function writeUserAgent(name: string, extra: Record<string, string> = {}) {
	const agentsDir = path.join(dir, 'agents');
	fs.mkdirSync(agentsDir, { recursive: true });
	return writeAgentFile(agentsDir, `${name}.md`, `System prompt for ${name}.`, {
		name,
		description: `${name} description`,
		...extra,
	});
}

function writeProjectAgent(cwd: string, name: string) {
	const agentsDir = path.join(cwd, '.pi', 'agents');
	fs.mkdirSync(agentsDir, { recursive: true });
	return writeAgentFile(agentsDir, `${name}.md`, `Project prompt for ${name}.`, {
		name,
		description: `project ${name}`,
	});
}

describe('discoverAgents - user agents', () => {
	it('discovers user agents with frontmatter metadata and ignores a model frontmatter', () => {
		writeUserAgent('worker', { model: 'legacy/model:high', tools: 'bash, read' });
		const { agents, projectAgentsDir } = discoverAgents(dir, 'user');
		expect(projectAgentsDir).toBeNull();
		expect(agents).toHaveLength(1);
		expect(agents[0]).toMatchObject({
			name: 'worker',
			description: 'worker description',
			tools: ['bash', 'read'],
			systemPrompt: 'System prompt for worker.',
			source: 'user',
		});
		expect(agents[0]).not.toHaveProperty('model');
	});

	it('skips files without name or description frontmatter', () => {
		const agentsDir = path.join(dir, 'agents');
		fs.mkdirSync(agentsDir, { recursive: true });
		writeAgentFile(agentsDir, 'nameless.md', 'no frontmatter data', { description: 'only desc' });
		writeAgentFile(agentsDir, 'plain.md', 'no frontmatter at all', {});
		expect(discoverAgents(dir, 'user').agents).toHaveLength(0);
	});

	it('returns empty for missing user dir', () => {
		expect(discoverAgents(dir, 'user').agents).toHaveLength(0);
	});
});

describe('discoverAgents - scoping', () => {
	it('discovers project agents walking up from cwd', () => {
		writeUserAgent('worker');
		const deep = path.join(dir, 'a', 'b');
		fs.mkdirSync(deep, { recursive: true });
		writeProjectAgent(dir, 'scout');
		const result = discoverAgents(deep, 'both');
		expect(result.projectAgentsDir).toBe(path.join(dir, '.pi', 'agents'));
		const names = result.agents.map((a) => a.name).toSorted();
		expect(names).toEqual(['scout', 'worker']);
	});

	it('scopes to user agents only', () => {
		writeUserAgent('worker');
		writeProjectAgent(dir, 'scout');
		const { agents } = discoverAgents(dir, 'user');
		expect(agents.map((a) => a.name)).toEqual(['worker']);
	});

	it('scopes to project agents only', () => {
		writeUserAgent('worker');
		writeProjectAgent(dir, 'scout');
		const { agents } = discoverAgents(dir, 'project');
		expect(agents.map((a) => a.name)).toEqual(['scout']);
		expect(agents[0].source).toBe('project');
	});

	it('lets project agents override user agents by name in both scope', () => {
		writeUserAgent('worker');
		writeProjectAgent(dir, 'worker');
		const { agents } = discoverAgents(dir, 'both');
		expect(agents).toHaveLength(1);
		expect(agents[0].source).toBe('project');
	});

	it('returns null project dir when none exists', () => {
		const result = discoverAgents(dir, 'both');
		expect(result.projectAgentsDir).toBeNull();
		expect(result.agents).toHaveLength(0);
	});
});
