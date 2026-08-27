import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolInventoryRecorder } from "./observability/tool-inventory.ts";
import { createEnvironmentTool } from "./tools/environment/environment-tool.ts";
import { createFilesystemAccessPolicyInterceptor } from "./tools/filesystem/access-policy.ts";
import { createDeleteTool, createMoveTool } from "./tools/filesystem/mutation-tool.ts";
import { createProjectCommandTool } from "./tools/project-command/tool.ts";
import { createGitDiffTool } from "./tools/git/diff/tool.ts";
import { createGitLogTool } from "./tools/git/log/tool.ts";
import { createGitShowTool } from "./tools/git/show/tool.ts";
import { createGitStatusTool } from "./tools/git/status/tool.ts";
import type { GitExec } from "./tools/git/execution.ts";

export default function (pi: ExtensionAPI): void {
  const exec: GitExec = (command, args, options) => pi.exec(command, [...args], options);
  pi.on("session_start", createToolInventoryRecorder(pi));
  pi.on("tool_call", createFilesystemAccessPolicyInterceptor());
  pi.registerTool(createGitStatusTool(exec));
  pi.registerTool(createGitDiffTool(exec));
  pi.registerTool(createGitLogTool(exec));
  pi.registerTool(createGitShowTool(exec));
  pi.registerTool(createEnvironmentTool());
  pi.registerTool(createProjectCommandTool());
  pi.registerTool(createMoveTool());
  pi.registerTool(createDeleteTool());
}
