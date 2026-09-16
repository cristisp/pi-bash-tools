import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const herdrCliReportMetadataMock = vi.hoisted(() => vi.fn());

vi.mock('../src/herdr.ts', () => ({
	herdrCliReportMetadata: herdrCliReportMetadataMock,
}));

import { buildUiPromptReportArgs, registerUiPromptReporter } from '../src/ui-prompt-report.ts';

function makePi() {
	return { on: vi.fn() };
}

function handlers(pi: ReturnType<typeof makePi>) {
	const start = pi.on.mock.calls.find((c) => c[0] === 'ui_prompt_start')?.[1];
	const end = pi.on.mock.calls.find((c) => c[0] === 'ui_prompt_end')?.[1];
	if (!start || !end) throw new Error('report handlers not registered');
	return { start, end } as { start: (event: unknown) => void; end: (event: unknown) => void };
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	herdrCliReportMetadataMock.mockReset();
	herdrCliReportMetadataMock.mockResolvedValue(undefined);
});

describe('buildUiPromptReportArgs', () => {
	it('builds the start vector with the working state label and the pane id last', () => {
		expect(buildUiPromptReportArgs('start', 1, 'ws1:p1')).toEqual([
			'pane',
			'report-metadata',
			'--source',
			'subagent-herdr',
			'--state-label',
			'working=awaiting input',
			'--ttl-ms',
			'1800000',
			'--seq',
			'1',
			'ws1:p1',
		]);
	});

	it('appends the summary token when a title exists', () => {
		expect(buildUiPromptReportArgs('start', 2, 'ws1:p1', 'Allow rm?')).toEqual([
			'pane',
			'report-metadata',
			'--source',
			'subagent-herdr',
			'--state-label',
			'working=awaiting input',
			'--ttl-ms',
			'1800000',
			'--seq',
			'2',
			'--token',
			'summary=Allow rm?',
			'ws1:p1',
		]);
	});

	it('truncates the summary token at 80 chars', () => {
		const args = buildUiPromptReportArgs('start', 1, 'ws1:p1', 'x'.repeat(120));
		const summary = args[args.indexOf('--token') + 1] as string;
		expect(summary).toBe(`summary=${'x'.repeat(80)}`);
		expect(summary.length).toBe(8 + 80);
	});

	it('builds the end clear vector with no ttl', () => {
		expect(buildUiPromptReportArgs('end', 2, 'ws1:p1')).toEqual([
			'pane',
			'report-metadata',
			'--source',
			'subagent-herdr',
			'--clear-state-labels',
			'--clear-token',
			'summary',
			'--seq',
			'2',
			'ws1:p1',
		]);
	});
});

