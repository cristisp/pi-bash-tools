import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { AgentScope } from "./agents.ts";
import type { SubagentParams } from "./execute.ts";
import {
	blockedSummaryLine,
	formatToolCall,
	formatUsageStats,
	getDisplayItems,
	getFinalOutput,
	isFailedResult,
} from "./format.ts";
import type { DisplayItem, SingleResult, SubagentDetails } from "./types.ts";

const COLLAPSED_ITEM_COUNT = 10;

function renderDisplayItems(
	items: DisplayItem[],
	limit: number | undefined,
	expanded: boolean,
	theme: Theme,
): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
		} else {
			text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
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
	return r.herdrStatus === "blocked"
		? theme.fg("warning", "⏸")
		: r.exitCode === 0
			? theme.fg("success", "✓")
			: theme.fg("error", "✗");
}

function parallelItemIcon(r: SingleResult, theme: Theme): string {
	if (r.exitCode === -1) {
		return r.herdrStatus === "blocked" ? theme.fg("warning", "⚠") : theme.fg("warning", "⏳");
	}
	return isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function parallelEmptyText(r: SingleResult): string {
	if (r.exitCode === -1) {
		return r.herdrStatus === "idle" || r.herdrStatus === "done" ? "(settling...)" : "(running...)";
	}
	return "(no output)";
}

function singleHeaderText(icon: string, displayName: string, r: SingleResult, theme: Theme, isError: boolean): string {
	let header = `${icon} ${theme.fg("toolTitle", theme.bold(displayName))}${theme.fg("muted", ` (${r.agentSource})`)}`;
	if (r.steered) header += ` ${theme.fg("warning", "[steered]")}`;
	if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	return header;
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
	container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
	if (showBlocked && r.herdrStatus === "blocked")
		container.addChild(new Text(theme.fg("warning", blockedSummaryLine(r)), 0, 0));
	for (const item of displayItems) {
		if (item.type === "toolCall") {
			container.addChild(
				new Text(
					theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
					0,
					0,
				),
			);
		}
	}
	if (finalOutput) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
	}
	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
}

function addUsageTotal(container: Container, results: SingleResult[], theme: Theme): void {
	const usageStr = formatUsageStats(aggregateUsage(results));
	if (usageStr) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
	}
}

function renderChainCall(args: SubagentParams, scope: AgentScope, theme: Theme): Text {
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", `chain (${args.chain!.length} steps)`) +
		theme.fg("muted", ` [${scope}]`);
	for (let i = 0; i < Math.min(args.chain!.length, 3); i++) {
		const step = args.chain![i];
		const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
		const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
		text +=
			"\n  " +
			theme.fg("muted", `${i + 1}.`) +
			" " +
			theme.fg("accent", step.agent) +
			theme.fg("dim", ` ${preview}`);
	}
	if (args.chain!.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain!.length - 3} more`)}`;
	return new Text(text, 0, 0);
}

function renderParallelCall(args: SubagentParams, scope: AgentScope, theme: Theme): Text {
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", `parallel (${args.tasks!.length} tasks)`) +
		theme.fg("muted", ` [${scope}]`);
	for (const t of args.tasks!.slice(0, 3)) {
		const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
		text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
	}
	if (args.tasks!.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks!.length - 3} more`)}`;
	return new Text(text, 0, 0);
}

function renderReuseCall(args: SubagentParams, scope: AgentScope, theme: Theme): Text {
	const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
	return new Text(
		theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `reuse ${args.reuseLabel}`) +
			theme.fg("muted", ` [${scope}]`) +
			`\n  ${theme.fg("dim", preview)}`,
		0,
		0,
	);
}

function renderListCall(scope: AgentScope, theme: Theme): Text {
	return new Text(
		theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", "list") + theme.fg("muted", ` [${scope}]`),
		0,
		0,
	);
}

function renderSingleCall(args: SubagentParams, scope: AgentScope, theme: Theme): Text {
	const agentName = args.agent || "...";
	const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", agentName) +
		theme.fg("muted", ` [${scope}]`);
	text += `\n  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

export function renderSubagentCall(args: SubagentParams, theme: Theme): Text {
	const scope: AgentScope = args.agentScope ?? "user";
	if (args.chain && args.chain.length > 0) return renderChainCall(args, scope, theme);
	if (args.tasks && args.tasks.length > 0) return renderParallelCall(args, scope, theme);
	if (args.reuseLabel) return renderReuseCall(args, scope, theme);
	if (args.listSubagents) return renderListCall(scope, theme);
	return renderSingleCall(args, scope, theme);
}

// fallow-ignore-next-line complexity
function renderSingleResult(
	r: SingleResult,
	expanded: boolean,
	theme: Theme,
	mdTheme: MarkdownTheme,
): Text | Container {
	const isError = isFailedResult(r);
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const displayItems = getDisplayItems(r.messages);
	const finalOutput = getFinalOutput(r.messages);
	const displayName = r.label ?? r.agent;

	if (expanded) {
		const container = new Container();
		const header = singleHeaderText(icon, displayName, r, theme, isError);
		container.addChild(new Text(header, 0, 0));
		if (isError && r.errorMessage)
			container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
		if (r.herdrStatus === "blocked")
			container.addChild(new Text(theme.fg("warning", blockedSummaryLine(r)), 0, 0));
		if (r.paneId) container.addChild(new Text(theme.fg("muted", `pane ${r.paneId}`), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
		if (displayItems.length === 0 && !finalOutput) {
			container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
		} else {
			for (const item of displayItems) {
				if (item.type === "toolCall")
					container.addChild(
						new Text(
							theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
							0,
							0,
						),
					);
			}
			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}
		}
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
		}
		return container;
	}

	let text = singleHeaderText(icon, displayName, r, theme, isError);
	if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
	else if (r.herdrStatus === "blocked") text += `\n${theme.fg("warning", blockedSummaryLine(r))}`;
	else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
	else {
		text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT, expanded, theme)}`;
		if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	if (r.paneId) text += `\n${theme.fg("muted", `pane ${r.paneId}`)}`;
	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
	return new Text(text, 0, 0);
}

