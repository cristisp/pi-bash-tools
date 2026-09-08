import { dirname } from "node:path";

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { type AuthorizationErrorKind } from "../authorization.ts";
import { renderCallLine, renderStringArgument } from "../call-render.ts";
import type { GitExec } from "../git/execution.ts";
import { isPathWithin } from "../path-containment.ts";
import { displayPath } from "../path-display.ts";
import { filesystemPolicyDenialMetadata } from "../policy/decisions.ts";
import { createNodePolicyFileSystem, type PolicyFileSystem } from "../policy/filesystem.ts";
import { createPolicyStore, createPolicyStoreForTesting } from "../policy/store.ts";
import type { LoadedPolicy, PolicyAuthorization, PolicyStore } from "../policy/types.ts";
import {
  authorizeAndPersistFilesystemAccesses,
  loadFilesystemPolicyForRequest,
  type FilesystemAuthorizationContext,
  type FilesystemAuthorizationRequest,
} from "./authorization.ts";
import { isTrackedWorkspacePath } from "./default-access.ts";
import {
  filesystemAuthorizationContract,
  filesystemCancellationError,
  filesystemError,
  filesystemInspectionError,
  filesystemInvalidRequest,
  filesystemMutationError,
  filesystemPolicyLoadError,
  FilesystemToolError,
} from "./errors.ts";
import {
  canonicalExistingPath,
  canonicalMissingPath,
  isMissingPathError,
  requestPath,
} from "./paths.ts";

const moveParameters = Type.Object(
  {
    source: Type.String({ minLength: 1, description: "Existing file to move or rename" }),
    destination: Type.String({ minLength: 1, description: "New file path" }),
  },
  { additionalProperties: false },
);

const deleteParameters = Type.Object(
  {
    path: Type.String({ minLength: 1, description: "Existing file to delete" }),
  },
  { additionalProperties: false },
);

type MoveInput = Static<typeof moveParameters>;
type DeleteInput = Static<typeof deleteParameters>;

export interface FilesystemMoveDetails {
  readonly operation: "move";
  readonly source: string;
  readonly destination: string;
}

export interface FilesystemDeleteDetails {
  readonly operation: "delete";
  readonly path: string;
}

export type FilesystemMutationToolContext = FilesystemAuthorizationContext;

type FilesystemMutationFileSystem = Pick<
  PolicyFileSystem,
  "lstat" | "realpath" | "rename" | "unlink"
>;

export interface FilesystemMutationToolTestOptions {
  readonly configPath?: string;
  readonly fs?: Partial<PolicyFileSystem>;
  readonly gitExec?: GitExec;
  readonly policy?: PolicyStore;
}

type FilesystemMoveExecute = (
  toolCallId: string,
  params: MoveInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<FilesystemMoveDetails> | undefined,
  ctx: FilesystemMutationToolContext,
) => Promise<AgentToolResult<FilesystemMoveDetails>>;

type FilesystemDeleteExecute = (
  toolCallId: string,
  params: DeleteInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<FilesystemDeleteDetails> | undefined,
  ctx: FilesystemMutationToolContext,
) => Promise<AgentToolResult<FilesystemDeleteDetails>>;

export type FilesystemMoveToolDefinition = Omit<
  ToolDefinition<typeof moveParameters, FilesystemMoveDetails>,
  "execute"
> & { execute: FilesystemMoveExecute };

export type FilesystemDeleteToolDefinition = Omit<
  ToolDefinition<typeof deleteParameters, FilesystemDeleteDetails>,
  "execute"
> & { execute: FilesystemDeleteExecute };

const DENIED_POLICY_SCOPES: Record<PolicyAuthorization, string> = {
  "deny-global": "the global",
  "deny-project": "the project",
  "allow-global": "a configured",
  "allow-project": "a configured",
  unknown: "a configured",
};

function cancellationError(executed = false): FilesystemToolError {
  return filesystemCancellationError("Filesystem mutation cancelled", executed);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw cancellationError();
  }
}

function invalidInput(message: string, invalidField?: string): FilesystemToolError {
  return filesystemInvalidRequest(message, invalidField);
}

function requestField(label: string): string {
  if (label === "Move source") return "source";
  if (label === "Move destination") return "destination";
  return "path";
}

function inputPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidInput(`${label} must not be empty`, label);
  }
  return value;
}

