import { getProjectCommandDefinitions } from "../../definitions.ts";
import type { NodeProjectInfo } from "../../node.ts";
import { NODE_SCRIPT_COMMANDS } from "./manifest.ts";

const FALLOW_COMMAND_IDS = [
  "fallow_dead_code",
  "fallow_dupes",
  "fallow_health",
  "fallow_audit",
  "fallow_list_entry_points",
  "fallow_list_boundaries",
] as const;

export function applicableNodeCommandsInternal(
  scripts: Readonly<Record<string, string>>,
  fallowBinaryAvailable: boolean,
  dependencyListAvailable: boolean,
): NodeProjectInfo["applicableCommands"] {
  const ids = new Set<string>(["node_project_info"]);
  for (const command of NODE_SCRIPT_COMMANDS) {
    if (Object.prototype.hasOwnProperty.call(scripts, command.script)) {
      ids.add(command.commandId);
    }
  }
  if (dependencyListAvailable) {
    ids.add("node_deps_list");
  }
  if (fallowBinaryAvailable) {
    for (const commandId of FALLOW_COMMAND_IDS) {
      ids.add(commandId);
    }
  }
  return Object.freeze(
    getProjectCommandDefinitions()
      .map((definition) => definition.commandId)
      .filter((commandId) => ids.has(commandId)),
  );
}
