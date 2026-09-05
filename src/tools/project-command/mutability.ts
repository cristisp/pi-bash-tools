import type { ProjectCommandDefinition } from "./definitions.ts";
import type { ResolvedProjectCommand } from "./resolution/types.ts";

/** Conservative package-script mutation classification; package bodies remain opaque. */
export function projectCommandMutatesWorkspace(
  definition: ProjectCommandDefinition,
  resolved?: Pick<ResolvedProjectCommand, "scriptKey">,
): boolean {
  const script = resolved?.scriptKey ?? definition.fixedScriptKey;
  if (definition.commandId === "node_format") {
    return script === undefined ? true : !/(^|:)check(?:$|:)/u.test(script);
  }
  if (definition.commandId === "node_lint") {
    if (script === undefined || script === "lint") return false;
    if (/(^|:)check(?:$|:)/u.test(script)) return false;
    return true;
  }
  return definition.mutatesWorkspace === true;
}
