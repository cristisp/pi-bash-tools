import { isAbsolute } from "node:path";

export function safeRelativePath(path: string): string | undefined {
  const normalized = path.split("\\").join("/");
  if (
    normalized.length === 0 ||
    /^[A-Za-z]:\//u.test(normalized) ||
    isAbsolute(normalized) ||
    normalized
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return normalized;
}
