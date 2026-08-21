import { homedir } from "node:os";
import { relative, sep } from "node:path";

export function displayPath(path: string, homeDirectory = homedir()): string {
  const suffix = relative(homeDirectory, path);
  if (suffix === "") {
    return "~";
  }
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || suffix.startsWith(sep)) {
    return path;
  }
  return `~/${suffix.split(sep).join("/")}`;
}
