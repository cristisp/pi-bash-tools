import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { herdrCliReportMetadata } from './herdr.ts';
import {
	boundedSummary,
	makeUiPromptMarkerData,
	type UiPromptMarkerEvent,
} from './ui-prompt-marker.ts';

const UI_PROMPT_REPORT_SOURCE = 'subagent-herdr';

const UI_PROMPT_REPORT_TTL_MS = 1800000;

export function buildUiPromptReportArgs(
	event: UiPromptMarkerEvent,
	seq: number,
	paneId: string,
	title?: string,
): string[] {
	if (event === 'start') {
		const args = [
			'pane',
			'report-metadata',
			'--source',
			UI_PROMPT_REPORT_SOURCE,
			'--state-label',
			'working=awaiting input',
			'--ttl-ms',
			String(UI_PROMPT_REPORT_TTL_MS),
			'--seq',
			String(seq),
		];
		if (title) args.push('--token', `summary=${boundedSummary(title)}`);
		args.push(paneId);
		return args;
	}
	return [
		'pane',
		'report-metadata',
		'--source',
		UI_PROMPT_REPORT_SOURCE,
		'--clear-state-labels',
		'--clear-token',
		'summary',
		'--seq',
		String(seq),
		paneId,
	];
}

/**
 * Children only: piggybacks on the ui_prompt start/end markers to patch visual metadata on the
 * child's own herdr pane so the sidebar can show an awaiting-input label while a dialog is open.
 * Fire-and-forget, serialized, and fail-open; reports only on events the marker writer accepts.
 */
export function registerUiPromptReporter(
	pi: ExtensionAPI,
	environment: Record<string, string | undefined> = process.env,
): void {
	if (environment.PI_SUBAGENT_NESTED !== '1') return;
	const paneId = environment.HERDR_PANE_ID;
	if (!paneId) return;
	let seq = 0;
	let queue: Promise<void> = Promise.resolve();
	const on = (
		pi as unknown as {
			on: (event: string, handler: (event: unknown) => void) => void;
		}
	).on.bind(pi);
	const onPromptEvent = (event: UiPromptMarkerEvent, raw: unknown): void => {
		const fields = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
		const data = makeUiPromptMarkerData(event, fields.kind, fields.title);
		if (!data) return;
		seq += 1;
		const current = seq;
		const args = buildUiPromptReportArgs(event, current, paneId, data.title);
		queue = queue.then(() => herdrCliReportMetadata(args)).catch(() => {});
	};
	on('ui_prompt_start', (event) => onPromptEvent('start', event));
	on('ui_prompt_end', (event) => onPromptEvent('end', event));
}
