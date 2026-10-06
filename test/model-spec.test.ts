import { describe, expect, it } from 'vitest';
import {
	hasThinkingLevel,
	isValidModelSpec,
	normalizeModelSpec,
	splitModelSpec,
} from '../src/model-spec.ts';

describe('isValidModelSpec', () => {
	it('accepts provider/model specs', () => {
		expect(isValidModelSpec('github-copilot/gpt-5.6-luna')).toBe(true);
		expect(isValidModelSpec('cortecs/deepseek-v4-flash-0731')).toBe(true);
	});
	it('treats provider tokens as opaque, including the renamed azure provider', () => {
		// S13-005: pi 1.0.3 renamed the azure provider key from azure-openai-responses to azure.
		// herdr model presets never interpret the provider segment, so both tokens are plain specs.
		expect(isValidModelSpec('azure/gpt-5.2')).toBe(true);
		expect(isValidModelSpec('azure-openai-responses/gpt-5.2')).toBe(true);
		expect(splitModelSpec('azure/gpt-5.2')).toEqual({
			provider: 'azure',
			modelId: 'gpt-5.2',
			level: undefined,
		});
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

describe('hasThinkingLevel', () => {
	it('detects valid thinking levels', () => {
		expect(hasThinkingLevel('p/m:high')).toBe(true);
		expect(hasThinkingLevel('p/m:HIGH')).toBe(true);
		expect(hasThinkingLevel('p/m:off')).toBe(true);
	});
	it('returns false without a level or with an invalid one', () => {
		expect(hasThinkingLevel('p/m')).toBe(false);
		expect(hasThinkingLevel('p/m:ultra')).toBe(false);
		expect(hasThinkingLevel('no-slash')).toBe(false);
	});
});

describe('splitModelSpec', () => {
	it('splits provider, model id, and level', () => {
		expect(splitModelSpec('p/m:high')).toEqual({ provider: 'p', modelId: 'm', level: 'high' });
		expect(splitModelSpec('provider/model.id-x')).toEqual({
			provider: 'provider',
			modelId: 'model.id-x',
			level: undefined,
		});
	});
	it('returns null for malformed specs', () => {
		expect(splitModelSpec('no-slash')).toBeNull();
		expect(splitModelSpec('')).toBeNull();
		expect(splitModelSpec('provider/')).toBeNull();
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
