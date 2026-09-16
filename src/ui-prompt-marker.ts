import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const UI_PROMPT_MARKER_ENTRY_TYPE = 'subagent-herdr.ui-prompt';

export const HERDR_BLOCKED_EVENT = 'herdr:blocked';

export const UI_PROMPT_MARKER_FORMAT_VERSION = 1;

export const UI_PROMPT_MARKER_TITLE_MAX_CHARS = 200;

export const UI_PROMPT_SUMMARY_MAX_CHARS = 80;

export type UiPromptMarkerEvent = 'start' | 'end';

export type UiPromptMarkerKind = 'select' | 'confirm' | 'input' | 'editor' | 'custom';

export interface UiPromptMarker {
	formatVersion: number;
	event: UiPromptMarkerEvent;
	kind: UiPromptMarkerKind;
	title?: string;
}

const MARKER_EVENTS: ReadonlySet<string> = new Set<UiPromptMarkerEvent>(['start', 'end']);

const MARKER_KINDS: ReadonlySet<string> = new Set<UiPromptMarkerKind>([
	'select',
	'confirm',
	'input',
	'editor',
	'custom',
]);

function isMarkerEvent(value: unknown): value is UiPromptMarkerEvent {
	return typeof value === 'string' && MARKER_EVENTS.has(value);
}

function isMarkerKind(value: unknown): value is UiPromptMarkerKind {
	return typeof value === 'string' && MARKER_KINDS.has(value);
}

export function boundedTitle(title: unknown): string | undefined {
	if (typeof title !== 'string') return undefined;
	const trimmed = title.trim();
	if (!trimmed) return undefined;
	return trimmed.length > UI_PROMPT_MARKER_TITLE_MAX_CHARS
		? trimmed.slice(0, UI_PROMPT_MARKER_TITLE_MAX_CHARS)
		: trimmed;
}

export function boundedSummary(title: unknown): string | undefined {
	if (typeof title !== 'string') return undefined;
	const trimmed = title.trim();
	if (!trimmed) return undefined;
	return trimmed.length > UI_PROMPT_SUMMARY_MAX_CHARS
		? trimmed.slice(0, UI_PROMPT_SUMMARY_MAX_CHARS)
		: trimmed;
}

export function makeUiPromptMarkerData(
	event: UiPromptMarkerEvent,
	kind: unknown,
	title: unknown,
): UiPromptMarker | undefined {
	if (!isMarkerEvent(event) || !isMarkerKind(kind)) return undefined;
	const data: UiPromptMarker = { formatVersion: UI_PROMPT_MARKER_FORMAT_VERSION, event, kind };
	const bounded = boundedTitle(title);
	if (bounded !== undefined) data.title = bounded;
	return data;
}

/**
 * Children only: the poller reads markers from the child session tail, so a root session writing
 * them would block itself. PI_SUBAGENT_NESTED is the discriminator the launcher sets for children.
 */
export function registerUiPromptMarker(
	pi: ExtensionAPI,
	environment: Record<string, string | undefined> = process.env,
): void {
	if (environment.PI_SUBAGENT_NESTED !== '1') return;
	const on = (
		pi as unknown as {
			on: (event: string, handler: (event: unknown) => void) => void;
		}
	).on.bind(pi);
	on('ui_prompt_start', (event) => {
		appendUiPromptMarker(pi, 'start', event);
		emitHerdrBlocked(pi, herdrBlockedStartPayload(event));
	});
	on('ui_prompt_end', (event) => {
		appendUiPromptMarker(pi, 'end', event);
		emitHerdrBlocked(pi, { active: false });
	});
}

export interface HerdrBlockedPayload {
	active: boolean;
	label?: string;
}

function emitHerdrBlocked(pi: ExtensionAPI, payload: HerdrBlockedPayload): void {
	try {
		(pi as unknown as { events: { emit: (event: string, data: unknown) => void } }).events.emit(
			HERDR_BLOCKED_EVENT,
			payload,
		);
	} catch {}
}

function herdrBlockedStartPayload(raw: unknown): HerdrBlockedPayload {
	const fields = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
	return { active: true, label: boundedTitle(fields.title) ?? 'awaiting input' };
}

function appendUiPromptMarker(pi: ExtensionAPI, event: UiPromptMarkerEvent, raw: unknown): void {
	const fields = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
	const data = makeUiPromptMarkerData(event, fields.kind, fields.title);
	if (!data) return;
	try {
		pi.appendEntry(UI_PROMPT_MARKER_ENTRY_TYPE, data);
	} catch {}
}

export function parseUiPromptMarkerEntry(entry: unknown): UiPromptMarker | undefined {
	if (typeof entry !== 'object' || entry === null) return undefined;
	const envelope = entry as Record<string, unknown>;
	if (envelope.type !== 'custom' || envelope.customType !== UI_PROMPT_MARKER_ENTRY_TYPE) {
		return undefined;
	}
	const data = envelope.data;
	if (typeof data !== 'object' || data === null) return undefined;
	const fields = data as Record<string, unknown>;
	if (fields.formatVersion !== UI_PROMPT_MARKER_FORMAT_VERSION) return undefined;
	if (!isMarkerEvent(fields.event) || !isMarkerKind(fields.kind)) return undefined;
	let title: string | undefined;
	if (fields.title !== undefined) {
		if (
			typeof fields.title !== 'string' ||
			fields.title.length > UI_PROMPT_MARKER_TITLE_MAX_CHARS
		) {
			return undefined;
		}
		title = fields.title.trim() || undefined;
		if (title === undefined) return undefined;
	}
	const marker: UiPromptMarker = {
		formatVersion: UI_PROMPT_MARKER_FORMAT_VERSION,
		event: fields.event,
		kind: fields.kind,
	};
	if (title !== undefined) marker.title = title;
	return marker;
}
