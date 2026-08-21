import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { type AuthorizationErrorKind } from "../authorization.ts";
import { displayPath } from "../path-display.ts";
import { createNodePolicyFileSystem, type PolicyFileSystem } from "../policy/filesystem.ts";
import { createPolicyStore, createPolicyStoreForTesting } from "../policy/store.ts";
import type { PolicyAuthorization, PolicyStore } from "../policy/types.ts";
import {
  authorizeAndPersistFilesystemAccesses,
  loadFilesystemPolicyForRequest,
  type FilesystemAuthorizationContext,
  type FilesystemAuthorizationRequest,
} from "./authorization.ts";
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

class FilesystemMutationToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilesystemMutationToolError";
  }
}

export type FilesystemMutationToolContext = FilesystemAuthorizationContext;

type FilesystemMutationFileSystem = Pick<
  PolicyFileSystem,
  "lstat" | "realpath" | "rename" | "unlink"
>;

export interface FilesystemMutationToolTestOptions {
  readonly configPath?: string;
  readonly fs?: Partial<PolicyFileSystem>;
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

function cancellationError(): FilesystemMutationToolError {
  const error = new FilesystemMutationToolError("Filesystem mutation cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw cancellationError();
  }
}

function invalidInput(message: string): FilesystemMutationToolError {
  return new FilesystemMutationToolError(message);
}

function inputPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidInput(`${label} must not be empty`);
  }
  return value;
}

function authorizationError(
  operation: string,
  kind: AuthorizationErrorKind,
  request: FilesystemAuthorizationRequest,
  decision: PolicyAuthorization,
): FilesystemMutationToolError {
  const prefix = `Tool call blocked by access policy: ${operation} ${request.access} access to "${displayPath(request.path)}"`;
  if (kind === "denied") {
    return new FilesystemMutationToolError(
      `${prefix} is denied by ${DENIED_POLICY_SCOPES[decision] ?? "a configured"} policy rule.`,
    );
  }
  const suffixes: Record<string, string> = {
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
  return new FilesystemMutationToolError(`${prefix}${suffixes[kind]}`);
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
      throw invalidInput(`${label} does not exist`);
    }
    throw new FilesystemMutationToolError(`Unable to inspect ${label}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw invalidInput(`${label} must be a regular file`);
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
  const canonical = await canonicalExistingPath(requested, fileSystem);
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
    throw invalidInput("Move destination already exists");
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  return canonicalMissingPath(requested, fileSystem);
}

async function authorizeMutation(
  operation: string,
  requests: readonly FilesystemAuthorizationRequest[],
  ctx: FilesystemMutationToolContext,
  policy: PolicyStore,
  signal: AbortSignal | undefined,
): Promise<void> {
  let loaded;
  try {
    loaded = await loadFilesystemPolicyForRequest(policy, ctx.cwd, signal);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw cancellationError();
    }
    throw new FilesystemMutationToolError("Unable to load filesystem access policy");
  }
  await authorizeAndPersistFilesystemAccesses(requests, loaded, ctx, policy, signal, {
    promptText: ({ access, path }) =>
      `Authorize ${access} access for ${operation} to ${displayPath(path)}?`,
    error: (kind, request, decision) => authorizationError(operation, kind, request, decision),
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
    throw new FilesystemMutationToolError("A policy or config path is required for testing");
  }
  return createPolicyStoreForTesting({ configPath: options.configPath, fs: fileSystem });
}

function createMoveToolWithDependencies(
  policy: PolicyStore,
  fileSystem: FilesystemMutationFileSystem,
): FilesystemMoveToolDefinition {
  return {
    name: "move",
    label: "Move file",
    description:
      "Move or rename one regular file after separate move authorization for the source and destination.",
    promptSnippet: "Move or rename an authorized file",
    parameters: moveParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sourceInput = inputPath(params?.source, "source");
      const destinationInput = inputPath(params?.destination, "destination");
      const requestSignal = signal ?? ctx.signal;
      throwIfAborted(requestSignal);
      const source = await canonicalRegularFile(fileSystem, sourceInput, ctx.cwd, "Move source");
      const destination = await canonicalMoveDestination(fileSystem, destinationInput, ctx.cwd);
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
      );
      throwIfAborted(requestSignal);
      await requireRegularFile(fileSystem, source, "Move source");
      try {
        await fileSystem.lstat(destination);
        throw invalidInput("Move destination already exists");
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
      }
      try {
        await fileSystem.rename(source, destination);
      } catch {
        throw new FilesystemMutationToolError("Unable to move file");
      }
      return result({ operation: "move", source, destination });
    },
  };
}

function createDeleteToolWithDependencies(
  policy: PolicyStore,
  fileSystem: FilesystemMutationFileSystem,
): FilesystemDeleteToolDefinition {
  return {
    name: "delete",
    label: "Delete file",
    description: "Delete one regular file after separate delete authorization.",
    promptSnippet: "Delete an authorized file",
    parameters: deleteParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const pathInput = inputPath(params?.path, "path");
      const requestSignal = signal ?? ctx.signal;
      throwIfAborted(requestSignal);
      const path = await canonicalRegularFile(fileSystem, pathInput, ctx.cwd, "Delete target");
      await authorizeMutation("delete", [{ access: "delete", path }], ctx, policy, requestSignal);
      throwIfAborted(requestSignal);
      await requireRegularFile(fileSystem, path, "Delete target");
      try {
        await fileSystem.unlink(path);
      } catch {
        throw new FilesystemMutationToolError("Unable to delete file");
      }
      return result({ operation: "delete", path });
    },
  };
}

export function createMoveTool(): FilesystemMoveToolDefinition {
  const fileSystem = createNodePolicyFileSystem();
  return createMoveToolWithDependencies(createPolicyStore(), fileSystem);
}

export function createDeleteTool(): FilesystemDeleteToolDefinition {
  const fileSystem = createNodePolicyFileSystem();
  return createDeleteToolWithDependencies(createPolicyStore(), fileSystem);
}

export function createMoveToolForTesting(
  options: FilesystemMutationToolTestOptions,
): FilesystemMoveToolDefinition {
  const fileSystem = createFileSystem(options);
  return createMoveToolWithDependencies(requirePolicy(options, fileSystem), fileSystem);
}

export function createDeleteToolForTesting(
  options: FilesystemMutationToolTestOptions,
): FilesystemDeleteToolDefinition {
  const fileSystem = createFileSystem(options);
  return createDeleteToolWithDependencies(requirePolicy(options, fileSystem), fileSystem);
}
