import { createHash } from "node:crypto";

import {
  createProjectCommandDiskJsonCache,
  type ProjectCommandDiskCacheClaim,
  type ProjectCommandDiskJsonCache,
} from "../../project-command/cache.ts";
import { readProjectCommandOrchestrationContext } from "../../project-command/orchestration.ts";
import { MAX_CONTENT_BYTES, MAX_RECORDS } from "../output.ts";
import type { GitDiffSummaryOutput } from "./output.ts";

const GIT_DIFF_SUMMARY_CACHE_FORMAT_VERSION = 1 as const;
const CACHE_SCOPE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const CACHE_TEXT_MAX_LENGTH = MAX_CONTENT_BYTES;
const CACHE_TOTAL_LINES_MAX = 4_096_000;

export interface GitDiffSummaryCacheState {
  readonly repositoryIdentity: string;
  readonly workingDirectory: string;
  readonly head: string;
  readonly dirtyFilesDigest: string;
  readonly staged: boolean;
  readonly paths: readonly string[];
  readonly maxBytes: number;
}

export interface GitDiffSummaryCacheClaim {
  readonly claimId: symbol;
  readonly key: string;
  readonly scope: string | undefined;
  readonly diskClaim: ProjectCommandDiskCacheClaim | undefined;
}

export interface GitDiffSummaryCache {
  get(state: GitDiffSummaryCacheState): GitDiffSummaryOutput | undefined;
  set(state: GitDiffSummaryCacheState, summary: GitDiffSummaryOutput): void;
  tryClaim(state: GitDiffSummaryCacheState): GitDiffSummaryCacheClaim | undefined;
  releaseClaim(claim: GitDiffSummaryCacheClaim): void;
}

interface GitDiffSummaryCacheRecord {
  readonly cacheFormatVersion: typeof GIT_DIFF_SUMMARY_CACHE_FORMAT_VERSION;
  readonly key: string;
  readonly state: GitDiffSummaryCacheState;
  readonly summary: GitDiffSummaryOutput;
  readonly flowId: string;
}

export interface GitDiffSummaryCacheOptions {
  readonly diskCache?: ProjectCommandDiskJsonCache;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStatusEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    value.path.length <= 4_096 &&
    typeof value.indexStatus === "string" &&
    value.indexStatus.length <= 2 &&
    typeof value.worktreeStatus === "string" &&
    value.worktreeStatus.length <= 2 &&
    (value.renamedFrom === undefined ||
      (typeof value.renamedFrom === "string" && value.renamedFrom.length <= 4_096))
  );
}

function isSummary(value: unknown): value is GitDiffSummaryOutput {
  if (!isRecord(value) || value.mode !== "summary") return false;
  if (
    !Array.isArray(value.status) ||
    value.status.length > MAX_RECORDS ||
    !value.status.every(isStatusEntry)
  ) {
    return false;
  }
  if (
    !Array.isArray(value.hunks) ||
    value.hunks.length > MAX_RECORDS ||
    !value.hunks.every(
      (hunk) =>
        isRecord(hunk) &&
        typeof hunk.path === "string" &&
        hunk.path.length <= 4_096 &&
        typeof hunk.header === "string" &&
        hunk.header.length <= 4_096,
    )
  ) {
    return false;
  }
  if (
    typeof value.stat !== "string" ||
    value.stat.length > CACHE_TEXT_MAX_LENGTH ||
    typeof value.message !== "string" ||
    value.message.length > CACHE_TEXT_MAX_LENGTH
  ) {
    return false;
  }
  if (!isRecord(value.output)) return false;
  return (
    typeof value.output.truncated === "boolean" &&
    isNonNegativeInteger(value.output.totalBytes) &&
    value.output.totalBytes <= CACHE_TEXT_MAX_LENGTH * 4_096 &&
    isNonNegativeInteger(value.output.totalLines) &&
    value.output.totalLines <= CACHE_TOTAL_LINES_MAX
  );
}

function isState(value: unknown): value is GitDiffSummaryCacheState {
  return (
    isRecord(value) &&
    typeof value.repositoryIdentity === "string" &&
    value.repositoryIdentity.length > 0 &&
    value.repositoryIdentity.length <= 4_096 &&
    typeof value.workingDirectory === "string" &&
    value.workingDirectory.length > 0 &&
    value.workingDirectory.length <= 4_096 &&
    typeof value.head === "string" &&
    value.head.length > 0 &&
    value.head.length <= 256 &&
    typeof value.dirtyFilesDigest === "string" &&
    value.dirtyFilesDigest.length > 0 &&
    value.dirtyFilesDigest.length <= 256 &&
    typeof value.staged === "boolean" &&
    Array.isArray(value.paths) &&
    value.paths.length <= MAX_RECORDS &&
    value.paths.every((path) => typeof path === "string" && path.length <= 4_096) &&
    isNonNegativeInteger(value.maxBytes) &&
    value.maxBytes > 0 &&
    value.maxBytes <= MAX_CONTENT_BYTES
  );
}

