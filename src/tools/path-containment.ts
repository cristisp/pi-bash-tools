import { isAbsolute, relative, sep } from "node:path";

export function isPathWithin(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return (
    suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}
