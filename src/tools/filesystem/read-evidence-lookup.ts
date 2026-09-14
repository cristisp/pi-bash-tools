import type {
  SharedEvidenceOutputBlock,
  SharedEvidenceWorkspaceBlock,
} from "../../evidence/envelope.ts";
import {
  compareWorkspaceBlocks,
  type WorkspaceBlockStateStatus,
} from "../../evidence/repository-state-comparison.ts";
import { filesystemContract, filesystemError, FilesystemToolError } from "./errors.ts";
import type {
  ReadEvidenceEntry,
  ReadEvidenceRange,
  ReadEvidenceStore,
} from "./read-evidence-store.ts";

export type ReadEvidenceLookupStatus = "unchanged" | "changed" | "unreadable" | "unauthorized";

export type ReadEvidenceLookupOutcome = "success" | "not-found" | "unauthorized-flow" | "corrupt";

export interface ReadEvidenceLookupEntry {
  readonly path: string;
  readonly range?: ReadEvidenceRange;
  readonly contentHash?: string;
  readonly status: ReadEvidenceLookupStatus;
  readonly content?: string;
  readonly output?: SharedEvidenceOutputBlock;
}

export interface ReadEvidenceLookupResult {
  readonly ref: string;
  readonly covers?: readonly string[];
  readonly executed: false;
  readonly repositoryStateStatus: WorkspaceBlockStateStatus;
  readonly entries: readonly ReadEvidenceLookupEntry[];
  readonly workspace?: SharedEvidenceWorkspaceBlock;
  readonly currentWorkspace?: SharedEvidenceWorkspaceBlock;
}

export interface ReadEvidencePathProbe {
  readonly status: ReadEvidenceLookupStatus;
  readonly content?: string;
  readonly output?: SharedEvidenceOutputBlock;
}

export interface ResolveReadEvidenceLookupOptions {
  readonly store: ReadEvidenceStore;
  readonly ref: string;
  readonly requestedFlowId: string | undefined;
  readonly flowId: string | undefined;
  readonly covers: readonly string[] | undefined;
  readonly unauthorizedFlow: boolean;
  readonly probePath: (entry: ReadEvidenceEntry) => Promise<ReadEvidencePathProbe>;
  readonly observeWorkspace: () => Promise<SharedEvidenceWorkspaceBlock | undefined>;
  readonly onOutcome: (outcome: ReadEvidenceLookupOutcome) => void;
}

export function readEvidenceNotFoundError(
  ref: string,
  flowId: string | undefined,
): FilesystemToolError {
  const scope = flowId === undefined ? "the process-local root-session store" : `flow ${flowId}`;
  return filesystemError(
    `Read batch evidence ref ${ref} not found in ${scope}; evidence refs are non-replayable and process-scoped.`,
    filesystemContract({
      code: "evidence-not-found",
      category: "IMPLEMENTATION_FAILURE",
      explanation: "The read batch evidence reference could not be resolved.",
      retryable: false,
      executed: false,
    }),
  );
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function resolveReadEvidenceLookup(
  options: ResolveReadEvidenceLookupOptions,
): Promise<ReadEvidenceLookupResult> {
  if (options.unauthorizedFlow) {
    options.onOutcome("unauthorized-flow");
    throw readEvidenceNotFoundError(options.ref, options.flowId);
  }
  const record = options.store.getByRef(options.ref, options.flowId);
  if (record === undefined) {
    const outcome = options.store.lookupOutcome?.(options.ref, options.flowId);
    options.onOutcome(outcome === "corrupt" ? "corrupt" : "not-found");
    throw readEvidenceNotFoundError(options.ref, options.flowId);
  }
  options.onOutcome("success");

  const currentWorkspace = await options.observeWorkspace();
  const entries: ReadEvidenceLookupEntry[] = [];
  const collect = async (index: number): Promise<void> => {
    const entry = record.entries[index];
    if (entry === undefined) return;
    let probe: ReadEvidencePathProbe;
    try {
      probe = await options.probePath(entry);
    } catch (error) {
      if (isCancellation(error)) throw error;
      probe = { status: "unreadable" };
    }
    const status: ReadEvidenceLookupStatus =
      probe.status === "unchanged" && probe.content !== entry.content ? "changed" : probe.status;
    entries.push({
      path: entry.path,
      ...(entry.range === undefined ? {} : { range: entry.range }),
      contentHash: entry.contentHash,
      status,
      ...(status === "unchanged"
        ? {
            content: entry.content,
            ...(probe.output === undefined ? {} : { output: probe.output }),
          }
        : {}),
    });
    await collect(index + 1);
  };
  await collect(0);
  return Object.freeze({
    ref: record.ref,
    ...(options.covers === undefined ? {} : { covers: Object.freeze([...options.covers]) }),
    executed: false as const,
    repositoryStateStatus: compareWorkspaceBlocks(record.workspace, currentWorkspace),
    entries: Object.freeze(entries),
    ...(record.workspace === undefined ? {} : { workspace: record.workspace }),
    ...(currentWorkspace === undefined ? {} : { currentWorkspace }),
  });
}
