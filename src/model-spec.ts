const MODEL_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const MODEL_SPEC_PATTERN =
	/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?::([A-Za-z]+))?$/;

function matchModelSpec(value: string): RegExpExecArray | null {
	return MODEL_SPEC_PATTERN.exec(value.trim());
}

export interface ModelSpecParts {
	provider: string;
	modelId: string;
	level?: string;
}

export function splitModelSpec(value: string): ModelSpecParts | null {
	const match = MODEL_SPEC_PATTERN.exec(value.trim());
	if (!match) return null;
	return { provider: match[1], modelId: match[2], level: match[3] };
}

export function isValidModelSpec(value: string): boolean {
	const match = matchModelSpec(value);
	if (!match) return false;
	const level = match[3];
	return level === undefined || MODEL_LEVELS.has(level.toLowerCase());
}

export function hasThinkingLevel(value: string): boolean {
	const level = matchModelSpec(value)?.[3];
	return level !== undefined && MODEL_LEVELS.has(level.toLowerCase());
}

export function normalizeModelSpec(value: string): string {
	const spec = value.trim();
	const colon = spec.lastIndexOf(':');
	if (colon > 0 && MODEL_LEVELS.has(spec.slice(colon + 1).toLowerCase())) {
		return `${spec.slice(0, colon)}:${spec.slice(colon + 1).toLowerCase()}`;
	}
	return spec;
}