function authorizationError(
  operation: string,
  kind: AuthorizationErrorKind,
  request: FilesystemAuthorizationRequest,
  decision: PolicyAuthorization,
  loaded?: LoadedPolicy,
): FilesystemToolError {
  const prefix = `Tool call blocked by access policy: ${operation} ${request.access} access to "${displayPath(request.path)}"`;
  if (kind === "denied") {
    return filesystemError(
      `${prefix} is denied by ${DENIED_POLICY_SCOPES[decision] ?? "a configured"} policy rule.`,
      filesystemAuthorizationContract(kind),
      undefined,
      loaded !== undefined && (decision === "deny-global" || decision === "deny-project")
        ? filesystemPolicyDenialMetadata(loaded, request.access, decision)
        : undefined,
    );
  }
  const suffixes: Record<string, string> = {
    "denied-once": " was denied for this request.",
    "not-authorized": " requires approval that is unavailable in this mode.",
    timeout: " confirmation timed out; a project deny rule was recorded.",
    confirmation: " confirmation failed.",
    save: "; the access policy could not be saved.",
    load: "; the access policy could not be loaded.",
    "invalid-choice": "; the access policy returned an invalid approval.",
    "unsafe-global": "; the access policy returned an invalid approval.",
    cancelled: " confirmation was cancelled.",
    dismissed: " confirmation was dismissed.",
  };
  const message = `${prefix}${suffixes[kind]}`;
  if (kind === "cancelled") {
    return filesystemCancellationError(message, false);
  }
  return filesystemError(message, filesystemAuthorizationContract(kind));
}

