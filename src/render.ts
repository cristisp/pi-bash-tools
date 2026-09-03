import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { getMarkdownTheme, type Theme } from '@earendil-works/pi-coding-agent';
import { Container, Markdown, Spacer, Text, type MarkdownTheme } from '@earendil-works/pi-tui';
import type { AgentScope } from './agents.ts';
import type { SubagentParams } from './execute.ts';
import {
	blockedSummaryLine,
	formatExecutionMetrics,
	formatToolCall,
	formatTokens,
	formatUsageStats,
	getDisplayItems,
	getFinalOutput,
	isFailedResult,
} from './format.ts';
import { findEntry } from './registry.ts';
import type { DisplayItem, RegistryEntry, SingleResult, SubagentDetails } from './types.ts';

const COLLAPSED_ITEM_COUNT = 10;
const HIGH_CONTEXT_WARN = 100_000;

function renderDisplayItems(
	items: DisplayItem[],
	limit: number | undefined,
	expanded: boolean,
	theme: Theme,
): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = '';
	if (skipped > 0) text += theme.fg('muted', `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === 'text') {
			const preview = expanded ? item.text : item.text.split('\n').slice(0, 3).join('\n');
			text += `${theme.fg('toolOutput', preview)}\n`;
		} else {
			text += `${theme.fg('muted', '→ ') + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
		}
	}
	return text.trimEnd();
}

function aggregateUsage(results: SingleResult[]): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
} {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

function resultIcon(r: SingleResult, theme: Theme): string {
	return r.herdrStatus === 'blocked'
		? theme.fg('warning', '⏸')
		: r.exitCode === 0
			? theme.fg('success', '✓')
			: theme.fg('error', '✗');
}

function parallelItemIcon(r: SingleResult, theme: Theme): string {
	if (r.exitCode === -1) {
		return r.herdrStatus === 'blocked' ? theme.fg('warning', '⚠') : theme.fg('warning', '⏳');
	}
	return isFailedResult(r) ? theme.fg('error', '✗') : theme.fg('success', '✓');
}

function parallelEmptyText(r: SingleResult): string {
	if (r.exitCode === -1) {
		return r.herdrStatus === 'idle' || r.herdrStatus === 'done' ? '(settling...)' : '(running...)';
	}
	return '(no output)';
}

function singleHeaderText(
	icon: string,
	displayName: string,
	r: SingleResult,
	theme: Theme,
	isError: boolean,
): string {
	let header = `${icon} ${theme.fg('toolTitle', theme.bold(displayName))}${theme.fg('muted', ` (${r.agentSource})`)}`;
	const identity: string[] = [];
	if (r.delegationId) identity.push(`delegation:${r.delegationId}`);
	if (typeof r.tier === 'number') identity.push(`tier:${r.tier}`);
	if (identity.length > 0) header += ` ${theme.fg('dim', `[${identity.join(' ')}]`)}`;
	if (r.steered) header += ` ${theme.fg('warning', '[steered]')}`;
	if (isError && r.stopReason) header += ` ${theme.fg('error', `[${r.stopReason}]`)}`;
	return header;
}

function callIdentityMeta(args: SubagentParams, theme: Theme): string {
	const identity: string[] = [];
	if (typeof args.tier === 'number') identity.push(`tier:${args.tier}`);
	if (args.taskId) identity.push(`task:${args.taskId}`);
	if (args.workflowMode) identity.push(`mode:${args.workflowMode}`);
	if (args.reviewMode) identity.push(`review:${args.reviewMode}`);
	return identity.length > 0 ? ` ${theme.fg('dim', `[${identity.join(' ')}]`)}` : '';
}

function resultAttribution(r: SingleResult, theme: Theme): string | null {
	const parts: string[] = [];
	if (r.parentPaneId) parts.push(`parent pane ${r.parentPaneId}`);
	if (r.rootSession) parts.push(`root session ${r.rootSession}`);
	if (r.scope?.paths?.length) parts.push(`scope ${r.scope.paths.join(',')}`);
	if (r.scope?.hunks?.length) parts.push(`hunks ${r.scope.hunks.join(',')}`);
	if (r.scope?.outOfScope?.length) parts.push(`out of scope ${r.scope.outOfScope.join(',')}`);
	if (r.reviewSurfacePath) parts.push(`surface ${r.reviewSurfacePath}`);
	const manifestPath = r.readManifest?.persistedPath ?? r.readManifest?.manifestPath;
	if (manifestPath) parts.push(`manifest ${manifestPath}`);
	return parts.length > 0 ? theme.fg('muted', parts.join('  ')) : null;
}

function addToolCallItems(container: Container, displayItems: DisplayItem[], theme: Theme): void {
	for (const item of displayItems) {
		if (item.type === 'toolCall') {
			container.addChild(
				new Text(
					theme.fg('muted', '→ ') + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
					0,
					0,
				),
			);
		}
	}
}

function addItemsAndOutput(
	container: Container,
	displayItems: DisplayItem[],
	finalOutput: string,
	theme: Theme,
	mdTheme: MarkdownTheme,
): void {
	addToolCallItems(container, displayItems, theme);
	if (finalOutput) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
	}
}

