import { describe, expect, it } from "vitest";
import { AGENT_TEMPLATES, isValidModelSpec, normalizeModelSpec, renderAgentFile } from "../templates.ts";

describe("isValidModelSpec", () => {
	it("accepts provider/model specs", () => {
		expect(isValidModelSpec("github-copilot/gpt-5.6-luna")).toBe(true);
		expect(isValidModelSpec("cortecs/deepseek-v4-flash-0731")).toBe(true);
	});
	it("accepts thinking levels case-insensitively", () => {
		expect(isValidModelSpec("provider/model:high")).toBe(true);
		expect(isValidModelSpec("provider/model:High")).toBe(true);
		expect(isValidModelSpec("provider/model:off")).toBe(true);
		expect(isValidModelSpec("provider/model:max")).toBe(true);
	});
	it("rejects unknown levels and malformed specs", () => {
		expect(isValidModelSpec("provider/model:ultra")).toBe(false);
		expect(isValidModelSpec("no-slash")).toBe(false);
		expect(isValidModelSpec("/missing-provider")).toBe(false);
		expect(isValidModelSpec("provider/")).toBe(false);
		expect(isValidModelSpec("")).toBe(false);
		expect(isValidModelSpec("provider/model:")).toBe(false);
	});
});

describe("normalizeModelSpec", () => {
	it("lowercases valid thinking levels", () => {
		expect(normalizeModelSpec("p/m:HIGH")).toBe("p/m:high");
		expect(normalizeModelSpec("p/m:Low")).toBe("p/m:low");
	});
	it("leaves specs without levels untouched", () => {
		expect(normalizeModelSpec("p/m")).toBe("p/m");
	});
	it("trims whitespace", () => {
		expect(normalizeModelSpec("  p/m:high  ")).toBe("p/m:high");
	});
});

describe("renderAgentFile", () => {
	it("renders frontmatter with name, description, tools, and model", () => {
		const out = renderAgentFile(AGENT_TEMPLATES[0], "test-model:high");
		expect(out).toContain("---");
		expect(out).toContain("name: planner");
		expect(out).toContain("description: Creates implementation plans from context and requirements");
		expect(out).toContain("tools: read, grep, find, codegraph_explore, codegraph_sync");
		expect(out).toContain("model: test-model:high");
		expect(out).toContain("## Goal");
	});
	it("omits tools when the template has none", () => {
		const out = renderAgentFile({ filename: "x.md", name: "x", description: "d", body: "body text" }, "m");
		expect(out).not.toContain("tools:");
		expect(out).toContain("body text");
	});
	it("produces parseable frontmatter for every template", () => {
		for (const t of AGENT_TEMPLATES) {
			const out = renderAgentFile(t, "m:high");
			expect(out.startsWith("---\n")).toBe(true);
			expect(out).toContain(`name: ${t.name}`);
			expect(out).toContain(`description: ${t.description}`);
			expect(out).toMatch(/model: m:high\n---/);
		}
	});
});
