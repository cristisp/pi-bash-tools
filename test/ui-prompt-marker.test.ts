import { describe, expect, it, vi } from 'vitest';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
	boundedSummary,
	HERDR_BLOCKED_EVENT,
	makeUiPromptMarkerData,
	parseUiPromptMarkerEntry,
	registerUiPromptMarker,
	UI_PROMPT_MARKER_ENTRY_TYPE,
	UI_PROMPT_MARKER_FORMAT_VERSION,
	UI_PROMPT_MARKER_TITLE_MAX_CHARS,
	type UiPromptMarker,
	type UiPromptMarkerEvent,
} from '../src/ui-prompt-marker.ts';

function markerEntry(data: unknown, customType = UI_PROMPT_MARKER_ENTRY_TYPE): unknown {
	return { type: 'custom', customType, data, id: 'e1', parentId: null, timestamp: '' };
}

function makePi() {
	return { on: vi.fn(), appendEntry: vi.fn(), events: { emit: vi.fn() } };
}

describe('boundedSummary', () => {
	it('trims and passes through short titles', () => {
		expect(boundedSummary('  Allow rm?  ')).toBe('Allow rm?');
	});

	it('returns undefined for empty or non-string titles', () => {
		expect(boundedSummary(undefined)).toBeUndefined();
		expect(boundedSummary(42)).toBeUndefined();
		expect(boundedSummary('   ')).toBeUndefined();
	});

	it('truncates at 80 chars', () => {
		expect(boundedSummary('x'.repeat(120))).toBe('x'.repeat(80));
		expect(boundedSummary('x'.repeat(80))).toBe('x'.repeat(80));
	});
});

describe('makeUiPromptMarkerData', () => {
	it('builds a bounded start marker with a trimmed title', () => {
		expect(makeUiPromptMarkerData('start', 'select', '  Allow rm?  ')).toEqual({
			formatVersion: 1,
			event: 'start',
			kind: 'select',
			title: 'Allow rm?',
		});
	});

	it('drops an empty title and truncates an oversized one', () => {
		expect(makeUiPromptMarkerData('end', 'confirm', '   ')).toEqual({
			formatVersion: 1,
			event: 'end',
			kind: 'confirm',
		});
		const long = 'x'.repeat(UI_PROMPT_MARKER_TITLE_MAX_CHARS + 10);
		const data = makeUiPromptMarkerData('start', 'input', long);
		expect(data?.title).toHaveLength(UI_PROMPT_MARKER_TITLE_MAX_CHARS);
	});

	it('rejects unknown events and kinds', () => {
		expect(
			makeUiPromptMarkerData('pause' as UiPromptMarkerEvent, 'select', undefined),
		).toBeUndefined();
		expect(makeUiPromptMarkerData('start', 'menu', undefined)).toBeUndefined();
		expect(makeUiPromptMarkerData('start', 42, undefined)).toBeUndefined();
	});
});

describe('parseUiPromptMarkerEntry', () => {
	it('parses a valid marker and tolerates unknown fields', () => {
		const marker: UiPromptMarker = {
			formatVersion: UI_PROMPT_MARKER_FORMAT_VERSION,
			event: 'start',
			kind: 'confirm',
			title: 'Overwrite preset?',
		};
		const parsed = parseUiPromptMarkerEntry(markerEntry({ ...marker, extra: 'ignored' }));
		expect(parsed).toEqual(marker);
	});

	it('parses a marker without a title', () => {
		expect(
			parseUiPromptMarkerEntry(markerEntry({ formatVersion: 1, event: 'end', kind: 'custom' })),
		).toEqual({ formatVersion: 1, event: 'end', kind: 'custom' });
	});

	it('rejects other entry types and custom types', () => {
		expect(
			parseUiPromptMarkerEntry(
				markerEntry({ formatVersion: 1, event: 'end', kind: 'custom' }, 'other.type'),
			),
		).toBeUndefined();
		expect(parseUiPromptMarkerEntry({ type: 'message', message: {} })).toBeUndefined();
		expect(parseUiPromptMarkerEntry(null)).toBeUndefined();
	});

	it('rejects malformed data', () => {
		expect(parseUiPromptMarkerEntry(markerEntry(null))).toBeUndefined();
		expect(
			parseUiPromptMarkerEntry(markerEntry({ formatVersion: 2, event: 'end', kind: 'custom' })),
		).toBeUndefined();
		expect(
			parseUiPromptMarkerEntry(markerEntry({ formatVersion: 1, event: 'pause', kind: 'custom' })),
		).toBeUndefined();
		expect(
			parseUiPromptMarkerEntry(markerEntry({ formatVersion: 1, event: 'end', kind: 'menu' })),
		).toBeUndefined();
		expect(
			parseUiPromptMarkerEntry(markerEntry({ formatVersion: 1, event: 'end', title: 3 })),
		).toBeUndefined();
	});

	it('rejects an oversized title', () => {
		const data = {
			formatVersion: 1,
			event: 'start',
			kind: 'select',
			title: 'y'.repeat(UI_PROMPT_MARKER_TITLE_MAX_CHARS + 1),
		};
		expect(parseUiPromptMarkerEntry(markerEntry(data))).toBeUndefined();
	});
});

