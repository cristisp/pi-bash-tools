import { describe, expect, it } from "vitest";

import {
  boundProjectCommandText,
  projectCommandDiagnostic,
  PROJECT_COMMAND_DIAGNOSTIC_MAX_CHARS,
  sanitizeProjectCommandText,
} from "../../src/tools/project-command/diagnostics.ts";
import type { ProjectCommandOutput } from "../../src/tools/project-command/execution.ts";

function output(text: string): ProjectCommandOutput {
  return {
    text,
    truncated: false,
    totalBytes: Buffer.byteLength(text),
    totalLines: text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length,
  };
}

describe("project command diagnostics", () => {
  it("normalizes carriage returns and strips controls before bounding text", () => {
    expect(sanitizeProjectCommandText("first\r\nsecond\rthird\u0000\u007f")).toBe(
      "first\nsecond\nthird",
    );

    const bounded = boundProjectCommandText(`\u001b[31m${"x".repeat(2_500)}\u001b[0m`);
    expect(bounded).toHaveLength(PROJECT_COMMAND_DIAGNOSTIC_MAX_CHARS);
    expect(bounded).toBe(`${"x".repeat(PROJECT_COMMAND_DIAGNOSTIC_MAX_CHARS - 3)}...`);
  });

  it("prefers meaningful stderr and removes terminal controls and Node script banners", () => {
    expect(
      projectCommandDiagnostic(
        "node_test",
        output(
          "\u001b[31m> @scope/pkg@1.2.3 test\u001b[0m\r\n\u001b[1mFAIL\u001b[0m: expected true\u0007\r\n",
        ),
        output("stdout fallback\r\n"),
      ),
    ).toBe("FAIL: expected true");
  });

  it("falls back to normalized stdout when stderr has no meaningful diagnostic", () => {
    expect(
      projectCommandDiagnostic(
        "node_lint",
        output("> package@1.0.0 lint\r\n\u001b[2K\r\n"),
        output("first line\r\nsecond line\r\n"),
      ),
    ).toBe("first line\nsecond line");
  });

  it("does not remove package-looking lines for non-script commands", () => {
    expect(
      projectCommandDiagnostic(
        "fallow_health",
        output("> package@1.0.0 health\r\n"),
        output("stdout"),
      ),
    ).toBe("> package@1.0.0 health");
  });

  it("removes C1 CSI, OSC, and control-string sequences while preserving text", () => {
    const payload = "https://example.test/secret\u0000payload";
    const text = [
      "α\t",
      "\u001b[31m",
      "red",
      "\u009b2K",
      "β\n",
      "\u001b]8;;",
      payload,
      "\u0007",
      "\u009d8;;",
      payload,
      "\u009c",
      "\u001bP",
      payload,
      "\u001b\\",
      "\u0090",
      payload,
      "\u009c",
      "\u001bX",
      payload,
      "\u001b\\",
      "\u0098",
      payload,
      "\u009c",
      "\u001b^",
      payload,
      "\u001b\\",
      "\u009e",
      payload,
      "\u009c",
      "\u001b_",
      payload,
      "\u001b\\",
      "\u009f",
      payload,
      "\u009c",
      "γ",
    ].join("");

    expect(projectCommandDiagnostic("fallow_health", output(text), output("fallback"))).toBe(
      "α\tredβ\nγ",
    );
  });

  it.each([
    "\u001b]unterminated ESC OSC",
    "\u009dunterminated C1 OSC",
    "\u001bPunterminated ESC DCS",
    "\u0090unterminated C1 DCS",
    "\u001bXunterminated ESC SOS",
    "\u0098unterminated C1 SOS",
    "\u001b^unterminated ESC PM",
    "\u009eunterminated C1 PM",
    "\u001b_unterminated ESC APC",
    "\u009funterminated C1 APC",
  ])("removes unterminated %s safely", (sequence) => {
    expect(projectCommandDiagnostic("fallow_health", output(`before${sequence}`), output(""))).toBe(
      "before",
    );
  });

  it("does not end non-OSC control strings at BEL", () => {
    for (const sequence of ["\u001bPdcs\u0007payload\u001b\\", "\u0090dcs\u0007payload\u009c"]) {
      expect(
        projectCommandDiagnostic("fallow_health", output(`before${sequence}after`), output("")),
      ).toBe("beforeafter");
    }
  });

  it("removes remaining C1 controls", () => {
    expect(
      projectCommandDiagnostic("fallow_health", output("α\u0080\u0085\u0099β\n\tγ"), output("")),
    ).toBe("αβ\n\tγ");
  });

  it("does not treat control-only output as a diagnostic and stays bounded", () => {
    expect(
      projectCommandDiagnostic("node_test", output("\u001b[31m\u0000\u0007\u001b[0m"), output("")),
    ).toBeUndefined();

    const diagnostic = projectCommandDiagnostic("node_test", output("x".repeat(2_500)), output(""));
    expect(diagnostic).toHaveLength(PROJECT_COMMAND_DIAGNOSTIC_MAX_CHARS);
    expect(diagnostic).toMatch(/x+\.\.\.$/u);
  });
});