function resultErrorText(r: SingleResult): string | null {
	if (r.errorMessage) return r.errorMessage;
	if (r.exitCode !== 0 && r.stderr) return r.stderr;
	return null;
}

function addErrorBlock(container: Container, r: SingleResult, theme: Theme): void {
	const errText = resultErrorText(r);
	if (errText) container.addChild(new Text(theme.fg('error', errText), 0, 0));
}

function addExpandedResultBlock(
	container: Container,
	r: SingleResult,
	heading: string,
	theme: Theme,
	mdTheme: MarkdownTheme,
	showBlocked: boolean,
): void {
	const displayItems = getDisplayItems(r.messages);
	const finalOutput = getFinalOutput(r.messages);
	container.addChild(new Spacer(1));
	container.addChild(new Text(heading, 0, 0));
	container.addChild(new Text(theme.fg('muted', 'Task: ') + theme.fg('dim', r.task), 0, 0));
	addErrorBlock(container, r, theme);
	if (showBlocked && r.herdrStatus === 'blocked')
		container.addChild(new Text(theme.fg('warning', blockedSummaryLine(r)), 0, 0));
	addItemsAndOutput(container, displayItems, finalOutput, theme, mdTheme);
	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) container.addChild(new Text(theme.fg('dim', usageStr), 0, 0));
	if (r.metrics)
		container.addChild(new Text(theme.fg('dim', formatExecutionMetrics(r.metrics)), 0, 0));
	if (r.budget)
		container.addChild(
			new Text(
				theme.fg('dim', `budget:${r.budget.outcome} breaches:${r.budget.breaches.length}`),
				0,
			),
		);
}

function addUsageTotal(container: Container, results: SingleResult[], theme: Theme): void {
	const usageStr = formatUsageStats(aggregateUsage(results));
	if (usageStr) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg('dim', `Total: ${usageStr}`), 0, 0));
	}
}

function renderChainCall(args: SubagentParams, scope: AgentScope, theme: Theme): Text {
	let text =
		theme.fg('toolTitle', theme.bold('subagent ')) +
		theme.fg('accent', `chain (${args.chain!.length} steps)`) +
		theme.fg('muted', ` [${scope}]`) +
		callIdentityMeta(args, theme);
	for (let i = 0; i < Math.min(args.chain!.length, 3); i++) {
		const step = args.chain![i];
		const cleanTask = step.task.replace(/\{previous\}/g, '').trim();
		const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
		text +=
			'\n  ' +
			theme.fg('muted', `${i + 1}.`) +
			' ' +
			theme.fg('accent', step.agent) +
			theme.fg('dim', ` ${preview}`);
	}
	if (args.chain!.length > 3)
		text += `\n  ${theme.fg('muted', `... +${args.chain!.length - 3} more`)}`;
	return new Text(text, 0, 0);
}

function renderParallelCall(args: SubagentParams, scope: AgentScope, theme: Theme): Text {
	let text =
		theme.fg('toolTitle', theme.bold('subagent ')) +
		theme.fg('accent', `parallel (${args.tasks!.length} tasks)`) +
		theme.fg('muted', ` [${scope}]`) +
		callIdentityMeta(args, theme);
	for (const t of args.tasks!.slice(0, 3)) {
		const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
		text += `\n  ${theme.fg('accent', t.agent)}${theme.fg('dim', ` ${preview}`)}`;
	}
	if (args.tasks!.length > 3)
		text += `\n  ${theme.fg('muted', `... +${args.tasks!.length - 3} more`)}`;
	return new Text(text, 0, 0);
}