async function requireRegularFile(
  fileSystem: FilesystemMutationFileSystem,
  path: string,
  label: string,
): Promise<void> {
  let stats;
  try {
    stats = await fileSystem.lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw invalidInput(`${label} does not exist`, requestField(label));
    }
    throw filesystemInspectionError(`Unable to inspect ${label}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw invalidInput(`${label} must be a regular file`, requestField(label));
  }
}

async function canonicalRegularFile(
  fileSystem: FilesystemMutationFileSystem,
  path: string,
  cwd: string,
  label: string,
): Promise<string> {
  const requested = requestPath(path, cwd);
  await requireRegularFile(fileSystem, requested, label);
  let canonical: string;
  try {
    canonical = await canonicalExistingPath(requested, fileSystem);
  } catch (error) {
    if (error instanceof FilesystemToolError) {
      throw error;
    }
    throw filesystemInspectionError(`Unable to inspect ${label}`);
  }
  await requireRegularFile(fileSystem, canonical, label);
  return canonical;
}

async function canonicalMoveDestination(
  fileSystem: FilesystemMutationFileSystem,
  path: string,
  cwd: string,
): Promise<string> {
  const requested = requestPath(path, cwd);
  try {
    await fileSystem.lstat(requested);
    throw invalidInput("Move destination already exists", "destination");
  } catch (error) {
    if (error instanceof FilesystemToolError) {
      throw error;
    }
    if (!isMissingPathError(error)) {
      throw filesystemInspectionError("Unable to inspect Move destination");
    }
  }
  try {
    return await canonicalMissingPath(requested, fileSystem);
  } catch (error) {
    if (error instanceof FilesystemToolError) {
      throw error;
    }
    if (error instanceof Error && /symbolic link/u.test(error.message)) {
      throw invalidInput("Move destination contains a symbolic link", "destination");
    }
    throw filesystemInspectionError("Unable to inspect Move destination");
  }
}

async function authorizeMutation(
  operation: string,
  requests: readonly FilesystemAuthorizationRequest[],
  ctx: FilesystemMutationToolContext,
  policy: PolicyStore,
  signal: AbortSignal | undefined,
  gitExec: GitExec | undefined,
): Promise<void> {
  let loadedPolicy;
  try {
    loadedPolicy = await loadFilesystemPolicyForRequest(policy, ctx.cwd, signal);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw cancellationError();
    }
    if (error instanceof FilesystemToolError) {
      throw error;
    }
    throw filesystemPolicyLoadError();
  }
  const source = requests[0]?.path;
  const defaultAllow =
    gitExec === undefined || source === undefined
      ? undefined
      : async (accessRequest: FilesystemAuthorizationRequest): Promise<boolean> => {
          if (!isPathWithin(loadedPolicy.projectPath, accessRequest.path)) {
            return false;
          }
          if (operation === "move" && accessRequest.path !== source) {
            return isTrackedWorkspacePath(source, loadedPolicy.projectPath, gitExec, signal);
          }
          return isTrackedWorkspacePath(
            accessRequest.path,
            loadedPolicy.projectPath,
            gitExec,
            signal,
          );
        };
  await authorizeAndPersistFilesystemAccesses(requests, loadedPolicy, ctx, policy, signal, {
    allowGlobal: operation !== "delete",
    defaultAllow,
    promptText: ({ access, path, policyPath }) =>
      policyPath === undefined
        ? `Authorize ${access} access for ${operation} to ${displayPath(path)}?`
        : `Authorize deletion of files in ${displayPath(policyPath)} and its subfolders for this project only? Requested file: ${displayPath(path)}`,
    error: (kind, request, decision, currentLoaded) =>
      authorizationError(operation, kind, request, decision, currentLoaded),
  });
}

function result<D>(details: D): AgentToolResult<D> {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

function createFileSystem(options: FilesystemMutationToolTestOptions): PolicyFileSystem {
  return { ...createNodePolicyFileSystem(), ...options.fs };
}

function requirePolicy(
  options: FilesystemMutationToolTestOptions,
  fileSystem: PolicyFileSystem,
): PolicyStore {
  if (options.policy !== undefined) {
    return options.policy;
  }
  if (options.configPath === undefined) {
    throw filesystemInvalidRequest("A policy or config path is required for testing", "configPath");
  }
  return createPolicyStoreForTesting({ configPath: options.configPath, fs: fileSystem });
}

function createMoveToolWithDependencies(
  policy: PolicyStore,
  fileSystem: FilesystemMutationFileSystem,
  gitExec: GitExec | undefined,
): FilesystemMoveToolDefinition {
  return {
    name: "move",
    label: "Move file",
    description:
      "Move or rename one regular file after separate move authorization for the source and destination.",
    promptSnippet: "Move or rename an authorized file",
    parameters: moveParameters,
    executionMode: "sequential",
    renderCall(args, theme) {
      return renderCallLine(theme, "move", [
        renderStringArgument(args?.source, theme),
        theme.fg("muted", "->"),
        renderStringArgument(args?.destination, theme),
      ]);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sourceInput = inputPath(params?.source, "source");
      const destinationInput = inputPath(params?.destination, "destination");
      const requestSignal = signal ?? ctx.signal;
      throwIfAborted(requestSignal);
      const source = await canonicalRegularFile(fileSystem, sourceInput, ctx.cwd, "Move source");
      throwIfAborted(requestSignal);
      const destination = await canonicalMoveDestination(fileSystem, destinationInput, ctx.cwd);
      throwIfAborted(requestSignal);
      if (source === destination) {
        throw invalidInput("Move source and destination must differ");
      }
      await authorizeMutation(
        "move",
        [
          { access: "move", path: source },
          { access: "move", path: destination },
        ],
        ctx,
        policy,
        requestSignal,
        gitExec,
      );
      throwIfAborted(requestSignal);
      await requireRegularFile(fileSystem, source, "Move source");
      throwIfAborted(requestSignal);
      try {
        await fileSystem.lstat(destination);
        throw invalidInput("Move destination already exists", "destination");
      } catch (error) {
        if (error instanceof FilesystemToolError) {
          throw error;
        }
        if (!isMissingPathError(error)) {
          throw filesystemInspectionError("Unable to inspect Move destination");
        }
      }
      try {
        await fileSystem.rename(source, destination);
      } catch {
        if (requestSignal?.aborted) {
          throw cancellationError(true);
        }
        throw filesystemMutationError("Unable to move file");
      }
      if (requestSignal?.aborted) {
        throw cancellationError(true);
      }
      return result({ operation: "move", source, destination });
    },
  };
}

function createDeleteToolWithDependencies(
  policy: PolicyStore,
  fileSystem: FilesystemMutationFileSystem,
  gitExec: GitExec | undefined,
): FilesystemDeleteToolDefinition {
  return {
    name: "delete",
    label: "Delete file",
    description: "Delete one regular file after separate delete authorization.",
    promptSnippet: "Delete an authorized file",
    parameters: deleteParameters,
    executionMode: "sequential",
    renderCall(args, theme) {
      return renderCallLine(theme, "delete", [renderStringArgument(args?.path, theme)]);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const pathInput = inputPath(params?.path, "path");
      const requestSignal = signal ?? ctx.signal;
      throwIfAborted(requestSignal);
      const path = await canonicalRegularFile(fileSystem, pathInput, ctx.cwd, "Delete target");
      throwIfAborted(requestSignal);
      await authorizeMutation(
        "delete",
        [{ access: "delete", path, policyPath: dirname(path) }],
        ctx,
        policy,
        requestSignal,
        gitExec,
      );
      throwIfAborted(requestSignal);
      await requireRegularFile(fileSystem, path, "Delete target");
      throwIfAborted(requestSignal);
      try {
        await fileSystem.unlink(path);
      } catch {
        if (requestSignal?.aborted) {
          throw cancellationError(true);
        }
        throw filesystemMutationError("Unable to delete file");
      }
      if (requestSignal?.aborted) {
        throw cancellationError(true);
      }
      return result({ operation: "delete", path });
    },
  };
}

export function createMoveTool(gitExec?: GitExec): FilesystemMoveToolDefinition {
  const fileSystem = createNodePolicyFileSystem();
  return createMoveToolWithDependencies(createPolicyStore(), fileSystem, gitExec);
}

export function createDeleteTool(gitExec?: GitExec): FilesystemDeleteToolDefinition {
  const fileSystem = createNodePolicyFileSystem();
  return createDeleteToolWithDependencies(createPolicyStore(), fileSystem, gitExec);
}

export function createMoveToolForTesting(
  options: FilesystemMutationToolTestOptions,
): FilesystemMoveToolDefinition {
  const fileSystem = createFileSystem(options);
  return createMoveToolWithDependencies(
    requirePolicy(options, fileSystem),
    fileSystem,
    options.gitExec,
  );
}

export function createDeleteToolForTesting(
  options: FilesystemMutationToolTestOptions,
): FilesystemDeleteToolDefinition {
  const fileSystem = createFileSystem(options);
  return createDeleteToolWithDependencies(
    requirePolicy(options, fileSystem),
    fileSystem,
    options.gitExec,
  );
}