describe('registerUiPromptReporter', () => {
	it('reports the working label plus summary on start and clears on end', async () => {
		const pi = makePi();
		registerUiPromptReporter(pi as unknown as ExtensionAPI, {
			PI_SUBAGENT_NESTED: '1',
			HERDR_PANE_ID: 'ws1:p1',
		});
		const { start, end } = handlers(pi);
		start({ kind: 'select', title: '  Allow rm?  ' });
		end({ kind: 'select' });
		await vi.waitFor(() => expect(herdrCliReportMetadataMock).toHaveBeenCalledTimes(2));
		expect(herdrCliReportMetadataMock).toHaveBeenNthCalledWith(1, [
			'pane',
			'report-metadata',
			'--source',
			'subagent-herdr',
			'--state-label',
			'working=awaiting input',
			'--ttl-ms',
			'1800000',
			'--seq',
			'1',
			'--token',
			'summary=Allow rm?',
			'ws1:p1',
		]);
		expect(herdrCliReportMetadataMock).toHaveBeenNthCalledWith(2, [
			'pane',
			'report-metadata',
			'--source',
			'subagent-herdr',
			'--clear-state-labels',
			'--clear-token',
			'summary',
			'--seq',
			'2',
			'ws1:p1',
		]);
	});

	it('reports a start without a token when the event has no title', async () => {
		const pi = makePi();
		registerUiPromptReporter(pi as unknown as ExtensionAPI, {
			PI_SUBAGENT_NESTED: '1',
			HERDR_PANE_ID: 'ws1:p1',
		});
		const { start } = handlers(pi);
		start({ kind: 'confirm' });
		await vi.waitFor(() => expect(herdrCliReportMetadataMock).toHaveBeenCalledTimes(1));
		const args = herdrCliReportMetadataMock.mock.calls[0][0] as string[];
		expect(args).not.toContain('--token');
		expect(args.at(-1)).toBe('ws1:p1');
	});

	it('increments the seq counter across reports', async () => {
		const pi = makePi();
		registerUiPromptReporter(pi as unknown as ExtensionAPI, {
			PI_SUBAGENT_NESTED: '1',
			HERDR_PANE_ID: 'ws1:p1',
		});
		const { start, end } = handlers(pi);
		start({ kind: 'input' });
		end({ kind: 'input' });
		start({ kind: 'input' });
		await vi.waitFor(() => expect(herdrCliReportMetadataMock).toHaveBeenCalledTimes(3));
		expect(herdrCliReportMetadataMock).toHaveBeenNthCalledWith(
			1,
			expect.arrayContaining(['--seq', '1']),
		);
		expect(herdrCliReportMetadataMock).toHaveBeenNthCalledWith(
			2,
			expect.arrayContaining(['--seq', '2']),
		);
		expect(herdrCliReportMetadataMock).toHaveBeenNthCalledWith(
			3,
			expect.arrayContaining(['--seq', '3']),
		);
	});

	it('serializes reports so an end never overtakes a pending start', async () => {
		const pi = makePi();
		let releaseStart!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		herdrCliReportMetadataMock.mockImplementationOnce(() => gate);
		registerUiPromptReporter(pi as unknown as ExtensionAPI, {
			PI_SUBAGENT_NESTED: '1',
			HERDR_PANE_ID: 'ws1:p1',
		});
		const { start, end } = handlers(pi);
		start({ kind: 'select', title: 'Allow rm?' });
		end({ kind: 'select' });
		await flush();
		expect(herdrCliReportMetadataMock).toHaveBeenCalledTimes(1);
		releaseStart();
		await vi.waitFor(() => expect(herdrCliReportMetadataMock).toHaveBeenCalledTimes(2));
		const second = herdrCliReportMetadataMock.mock.calls[1][0] as string[];
		expect(second).toContain('--clear-state-labels');
	});

	it('ignores malformed events without reporting and without consuming a seq', async () => {
		const pi = makePi();
		registerUiPromptReporter(pi as unknown as ExtensionAPI, {
			PI_SUBAGENT_NESTED: '1',
			HERDR_PANE_ID: 'ws1:p1',
		});
		const { start, end } = handlers(pi);
		start(null);
		start(undefined);
		start({});
		start({ kind: 'nonsense' });
		end({ kind: 'nonsense' });
		await flush();
		expect(herdrCliReportMetadataMock).not.toHaveBeenCalled();
		start({ kind: 'select', title: 'Ok?' });
		await vi.waitFor(() => expect(herdrCliReportMetadataMock).toHaveBeenCalledTimes(1));
		expect(herdrCliReportMetadataMock).toHaveBeenCalledWith(expect.arrayContaining(['--seq', '1']));
	});

	it('never throws and keeps the queue flowing when a spawn rejects', async () => {
		const pi = makePi();
		herdrCliReportMetadataMock.mockRejectedValueOnce(new Error('spawn exploded'));
		registerUiPromptReporter(pi as unknown as ExtensionAPI, {
			PI_SUBAGENT_NESTED: '1',
			HERDR_PANE_ID: 'ws1:p1',
		});
		const { start, end } = handlers(pi);
		expect(() => start({ kind: 'select', title: 'x' })).not.toThrow();
		end({ kind: 'select' });
		await vi.waitFor(() => expect(herdrCliReportMetadataMock).toHaveBeenCalledTimes(2));
	});

	it('registers nothing when the session is not a child', () => {
		const pi = makePi();
		registerUiPromptReporter(pi as unknown as ExtensionAPI, {
			PI_SUBAGENT_NESTED: '0',
			HERDR_PANE_ID: 'ws1:p1',
		});
		expect(pi.on).not.toHaveBeenCalled();
	});

	it('registers nothing when the pane id is missing', () => {
		const pi = makePi();
		registerUiPromptReporter(pi as unknown as ExtensionAPI, { PI_SUBAGENT_NESTED: '1' });
		expect(pi.on).not.toHaveBeenCalled();
	});
});