function reuseMetaParts(entry: RegistryEntry | undefined, theme: Theme): string {
	if (!entry) return '';
	const parts: string[] = [];
	if (entry.contextTokens && entry.contextTokens > 0) {
		const ctx = `ctx:${formatTokens(entry.contextTokens)}`;
		parts.push(
			entry.contextTokens >= HIGH_CONTEXT_WARN ? theme.fg('warning', ctx) : theme.fg('dim', ctx),
		);
	}
	if (entry.reuseCount && entry.reuseCount > 0) {
		parts.push(theme.fg('dim', `reused ${entry.reuseCount}x`));
	}
	if (entry.tasks && entry.tasks.length > 0) {
		parts.push(
			theme.fg('dim', `${entry.tasks.length} task${entry.tasks.length > 1 ? 's' : ''} so far`),
		);
	}
	return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function renderReuseCall(args: SubagentParams, scope: AgentScope, theme: Theme): Text {
	const preview = args.task
		? args.task.length > 60
			? `${args.task.slice(0, 60)}...`
			: args.task
		: '...';
	return new Text(
		theme.fg('toolTitle', theme.bold('subagent ')) +
			theme.fg('accent', `reuse ${args.reuseLabel}`) +
			theme.fg('muted', ` [${scope}]`) +
			callIdentityMeta(args, theme) +
			reuseMetaParts(findEntry(args.reuseLabel!), theme) +
			`\n  ${theme.fg('dim', preview)}`,
		0,
		0,
	);
}

function renderListCall(scope: AgentScope, theme: Theme): Text {
	return new Text(
		theme.fg('toolTitle', theme.bold('subagent ')) +
			theme.fg('accent', 'list') +
			theme.fg('muted', ` [${scope}]`),
		0,
		0,
	);
}

function renderAgentsCall(scope: AgentScope, theme: Theme): Text {
	return new Text(
		theme.fg('toolTitle', theme.bold('subagent ')) +
			theme.fg('accent', 'agents') +
			theme.fg('muted', ` [${scope}]`),
		0,
		0,
	);
}

function renderSingleCall(args: SubagentParams, scope: AgentScope, theme: Theme): Text {
	const agentName = args.agent || '...';
	const preview = args.task
		? args.task.length > 60
			? `${args.task.slice(0, 60)}...`
			: args.task
		: '...';
	let text =
		theme.fg('toolTitle', theme.bold('subagent ')) +
		theme.fg('accent', agentName) +
		theme.fg('muted', ` [${scope}]`) +
		callIdentityMeta(args, theme);
	text += `\n  ${theme.fg('dim', preview)}`;
	return new Text(text, 0, 0);
}

export function renderSubagentCall(args: SubagentParams, theme: Theme): Text {
	const scope: AgentScope = args.agentScope ?? 'user';
	if (args.chain && args.chain.length > 0) return renderChainCall(args, scope, theme);
	if (args.tasks && args.tasks.length > 0) return renderParallelCall(args, scope, theme);
	if (args.reuseLabel) return renderReuseCall(args, scope, theme);
	if (args.listSubagents) return renderListCall(scope, theme);
	if (args.agents) return renderAgentsCall(scope, theme);
	return renderSingleCall(args, scope, theme);
}

function addOutputBlock(
	container: Container,
	displayItems: DisplayItem[],
	finalOutput: string,
	theme: Theme,
	mdTheme: MarkdownTheme,
): void {
	if (displayItems.length === 0 && !finalOutput) {
		container.addChild(new Text(theme.fg('muted', '(no output)'), 0, 0));
		return;
	}
	addItemsAndOutput(container, displayItems, finalOutput, theme, mdTheme);
}

function renderSingleExpanded(
	r: SingleResult,
	icon: string,
	theme: Theme,
	mdTheme: MarkdownTheme,
): Container {
	const container = new Container();
	const displayItems = getDisplayItems(r.messages);
	const finalOutput = getFinalOutput(r.messages);
	const isError = isFailedResult(r);
	const displayName = r.label ?? r.agent;
	container.addChild(new Text(singleHeaderText(icon, displayName, r, theme, isError), 0, 0));
	addErrorBlock(container, r, theme);
	if (r.herdrStatus === 'blocked')
		container.addChild(new Text(theme.fg('warning', blockedSummaryLine(r)), 0, 0));
	if (r.paneId) container.addChild(new Text(theme.fg('muted', `pane ${r.paneId}`), 0, 0));
	const attribution = resultAttribution(r, theme);
	if (attribution) container.addChild(new Text(attribution, 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg('muted', '─── Task ───'), 0, 0));
	container.addChild(new Text(theme.fg('dim', r.task), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg('muted', '─── Output ───'), 0, 0));
	addOutputBlock(container, displayItems, finalOutput, theme, mdTheme);
	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg('dim', usageStr), 0, 0));
	}
	return container;
}

