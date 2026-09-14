import { expect, it } from "vitest";

import { createGitDiffTool } from "../../src/tools/git/diff/tool.ts";
import {
  unchangedInvalidGitRequest,
  validateGitText,
  validateRevision,
  type GitExec,
} from "../../src/tools/git/execution.ts";
import { createInvalidRequestTracker } from "../../src/tools/git/invalid-request-tracker.ts";
import { resolvePath, resolvePaths } from "../../src/tools/git/repository.ts";
import type { GitToolContext } from "../../src/tools/git/tool.ts";

const repository = { root: process.cwd(), cwd: process.cwd() };
const unreachable: GitExec = async () => {
  throw new Error("validation must not execute Git");
};

function thrownBy(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected a synchronous rejection");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

it("marks an empty field as shape-deterministic with unchanged wording", () => {
  const error = thrownBy(() => validateGitText("", "path"));

  expect(error).toHaveProperty("contract.code", "invalid-request");
  expect(error).toHaveProperty("contract.shapeDeterministic", true);
  expect(messageOf(error)).toBe(
    "path must not be empty; action: Correct the path field or request shape and retry.",
  );
});

it("marks a control character as shape-deterministic with unchanged wording", () => {
  const error = thrownBy(() => validateRevision("main\u0000name"));

  expect(error).toHaveProperty("contract.code", "invalid-request");
  expect(error).toHaveProperty("contract.shapeDeterministic", true);
  expect(messageOf(error)).toBe(
    "revision contains a control character; action: Correct the revision field or request shape and retry.",
  );
});

it("does not mark an unsafe revision expression as shape-deterministic", () => {
  const error = thrownBy(() => validateRevision("main:file"));

  expect(error).toHaveProperty("contract.code", "invalid-request");
  expect(error).not.toHaveProperty("contract.shapeDeterministic");
  expect(messageOf(error)).toBe(
    "revision is not a safe Git revision expression; action: Correct the revision field or request shape and retry.",
  );
});

it("does not mark an unsafe path as shape-deterministic", async () => {
  await expect(resolvePath(repository, "../outside")).rejects.not.toHaveProperty(
    "contract.shapeDeterministic",
  );
  await expect(resolvePath(repository, "../outside")).rejects.toHaveProperty(
    "contract.code",
    "invalid-request",
  );
  await expect(resolvePath(repository, "../outside")).rejects.toThrow(
    /path is not a safe workspace-relative path; action: Correct the path field or request shape and retry\./u,
  );
});

it("marks an empty paths array as shape-deterministic with unchanged wording", async () => {
  await expect(resolvePaths(repository, [])).rejects.toHaveProperty(
    "contract.shapeDeterministic",
    true,
  );
  await expect(resolvePaths(repository, [])).rejects.toThrow(
    /paths must not be empty; action: Correct the paths field or request shape and retry\./u,
  );
});

it("keeps duplicate paths wording without the cwd-dependent marker", async () => {
  await expect(resolvePaths(repository, ["same", "same"])).rejects.not.toHaveProperty(
    "contract.shapeDeterministic",
  );
  await expect(resolvePaths(repository, ["same", "same"])).rejects.toThrow(
    /paths must not contain duplicate paths; action: Correct the paths field or request shape and retry\./u,
  );
});

it("marks a path-and-paths conflict while keeping the existing wording", async () => {
  const tool = createGitDiffTool(unreachable);
  const call = () =>
    tool.execute("call", { path: "a", paths: ["b"] }, undefined, undefined, {
      cwd: repository.cwd,
      signal: undefined,
    });

  await expect(call()).rejects.toHaveProperty("contract.shapeDeterministic", true);
  await expect(call()).rejects.toThrow(
    /provide either path or paths, not both; action: Correct the path field or request shape and retry\./u,
  );
});

it("reports an unchanged repeat with a distinct code and stable wording", () => {
  const error = unchangedInvalidGitRequest();

  expect(error).toHaveProperty("contract.code", "unchanged-invalid-request");
  expect(error).toHaveProperty("contract.category", "INVALID_REQUEST");
  expect(error).toHaveProperty("contract.retryable", false);
  expect(error).toHaveProperty("contract.executed", false);
  expect(error).not.toHaveProperty("contract.shapeDeterministic");
  expect(messageOf(error)).toBe(
    "Identical invalid Git request was already rejected for this session; change the request before retrying; action: Correct the request shape or value and retry.",
  );
});

function sessionContext(): GitToolContext {
  return {
    cwd: repository.cwd,
    signal: undefined,
    sessionManager: { getSessionId: () => "duplicate-session" },
  };
}

function repositoryExec(): GitExec {
  return async (_command, args) => {
    if (args[3] === "rev-parse" && args[4] === "--show-toplevel") {
      return { stdout: `${repository.cwd}\n`, stderr: "", code: 0, killed: false };
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
}

it("executes a repeated duplicate-paths request instead of refusing it as unchanged", async () => {
  const tool = createGitDiffTool(repositoryExec(), {
    invocationObservation: { retryInvalidationTracker: createInvalidRequestTracker() },
  });
  const call = () =>
    tool.execute("call", { paths: ["same", "same"] }, undefined, undefined, sessionContext());

  await expect(call()).rejects.toHaveProperty("contract.code", "invalid-request");
  await expect(call()).rejects.toHaveProperty("contract.code", "invalid-request");
});

it("still refuses an identical empty-paths repeat as unchanged", async () => {
  const tool = createGitDiffTool(repositoryExec(), {
    invocationObservation: { retryInvalidationTracker: createInvalidRequestTracker() },
  });
  const call = () => tool.execute("call", { paths: [] }, undefined, undefined, sessionContext());

  await expect(call()).rejects.toHaveProperty("contract.code", "invalid-request");
  await expect(call()).rejects.toHaveProperty("contract.code", "unchanged-invalid-request");
});
