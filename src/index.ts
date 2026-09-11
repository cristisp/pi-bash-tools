import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createAuthorizationOutcomeRecorder } from "./observability/authorization-outcome.ts";
import { createGitInvocationRecorder } from "./observability/git-invocation.ts";
import {
  createProjectCommandInvocationSessionRecorder,
  type ProjectCommandInvocationLifecycleContext,
} from "./observability/project-command-invocation.ts";
import { createReadBatchInvocationRecorder } from "./observability/read-batch-invocation.ts";
import { createToolInventoryRecorder } from "./observability/tool-inventory.ts";
import { createAuthorizationRetryTracker } from "./tools/authorization-retry.ts";
import { createEnvironmentTool } from "./tools/environment/environment-tool.ts";
import { createFilesystemAccessPolicyInterceptor } from "./tools/filesystem/access-policy.ts";
import { createDeleteTool, createMoveTool } from "./tools/filesystem/mutation-tool.ts";
import { createReadBatchTool } from "./tools/filesystem/read-batch-tool.ts";
import { createGitDiffTool } from "./tools/git/diff/tool.ts";
import { boundedGitExec, type GitExec } from "./tools/git/execution.ts";
import { createGitLogTool } from "./tools/git/log/tool.ts";
import { createGitShowTool } from "./tools/git/show/tool.ts";
import { createGitStatusTool } from "./tools/git/status/tool.ts";
import { createProjectCommandRepositoryStateReader } from "./tools/project-command/repository-state.ts";
import { createProjectCommandTool } from "./tools/project-command/tool.ts";
import { createVerifyTool } from "./tools/verify/tool.ts";

export default function (pi: ExtensionAPI): void {
  const exec: GitExec = (command, args, options) =>
    options?.maxOutputBytes === undefined
      ? pi.exec(command, [...args], options)
      : boundedGitExec(command, args, options, options.maxOutputBytes);
  const toolInventoryRecorder = createToolInventoryRecorder(pi);
  const invocationSessionRecorder = createProjectCommandInvocationSessionRecorder(pi);
  const readBatchInvocationRecorder = createReadBatchInvocationRecorder(pi);
  const gitInvocationRecorder = createGitInvocationRecorder(pi);
  const authorizationOutcomeRecorder = createAuthorizationOutcomeRecorder(pi);
  const authorizationRetryTracker = createAuthorizationRetryTracker();
  const gitRepositoryStateReader = createProjectCommandRepositoryStateReader(exec);
  pi.on("session_start", (event, context) => {
    invocationSessionRecorder.onSessionStart(
      event,
      context satisfies ProjectCommandInvocationLifecycleContext,
    );
    toolInventoryRecorder(event, context);
  });
  pi.on("session_shutdown", invocationSessionRecorder.onSessionShutdown);
  pi.on(
    "tool_call",
    createFilesystemAccessPolicyInterceptor(
      undefined,
      authorizationOutcomeRecorder,
      authorizationRetryTracker,
    ),
  );
  pi.registerTool(
    createGitStatusTool(exec, {
      invocationRecorder: gitInvocationRecorder,
      repositoryStateReader: gitRepositoryStateReader,
    }),
  );
  pi.registerTool(
    createGitDiffTool(exec, {
      invocationObservation: {
        invocationRecorder: gitInvocationRecorder,
        repositoryStateReader: gitRepositoryStateReader,
      },
    }),
  );
  pi.registerTool(
    createGitLogTool(exec, {
      invocationRecorder: gitInvocationRecorder,
      repositoryStateReader: gitRepositoryStateReader,
    }),
  );
  pi.registerTool(
    createGitShowTool(exec, {
      invocationRecorder: gitInvocationRecorder,
      repositoryStateReader: gitRepositoryStateReader,
    }),
  );
  pi.registerTool(createEnvironmentTool(authorizationOutcomeRecorder, authorizationRetryTracker));
  pi.registerTool(
    createReadBatchTool(exec, {
      invocationRecorder: readBatchInvocationRecorder,
      authorizationOutcomeRecorder,
      authorizationRetryTracker,
    }),
  );
  pi.registerTool(
    createProjectCommandTool({
      invocationRecorder: invocationSessionRecorder.invocationRecorder,
      repositoryStateReader: createProjectCommandRepositoryStateReader(exec),
      authorizationOutcomeRecorder,
      authorizationRetryTracker,
    }),
  );
  pi.registerTool(
    createVerifyTool(exec, {
      invocationRecorder: invocationSessionRecorder.invocationRecorder,
      authorizationOutcomeRecorder,
      authorizationRetryTracker,
    }),
  );
  pi.registerTool(createMoveTool(exec, authorizationOutcomeRecorder, authorizationRetryTracker));
  pi.registerTool(createDeleteTool(exec, authorizationOutcomeRecorder, authorizationRetryTracker));
}
