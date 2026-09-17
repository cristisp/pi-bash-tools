import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  renderCallLine,
  renderOptionalStringArgument,
  renderStringArgument,
  truncateRenderText,
  type RenderTheme,
} from "../src/tools/call-render.ts";

interface StyledSegment {
  readonly color: string;
  readonly text: string;
}

function createTheme(): { theme: RenderTheme; segments: StyledSegment[] } {
  const segments: StyledSegment[] = [];
  const theme: RenderTheme = {
    fg(color: ThemeColor, text: string): string {
      segments.push({ color, text });
      return `[${color}]${text}`;
    },
    bold(text: string): string {
      return `**${text}**`;
    },
  };
  return { theme, segments };
}

describe("truncateRenderText", () => {
  it("returns short text unchanged", () => {
    expect(truncateRenderText("src/index.ts")).toBe("src/index.ts");
  });

  it("truncates text beyond the render limit", () => {
    const text = "x".repeat(200);
    const truncated = truncateRenderText(text);
    expect(truncated.length).toBe(123);
    expect(truncated.endsWith("...")).toBe(true);
  });
});

describe("renderStringArgument", () => {
  it("renders strings in accent color", () => {
    const { theme, segments } = createTheme();
    expect(renderStringArgument("main..HEAD", theme)).toBe("[accent]main..HEAD");
    expect(segments.at(-1)?.color).toBe("accent");
  });

  it("marks missing or empty values as invalid", () => {
    const { theme, segments } = createTheme();
    expect(renderStringArgument(undefined, theme)).toBe("[error][invalid arg]");
    expect(renderStringArgument("   ", theme)).toBe("[error][invalid arg]");
    expect(renderStringArgument(42, theme)).toBe("[error][invalid arg]");
    expect(segments.every((segment) => segment.color === "error")).toBe(true);
  });

  it("truncates long values", () => {
    const { theme } = createTheme();
    const rendered = renderStringArgument("y".repeat(300), theme);
    expect(rendered).toBe(`[accent]${"y".repeat(120)}...`);
  });
});

describe("renderOptionalStringArgument", () => {
  it("omits undefined and empty optional values", () => {
    const { theme } = createTheme();

    expect(renderOptionalStringArgument(undefined, theme)).toBeUndefined();
    expect(renderOptionalStringArgument("", theme)).toBeUndefined();
    expect(renderOptionalStringArgument("src", theme)).toBe("[accent]src");
  });

  it("keeps non-empty invalid values visible", () => {
    const { theme } = createTheme();

    expect(renderOptionalStringArgument(null, theme)).toBe("[error][invalid arg]");
  });
});

describe("renderCallLine", () => {
  it("renders the tool title alone when there are no parts", () => {
    const { theme } = createTheme();
    const component = renderCallLine(theme, "git_status", []);
    expect(component.render(80)).toEqual(["[toolTitle]**git_status**"]);
  });

  it("joins parts after the title and skips empty parts", () => {
    const { theme } = createTheme();
    const component = renderCallLine(theme, "move", ["[accent]a.ts", "", "[muted]->"]);
    expect(component.render(80)).toEqual(["[toolTitle]**move** [accent]a.ts [muted]->"]);
  });

  it("returns one line regardless of viewport width", () => {
    const { theme } = createTheme();
    const component = renderCallLine(theme, "delete", ["[accent]a.ts"]);
    expect(component.render(20)).toEqual(component.render(200));
  });
});