describe('registerUiPromptMarker', () => {
	it('appends start and end markers on a child session', () => {
		const pi = makePi();
		registerUiPromptMarker(pi as unknown as ExtensionAPI, { PI_SUBAGENT_NESTED: '1' });
		const start = pi.on.mock.calls.find((c) => c[0] === 'ui_prompt_start')![1];
		const end = pi.on.mock.calls.find((c) => c[0] === 'ui_prompt_end')![1];
		start({ type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'select', title: '  Allow?  ' });
		end({ type: 'ui_prompt_end', reason: 'ui_prompt', kind: 'select' });
		expect(pi.appendEntry).toHaveBeenCalledTimes(2);
		expect(pi.appendEntry).toHaveBeenNthCalledWith(1, UI_PROMPT_MARKER_ENTRY_TYPE, {
			formatVersion: 1,
			event: 'start',
			kind: 'select',
			title: 'Allow?',
		});
		expect(pi.appendEntry).toHaveBeenNthCalledWith(2, UI_PROMPT_MARKER_ENTRY_TYPE, {
			formatVersion: 1,
			event: 'end',
			kind: 'select',
		});
	});

	it('emits balanced herdr:blocked events around the prompt', () => {
		const pi = makePi();
		registerUiPromptMarker(pi as unknown as ExtensionAPI, { PI_SUBAGENT_NESTED: '1' });
		const start = pi.on.mock.calls.find((c) => c[0] === 'ui_prompt_start')![1];
		const end = pi.on.mock.calls.find((c) => c[0] === 'ui_prompt_end')![1];
		start({ type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'select', title: 'Allow write?' });
		end({ type: 'ui_prompt_end', reason: 'ui_prompt', kind: 'select' });
		expect(pi.events.emit).toHaveBeenCalledTimes(2);
		expect(pi.events.emit).toHaveBeenNthCalledWith(1, HERDR_BLOCKED_EVENT, {
			active: true,
			label: 'Allow write?',
		});
		expect(pi.events.emit).toHaveBeenNthCalledWith(2, HERDR_BLOCKED_EVENT, { active: false });
	});

	it('falls back to a generic label when the prompt has no title', () => {
		const pi = makePi();
		registerUiPromptMarker(pi as unknown as ExtensionAPI, { PI_SUBAGENT_NESTED: '1' });
		const start = pi.on.mock.calls.find((c) => c[0] === 'ui_prompt_start')![1];
		start({ type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'confirm' });
		expect(pi.events.emit).toHaveBeenCalledWith(HERDR_BLOCKED_EVENT, {
			active: true,
			label: 'awaiting input',
		});
	});

	it('writes nothing when the session is not a child', () => {
		const pi = makePi();
		registerUiPromptMarker(pi as unknown as ExtensionAPI, { PI_SUBAGENT_NESTED: '0' });
		expect(pi.on).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(pi.events.emit).not.toHaveBeenCalled();
	});

	it('ignores malformed events and append failures', () => {
		const pi = makePi();
		pi.appendEntry.mockImplementation(() => {
			throw new Error('disk full');
		});
		pi.events.emit.mockImplementation(() => {
			throw new Error('bus closed');
		});
		registerUiPromptMarker(pi as unknown as ExtensionAPI, { PI_SUBAGENT_NESTED: '1' });
		const start = pi.on.mock.calls.find((c) => c[0] === 'ui_prompt_start')![1];
		expect(() => start(null)).not.toThrow();
		expect(() => start({ kind: 'select', title: 'x' })).not.toThrow();
		expect(() => start({ kind: 'select', title: 'x' })).not.toThrow();
		expect(pi.appendEntry).toHaveBeenCalledTimes(2);
	});
});
