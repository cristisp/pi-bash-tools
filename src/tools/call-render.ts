import type { ThemeColor } from "@earendil-works/pi-coding-agent";

const MAX_RENDER_TEXT_LENGTH = 120;
const INVALID_ARGUMENT_TEXT = "[invalid arg]";

export interface RenderTheme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

class CallTextComponent {
  private readonly line: string;

  constructor(line: string) {
    this.line = line;
  }

  render(_width: number): string[] {
    return [this.line];
  }

  invalidate(): void {}
}

export function truncateRenderText(text: string): string {
  return text.length > MAX_RENDER_TEXT_LENGTH
    ? `${text.slice(0, MAX_RENDER_TEXT_LENGTH)}...`
    : text;
}

export function renderStringArgument(value: unknown, theme: RenderTheme): string {
  if (typeof value !== "string") {
    return theme.fg("error", INVALID_ARGUMENT_TEXT);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return theme.fg("error", INVALID_ARGUMENT_TEXT);
  }
  return theme.fg("accent", truncateRenderText(trimmed));
}

export function renderOptionalStringArgument(
  value: unknown,
  theme: RenderTheme,
): string | undefined {
  return value === undefined || value === "" ? undefined : renderStringArgument(value, theme);
}

export function renderCallLine(
  theme: RenderTheme,
  toolName: string,
  parts: readonly string[],
): CallTextComponent {
  const title = theme.fg("toolTitle", theme.bold(toolName));
  const detail = parts.filter((part) => part.length > 0).join(" ");
  return new CallTextComponent(detail.length === 0 ? title : `${title} ${detail}`);
}
