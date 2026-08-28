export function definedObjectProperties(
  entries: readonly (readonly [string, unknown])[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}