function isBoundedSummary(state: GitDiffSummaryCacheState, summary: GitDiffSummaryOutput): boolean {
  if (summary.status.length > MAX_RECORDS) return false;
  const payload = JSON.stringify({
    status: summary.status,
    stat: summary.stat,
    hunks: summary.hunks,
  });
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (payloadBytes > state.maxBytes || summary.output.totalBytes < payloadBytes) return false;
  if (summary.output.truncated && !summary.message.startsWith("INCOMPLETE")) return false;
  if (!summary.output.truncated && summary.output.totalBytes > state.maxBytes) return false;
  return summary.hunks.every((hunk) => hunk.path.length <= 4_096 && hunk.header.startsWith("@@ "));
}

function isCacheRecord(
  value: unknown,
  logicalRequestKey?: string,
  scopeKey?: string,
): value is GitDiffSummaryCacheRecord {
  if (!isRecord(value)) return false;
  if (
    logicalRequestKey !== undefined &&
    (typeof value.key !== "string" || value.key !== logicalRequestKey)
  ) {
    return false;
  }
  if (
    value.cacheFormatVersion !== GIT_DIFF_SUMMARY_CACHE_FORMAT_VERSION ||
    typeof value.key !== "string" ||
    !isState(value.state) ||
    !isSummary(value.summary) ||
    !isBoundedSummary(value.state, value.summary) ||
    typeof value.flowId !== "string" ||
    !CACHE_SCOPE_PATTERN.test(value.flowId) ||
    (scopeKey !== undefined && value.flowId !== scopeKey)
  ) {
    return false;
  }
  return value.key === stateKey(value.state);
}

function stateKey(state: GitDiffSummaryCacheState): string {
  return createHash("sha256")
    .update("git-diff-summary-v1\0", "utf8")
    .update(JSON.stringify(state), "utf8")
    .digest("hex");
}

function equalState(left: GitDiffSummaryCacheState, right: GitDiffSummaryCacheState): boolean {
  return (
    left.repositoryIdentity === right.repositoryIdentity &&
    left.workingDirectory === right.workingDirectory &&
    left.head === right.head &&
    left.dirtyFilesDigest === right.dirtyFilesDigest &&
    left.staged === right.staged &&
    left.maxBytes === right.maxBytes &&
    left.paths.length === right.paths.length &&
    left.paths.every((path, index) => path === right.paths[index])
  );
}

function flowScope(): string | undefined {
  const context = readProjectCommandOrchestrationContext();
  return context.effectiveScope === "flow" && context.flowId !== undefined
    ? context.flowId
    : undefined;
}

export function createGitDiffSummaryCache(
  options: GitDiffSummaryCacheOptions = {},
): GitDiffSummaryCache {
  const diskCache = options.diskCache ?? createProjectCommandDiskJsonCache({}, isCacheRecord);
  const local = new Map<string, GitDiffSummaryCacheRecord>();
  const localClaims = new Map<string, GitDiffSummaryCacheClaim>();
  return {
    get(state) {
      const key = stateKey(state);
      const scope = flowScope();
      const record =
        scope === undefined
          ? local.get(key)
          : (() => {
              const persisted = diskCache.get(scope, key);
              return isCacheRecord(persisted) ? persisted : undefined;
            })();
      if (
        record === undefined ||
        record.key !== key ||
        !equalState(record.state, state) ||
        record.flowId !== (scope ?? "session")
      ) {
        return undefined;
      }
      return record.summary;
    },
    set(state, summary) {
      const key = stateKey(state);
      const scope = flowScope();
      const record: GitDiffSummaryCacheRecord = {
        cacheFormatVersion: GIT_DIFF_SUMMARY_CACHE_FORMAT_VERSION,
        key,
        state,
        summary,
        flowId: scope ?? "session",
      };
      if (scope === undefined) {
        local.set(key, record);
        return;
      }
      diskCache.set(scope, key, record);
    },
    tryClaim(state) {
      const key = stateKey(state);
      const scope = flowScope();
      if (scope !== undefined) {
        const diskClaim = diskCache.tryClaim(scope, key);
        if (diskClaim === undefined) return undefined;
        return { claimId: Symbol(), key, scope, diskClaim };
      }
      if (localClaims.has(key)) return undefined;
      const claim = { claimId: Symbol(), key, scope, diskClaim: undefined };
      localClaims.set(key, claim);
      return claim;
    },
    releaseClaim(claim) {
      if (claim.scope !== undefined) {
        if (claim.diskClaim !== undefined) diskCache.releaseClaim(claim.diskClaim);
        return;
      }
      if (localClaims.get(claim.key)?.claimId === claim.claimId) localClaims.delete(claim.key);
    },
  };
}
