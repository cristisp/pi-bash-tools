import { Container, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { renderSubagentCall, renderSubagentResult } from "../render.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SubagentDetails } from "../types.ts";
import { assistantMsg, makeSingleResult } from "./helpers.ts";

function textOf(out: Text | Container): string {
	return (out as unknown as { text?: string }).text ?? "";
}

const theme = {
	fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
	bold: (t: string) => `*${t}*`,
	dim: (t: string) => `~${t}~`,
} as unknown as Theme;

function result(details: SubagentDetails, contentText = "fallback"): AgentToolResult<SubagentDetails> {
	return { content: [{ type: "text", text: contentText }], details };
}

describe("renderSubagentCall", () => {
	it("renders single mode with task preview", () => {
		const text = textOf(renderSubagentCall({ agent: "worker", task: "do the thing" }, theme));
		expect(text).toContain("*subagent *");
		expect(text).toContain("<accent>worker</accent>");
		expect(text).toContain("<muted> [user]</muted>");
		expect(text).toContain("<dim>do the thing</dim>");
	});
	it("truncates long tasks", () => {
		const long = "x".repeat(100);
		const text = textOf(renderSubagentCall({ agent: "worker", task: long }, theme));
		expect(text).toContain("...");
	});
	it("renders chain mode with up to 3 steps", () => {
		const text = textOf(
			renderSubagentCall(
				{ chain: [{ agent: "a1", task: "step 1 {previous}" }, { agent: "a2", task: "step 2" }, { agent: "a3", task: "step 3" }, { agent: "a4", task: "step 4" }] },
				theme,
			),
		);
		expect(text).toContain("chain (4 steps)");
		expect(text).toContain("<accent>a1</accent>");
		expect(text).toContain("... +1 more");
		expect(text).not.toContain("{previous}");
	});
	it("renders parallel mode", () => {
		const text = textOf(renderSubagentCall({ tasks: [{ agent: "a1", task: "t1" }, { agent: "a2", task: "t2" }] }, theme));
		expect(text).toContain("parallel (2 tasks)");
		expect(text).toContain("<accent>a1</accent>");
	});
	it("renders reuse and list modes", () => {
		expect(textOf(renderSubagentCall({ reuseLabel: "worker-1", task: "next" }, theme))).toContain("reuse worker-1");
		expect(textOf(renderSubagentCall({ listSubagents: true }, theme))).toContain("<accent>list</accent>");
	});
	it("shows the agent scope", () => {
		const text = textOf(renderSubagentCall({ agent: "scout", task: "x", agentScope: "project" }, theme));
		expect(text).toContain("[project]");
	});
});

describe("renderSubagentResult", () => {
	it("falls back to content text without details", () => {
		const out = renderSubagentResult({ content: [{ type: "text", text: "plain" }], details: undefined as never }, false, theme);
		expect(out).toBeInstanceOf(Text);
		expect(textOf(out)).toBe("plain");
	});
	it("falls back to content text for empty results", () => {
		const out = renderSubagentResult(result({ mode: "single", agentScope: "user", projectAgentsDir: null, results: [] }, "empty-ish"), false, theme);
		expect(textOf(out)).toBe("empty-ish");
	});
	it("renders a successful single result collapsed", () => {
		const r = makeSingleResult({ label: "worker-1", paneId: "ws1:p1", messages: [], usage: { ...makeSingleResult().usage, turns: 1, input: 10, output: 20, cost: 0.001, contextTokens: 30 } });
		const out = renderSubagentResult(result({ mode: "single", agentScope: "user", projectAgentsDir: null, results: [r] }), false, theme);
		expect(textOf(out)).toContain("<success>✓</success>");
		expect(textOf(out)).toContain("*worker-1*");
		expect(textOf(out)).toContain("pane ws1:p1");
		expect(textOf(out)).toContain("(no output)");
		expect(textOf(out)).toContain("1 turn ↑10 ↓20 $0.0010 ctx:30");
	});
	it("renders a failed single result with stop reason", () => {
		const r = makeSingleResult({ label: "solo-1", exitCode: 1, stopReason: "error", errorMessage: "boom" });
		const out = renderSubagentResult(result({ mode: "single", agentScope: "user", projectAgentsDir: null, results: [r] }), false, theme);
		expect(textOf(out)).toContain("<error>✗</error>");
		expect(textOf(out)).toContain("<error>[error]</error>");
		expect(textOf(out)).toContain("Error: boom");
	});
	it("renders a blocked single result", () => {
		const r = makeSingleResult({ label: "worker-1", paneId: "ws1:p1", herdrStatus: "blocked", blockReason: "approval", blockedPreview: "run?" });
		const out = renderSubagentResult(result({ mode: "single", agentScope: "user", projectAgentsDir: null, results: [r] }), false, theme);
		expect(textOf(out)).toContain("awaiting approval: run?");
	});
	it("renders expanded single results as containers", () => {
		const r = makeSingleResult({ label: "worker-1", task: "do it", messages: [], paneId: "ws1:p1" });
		const out = renderSubagentResult(result({ mode: "single", agentScope: "user", projectAgentsDir: null, results: [r] }), true, theme);
		expect(out).toBeInstanceOf(Container);
	});
	it("renders chain results collapsed with steps and totals", () => {
		const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 3, turns: 1 };
		const results = [
			makeSingleResult({ label: "worker-1", step: 1, usage }),
			makeSingleResult({ label: "reviewer-1", agent: "reviewer", step: 2, usage }),
		];
		const out = renderSubagentResult(result({ mode: "chain", agentScope: "user", projectAgentsDir: null, results }), false, theme);
		expect(textOf(out)).toContain("chain");
		expect(textOf(out)).toContain("2/2 steps");
		expect(textOf(out)).toContain("─── Step 1:");
		expect(textOf(out)).toContain("Total:");
	});
	it("renders chain results expanded as containers", () => {
		const results = [makeSingleResult({ label: "worker-1", step: 1 })];
		const out = renderSubagentResult(result({ mode: "chain", agentScope: "user", projectAgentsDir: null, results }), true, theme);
		expect(out).toBeInstanceOf(Container);
	});
	it("renders parallel results with running placeholders", () => {
		const results = [makeSingleResult({ label: "worker-1", exitCode: -1, herdrStatus: "idle" })];
		const out = renderSubagentResult(result({ mode: "parallel", agentScope: "user", projectAgentsDir: null, results }), false, theme);
		expect(textOf(out)).toContain("⏳");
		expect(textOf(out)).toContain("(settling...)");
	});
	it("renders parallel results expanded once settled", () => {
		const results = [makeSingleResult({ label: "worker-1", exitCode: 0 }), makeSingleResult({ label: "worker-2", exitCode: 1 })];
		const out = renderSubagentResult(result({ mode: "parallel", agentScope: "user", projectAgentsDir: null, results }), true, theme);
		expect(out).toBeInstanceOf(Container);
	});
	it("marks steered results", () => {
		const r = makeSingleResult({ label: "worker-1", steered: true });
		const out = renderSubagentResult(result({ mode: "single", agentScope: "user", projectAgentsDir: null, results: [r] }), false, theme);
		expect(textOf(out)).toContain("[steered]");
	});

	it("renders display items with tool calls", () => {
		const messages = [
			assistantMsg("first line\nsecond line\nthird line\nfourth line"),
			assistantMsg("short", { toolCalls: [{ id: "t1", name: "bash", args: { command: "ls" } }] }),
		];
		const r = makeSingleResult({ label: "worker-1", messages });
		const out = renderSubagentResult(result({ mode: "single", agentScope: "user", projectAgentsDir: null, results: [r] }), false, theme);
		const text = textOf(out);
		expect(text).toContain("$ ");
		expect(text).toContain("ls");
		expect(text).toContain("first line");
		expect(text).not.toContain("fourth line");
	});

	it("truncates many display items in collapsed mode", () => {
		const messages = [];
		for (let i = 0; i < 15; i++) messages.push(assistantMsg(`item ${i}`));
		const r = makeSingleResult({ label: "worker-1", messages });
		const out = renderSubagentResult(result({ mode: "single", agentScope: "user", projectAgentsDir: null, results: [r] }), false, theme);
		const text = textOf(out);
		expect(text).toContain("earlier items");
		expect(text).toContain("item 14");
		expect(text).not.toContain("item 0");
		expect(text).toContain("Ctrl+O to expand");
	});

	it("renders expanded single results with output markdown and pane", () => {
		const r = makeSingleResult({ label: "worker-1", paneId: "ws1:p1", messages: [assistantMsg("final answer")] });
		const out = renderSubagentResult(result({ mode: "single", agentScope: "user", projectAgentsDir: null, results: [r] }), true, theme);
		expect(out).toBeInstanceOf(Container);
	});

	it("renders expanded single errors with blocked info", () => {
		const r = makeSingleResult({
			label: "worker-1",
			paneId: "ws1:p1",
			exitCode: 1,
			errorMessage: "boom",
			herdrStatus: "blocked",
			blockReason: "approval",
			blockedPreview: "run?",
		});
		const out = renderSubagentResult(result({ mode: "single", agentScope: "user", projectAgentsDir: null, results: [r] }), true, theme);
		expect(out).toBeInstanceOf(Container);
	});

	it("renders blocked chain steps expanded", () => {
		const r = makeSingleResult({
			label: "worker-1",
			paneId: "ws1:p1",
			step: 2,
			herdrStatus: "blocked",
			blockReason: "steer",
			blockedSince: Date.now(),
		});
		const out = renderSubagentResult(result({ mode: "chain", agentScope: "user", projectAgentsDir: null, results: [r] }), true, theme);
		expect(out).toBeInstanceOf(Container);
	});

	it("renders parallel live states", () => {
		const blocked = makeSingleResult({ label: "worker-1", exitCode: -1, herdrStatus: "blocked" });
		const out1 = renderSubagentResult(result({ mode: "parallel", agentScope: "user", projectAgentsDir: null, results: [blocked] }), false, theme);
		expect(textOf(out1)).toContain("⚠");
		const running = makeSingleResult({ label: "worker-1", exitCode: -1, herdrStatus: "working" });
		const out2 = renderSubagentResult(result({ mode: "parallel", agentScope: "user", projectAgentsDir: null, results: [running] }), false, theme);
		expect(textOf(out2)).toContain("(running...)");
		const done = makeSingleResult({ label: "worker-1", exitCode: 0, herdrStatus: "done" });
		const out3 = renderSubagentResult(result({ mode: "parallel", agentScope: "user", projectAgentsDir: null, results: [done] }), false, theme);
		expect(textOf(out3)).toContain("(no output)");
	});

	it("falls back to content for unknown modes", () => {
		const out = renderSubagentResult({ content: [{ type: "text", text: "mystery" }], details: { mode: "mystery" as never, agentScope: "user", projectAgentsDir: null, results: [makeSingleResult()] } }, false, theme);
		expect(textOf(out)).toBe("mystery");
	});

	it("falls back to no output for non-text content", () => {
		const out = renderSubagentResult({ content: [{ type: "image", url: "x" }] as never, details: undefined as never }, false, theme);
		expect(textOf(out)).toBe("(no output)");
	});
});