// fallow-ignore-next-line complexity
function renderChainResult(
	results: SingleResult[],
	expanded: boolean,
	theme: Theme,
	mdTheme: MarkdownTheme,
): Text | Container {
	const successCount = results.filter((r) => r.exitCode === 0).length;
	const hasBlocked = results.some((r) => r.herdrStatus === "blocked");
	const hasFailed = results.some((r) => r.exitCode !== 0 && r.herdrStatus !== "blocked");
	const icon =
		hasBlocked && !hasFailed
			? theme.fg("warning", "⏸")
			: successCount === results.length
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");

	if (expanded) {
		const container = new Container();
		container.addChild(
			new Text(
				icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${results.length} steps`),
				0,
				0,
			),
		);

		for (const r of results) {
			const rIcon = resultIcon(r, theme);
			const displayName = r.label ?? r.agent;
			addExpandedResultBlock(
				container,
				r,
				`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", displayName)} ${rIcon}`,
				theme,
				mdTheme,
				true,
			);
		}

		addUsageTotal(container, results, theme);
		return container;
	}

	let text =
		icon +
		" " +
		theme.fg("toolTitle", theme.bold("chain ")) +
		theme.fg("accent", `${successCount}/${results.length} steps`);
	for (const r of results) {
		const rIcon = resultIcon(r, theme);
		const displayItems = getDisplayItems(r.messages);
		const displayName = r.label ?? r.agent;
		text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", displayName)} ${rIcon}`;
		if (r.herdrStatus === "blocked") text += `\n${theme.fg("warning", blockedSummaryLine(r))}`;
		if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
		else text += `\n${renderDisplayItems(displayItems, 5, expanded, theme)}`;
	}
	const usageStr = formatUsageStats(aggregateUsage(results));
	if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

// fallow-ignore-next-line complexity
function renderParallelResult(
	results: SingleResult[],
	expanded: boolean,
	theme: Theme,
	mdTheme: MarkdownTheme,
): Text | Container {
	const running = results.filter((r) => r.exitCode === -1).length;
	const successCount = results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
	const failCount = results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
	const isRunning = running > 0;
	const icon = isRunning
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");
	const status = isRunning
		? `${successCount + failCount}/${results.length} done, ${running} running`
		: `${successCount}/${results.length} tasks`;

	if (expanded && !isRunning) {
		const container = new Container();
		container.addChild(
			new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
				0,
				0,
			),
		);

		for (const r of results) {
			const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const displayName = r.label ?? r.agent;
			addExpandedResultBlock(
				container,
				r,
				`${theme.fg("muted", "─── ") + theme.fg("accent", displayName)}${r.steered ? ` ${theme.fg("warning", "[steered]")}` : ""} ${rIcon}`,
				theme,
				mdTheme,
				false,
			);
		}

		addUsageTotal(container, results, theme);
		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
	for (const r of results) {
		const rIcon = parallelItemIcon(r, theme);
		const displayItems = getDisplayItems(r.messages);
		const displayName = r.label ?? r.agent;
		text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", displayName)}${r.steered ? ` ${theme.fg("warning", "[steered]")}` : ""} ${rIcon}`;
		if (r.herdrStatus === "blocked") {
			text += `\n${theme.fg("warning", blockedSummaryLine(r))}`;
		} else if (displayItems.length === 0) {
			text += `\n${theme.fg("muted", parallelEmptyText(r))}`;
		} else text += `\n${renderDisplayItems(displayItems, 5, expanded, theme)}`;
	}
	if (!isRunning) {
		const usageStr = formatUsageStats(aggregateUsage(results));
		if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
	}
	if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

export function renderSubagentResult(
	result: AgentToolResult<SubagentDetails>,
	expanded: boolean,
	theme: Theme,
): Text | Container {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();

	if (details.mode === "single" && details.results.length === 1) {
		return renderSingleResult(details.results[0], expanded, theme, mdTheme);
	}

	if (details.mode === "chain") {
		return renderChainResult(details.results, expanded, theme, mdTheme);
	}

	if (details.mode === "parallel") {
		return renderParallelResult(details.results, expanded, theme, mdTheme);
	}

	const text = result.content[0];
	return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
}
