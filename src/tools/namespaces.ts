import type { ToolNamespace } from "@earendil-works/pi-coding-agent";

export const GIT_TOOL_NAMESPACE: ToolNamespace = Object.freeze({
  name: "bash-tools.git",
  aliases: ["git"],
  description: "Bounded read-only Git working tree inspection: status, diff, log, and show.",
});

export const PROJECT_COMMAND_TOOL_NAMESPACE: ToolNamespace = Object.freeze({
  name: "bash-tools.project-command",
  aliases: ["project_command", "node", "fallow"],
  description:
    "Inspect Node project state, list dependencies, run exact package scripts, and run fixed Fallow analyses.",
});