function renderSingleResult(
	r: SingleResult,
	expanded: boolean,
	theme: Theme,
	mdTheme: MarkdownTheme,
): Text | Container {
	const isError = isFailedResult(r);
	const icon = isError ? theme.fg('error', '✗') : theme.fg('success', '✓');
	const displayItems = getDisplayItems(r.messages);
	const displayName = r.label ?? r.agent;

	if (expanded) {
		return renderSingleExpanded(r, icon, theme, mdTheme);
	}

	let text = singleHeaderText(icon, displayName, r, theme, isError);
	const errText = resultErrorText(r);
	if (errText) text += `\n${theme.fg('error', errText)}`;
	else if (r.herdrStatus === 'blocked') text += `\n${theme.fg('warning', blockedSummaryLine(r))}`;
	else if (displayItems.length === 0) text += `\n${theme.fg('muted', '(no output)')}`;
	else {
		text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT, expanded, theme)}`;
		if (displayItems.length > COLLAPSED_ITEM_COUNT)
			text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`;
	}
	if (r.paneId) text += `\n${theme.fg('muted', `pane ${r.paneId}`)}`;
	const attribution = resultAttribution(r, theme);
	if (attribution) text += `\n${attribution}`;
	if (r.budget)
		text += `\n${theme.fg('dim', `budget:${r.budget.outcome} breaches:${r.budget.breaches.length}`)}`;
	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) text += `\n${theme.fg('dim', usageStr)}`;
	if (r.metrics) text += `\n${theme.fg('dim', formatExecutionMetrics(r.metrics))}`;
	return new Text(text, 0, 0);
}

function chainSummary(results: SingleResult[], theme: Theme): string {
	const successCount = results.filter((r) => r.exitCode === 0).length;
	const hasBlocked = results.some((r) => r.herdrStatus === 'blocked');
	const hasFailed = results.some((r) => r.exitCode !== 0 && r.herdrStatus !== 'blocked');
	const icon =
		hasBlocked && !hasFailed
			? theme.fg('warning', '⏸')
			: successCount === results.length
				? theme.fg('success', '✓')
				: theme.fg('error', '✗');
	return (
		icon +
		' ' +
		theme.fg('toolTitle', theme.bold('chain ')) +
		theme.fg('accent', `${successCount}/${results.length} steps`)
	);
}

function renderChainExpanded(
	results: SingleResult[],
	theme: Theme,
	mdTheme: MarkdownTheme,
): Container {
	const container = new Container();
	container.addChild(new Text(chainSummary(results, theme), 0, 0));
	for (const r of results) {
		const rIcon = resultIcon(r, theme);
		const displayName = r.label ?? r.agent;
		addExpandedResultBlock(
			container,
			r,
			`${theme.fg('muted', `─── Step ${r.step}: `) + theme.fg('accent', displayName)} ${rIcon}`,
			theme,
			mdTheme,
			true,
		);
	}
	addUsageTotal(container, results, theme);
	return container;
}

