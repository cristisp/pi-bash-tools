import { expect, it } from "vitest";
import { RESULT_CATEGORIES } from "../../src/tools/errors.ts";
import {
  getProjectCommandDefinition,
  type ProjectCommandDefinition,
} from "../../src/tools/project-command/definitions.ts";
import { projectCommandResultCategory } from "../../src/tools/project-command/categories.ts";
import type { ProjectCommandExecutionOutcome } from "../../src/tools/project-command/execution.ts";

function outcome(
  status: ProjectCommandExecutionOutcome["status"],
  code: number | null = status === "success" ? 0 : 1,
): ProjectCommandExecutionOutcome {
  return {
    status,
    exit: { code, signal: null },
    timedOut: status === "timeout",
    cancelled: status === "cancelled",
    executed: status !== "cancelled",
    stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
  };
}

function definition(commandId: string): ProjectCommandDefinition {
  const result = getProjectCommandDefinition(commandId);
  if (result === undefined) throw new Error(`missing ${commandId}`);
  return result;
}

it("publishes the stable result category set", () => {
  expect(RESULT_CATEGORIES).toEqual([
    "PASS",
    "INVALID_REQUEST",
    "IMPLEMENTATION_FAILURE",
    "TEST_FAILURE",
    "FORMAT_FAILURE",
    "LINT_FAILURE",
    "TYPE_CHECK_FAILURE",
    "RESOLUTION_FAILURE",
    "POLICY_FAILURE",
    "ENVIRONMENT_FAILURE",
    "TIMEOUT",
    "SPAWN_FAILURE",
    "CANCELLED",
    "BLOCKED",
  ]);
});

it("maps known command families from execution state without parsing output", () => {
  expect(projectCommandResultCategory(definition("workspace_path"), outcome("success"))).toBe(
    "PASS",
  );
  expect(projectCommandResultCategory(definition("fallow_health"), outcome("nonzero", 1))).toBe(
    "PASS",
  );
  expect(projectCommandResultCategory(definition("fallow_health"), outcome("nonzero", 2))).toBe(
    "IMPLEMENTATION_FAILURE",
  );
  expect(projectCommandResultCategory(definition("node_test"), outcome("nonzero"))).toBe(
    "TEST_FAILURE",
  );
  expect(projectCommandResultCategory(definition("node_test_coverage"), outcome("nonzero"))).toBe(
    "TEST_FAILURE",
  );
  expect(projectCommandResultCategory(definition("node_e2e"), outcome("nonzero"))).toBe(
    "TEST_FAILURE",
  );
  expect(projectCommandResultCategory(definition("node_format_check"), outcome("nonzero"))).toBe(
    "FORMAT_FAILURE",
  );
  expect(projectCommandResultCategory(definition("node_format_write"), outcome("nonzero"))).toBe(
    "FORMAT_FAILURE",
  );
  expect(projectCommandResultCategory(definition("node_lint"), outcome("nonzero"))).toBe(
    "LINT_FAILURE",
  );
  expect(projectCommandResultCategory(definition("node_lint_fix"), outcome("nonzero"))).toBe(
    "LINT_FAILURE",
  );
  expect(projectCommandResultCategory(definition("node_typecheck"), outcome("nonzero"))).toBe(
    "TYPE_CHECK_FAILURE",
  );
  expect(projectCommandResultCategory(definition("node_build"), outcome("nonzero"))).toBe(
    "IMPLEMENTATION_FAILURE",
  );
  expect(projectCommandResultCategory(definition("workspace_path"), outcome("timeout"))).toBe(
    "TIMEOUT",
  );
  expect(
    projectCommandResultCategory(definition("workspace_path"), outcome("spawn-failure", null)),
  ).toBe("SPAWN_FAILURE");
  expect(
    projectCommandResultCategory(definition("workspace_path"), outcome("cancelled", null)),
  ).toBe("CANCELLED");
});