function renderChainResult(
	results: SingleResult[],
	expanded: boolean,
	theme: Theme,
	mdTheme: MarkdownTheme,
): Text | Container {
	if (expanded) {
		return renderChainExpanded(results, theme, mdTheme);
	}

	let text = chainSummary(results, theme);
	for (const r of results) {
		const rIcon = resultIcon(r, theme);
		const displayItems = getDisplayItems(r.messages);
		const displayName = r.label ?? r.agent;
		text += `\n\n${theme.fg('muted', `─── Step ${r.step}: `)}${theme.fg('accent', displayName)} ${rIcon}`;
		if (r.herdrStatus === 'blocked') text += `\n${theme.fg('warning', blockedSummaryLine(r))}`;
		if (displayItems.length === 0) text += `\n${theme.fg('muted', '(no output)')}`;
		else text += `\n${renderDisplayItems(displayItems, 5, expanded, theme)}`;
	}
	const usageStr = formatUsageStats(aggregateUsage(results));
	if (usageStr) text += `\n\n${theme.fg('dim', `Total: ${usageStr}`)}`;
	text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`;
	return new Text(text, 0, 0);
}

function parallelSummary(results: SingleResult[], theme: Theme): string {
	const running = results.filter((r) => r.exitCode === -1).length;
	const successCount = results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
	const failCount = results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
	const isRunning = running > 0;
	const icon = isRunning
		? theme.fg('warning', '⏳')
		: failCount > 0
			? theme.fg('warning', '◐')
			: theme.fg('success', '✓');
	const status = isRunning
		? `${successCount + failCount}/${results.length} done, ${running} running`
		: `${successCount}/${results.length} tasks`;
	return `${icon} ${theme.fg('toolTitle', theme.bold('parallel '))}${theme.fg('accent', status)}`;
}

function renderParallelExpanded(
	results: SingleResult[],
	theme: Theme,
	mdTheme: MarkdownTheme,
): Container {
	const container = new Container();
	container.addChild(new Text(parallelSummary(results, theme), 0, 0));
	for (const r of results) {
		const rIcon = isFailedResult(r) ? theme.fg('error', '✗') : theme.fg('success', '✓');
		const displayName = r.label ?? r.agent;
		addExpandedResultBlock(
			container,
			r,
			`${theme.fg('muted', '─── ') + theme.fg('accent', displayName)}${r.steered ? ` ${theme.fg('warning', '[steered]')}` : ''} ${rIcon}`,
			theme,
			mdTheme,
			false,
		);
	}
	addUsageTotal(container, results, theme);
	return container;
}

function renderParallelCollapsed(results: SingleResult[], expanded: boolean, theme: Theme): Text {
	let text = parallelSummary(results, theme);
	for (const r of results) {
		const rIcon = parallelItemIcon(r, theme);
		const displayItems = getDisplayItems(r.messages);
		const displayName = r.label ?? r.agent;
		text += `\n\n${theme.fg('muted', '─── ')}${theme.fg('accent', displayName)}${r.steered ? ` ${theme.fg('warning', '[steered]')}` : ''} ${rIcon}`;
		if (r.herdrStatus === 'blocked') {
			text += `\n${theme.fg('warning', blockedSummaryLine(r))}`;
		} else if (displayItems.length === 0) {
			text += `\n${theme.fg('muted', parallelEmptyText(r))}`;
		} else text += `\n${renderDisplayItems(displayItems, 5, expanded, theme)}`;
	}
	const isRunning = results.some((r) => r.exitCode === -1);
	if (!isRunning) {
		const usageStr = formatUsageStats(aggregateUsage(results));
		if (usageStr) text += `\n\n${theme.fg('dim', `Total: ${usageStr}`)}`;
	}
	if (!expanded) text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`;
	return new Text(text, 0, 0);
}

function renderParallelResult(
	results: SingleResult[],
	expanded: boolean,
	theme: Theme,
	mdTheme: MarkdownTheme,
): Text | Container {
	const isRunning = results.some((r) => r.exitCode === -1);
	if (expanded && !isRunning) {
		return renderParallelExpanded(results, theme, mdTheme);
	}
	return renderParallelCollapsed(results, expanded, theme);
}

export function renderSubagentResult(
	result: AgentToolResult<SubagentDetails>,
	expanded: boolean,
	theme: Theme,
): Text | Container {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === 'text' ? text.text : '(no output)', 0, 0);
	}

	const mdTheme = getMarkdownTheme();

	if (details.mode === 'single' && details.results.length === 1) {
		return renderSingleResult(details.results[0], expanded, theme, mdTheme);
	}

	if (details.mode === 'chain') {
		return renderChainResult(details.results, expanded, theme, mdTheme);
	}

	if (details.mode === 'parallel') {
		return renderParallelResult(details.results, expanded, theme, mdTheme);
	}

	const text = result.content[0];
	return new Text(text?.type === 'text' ? text.text : '(no output)', 0, 0);
}
