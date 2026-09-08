import { describe, expect, it } from "vitest";

import { RESULT_CATEGORIES, suggestedActionForCategory } from "../src/tools/errors.ts";

describe("tool error categories", () => {
  it("provides a retry-oriented action for every non-pass category", () => {
    const expected = {
      INVALID_REQUEST: "Correct the invalid request field and retry the command.",
      IMPLEMENTATION_FAILURE: "Inspect the command diagnostics before retrying the request.",
      TEST_FAILURE: "Review the test diagnostics, fix the failures, and rerun the command.",
      FORMAT_FAILURE:
        "Review the formatting diagnostics, fix the project files, and rerun the command.",
      LINT_FAILURE: "Review the lint diagnostics, fix the project files, and rerun the command.",
      TYPE_CHECK_FAILURE:
        "Review the type-check diagnostics, fix the project files, and rerun the command.",
      RESOLUTION_FAILURE: "Review the project metadata and dependencies, then retry the command.",
      POLICY_FAILURE: "Review the project command policy configuration, then retry the request.",
      ENVIRONMENT_FAILURE:
        "Review the project environment and dependencies, then retry the command.",
      TIMEOUT: "Review the command duration and project state before retrying the request.",
      SPAWN_FAILURE:
        "Verify that the required executable and project dependencies are available, then retry.",
      CANCELLED: "Retry the request if the command is still needed.",
      BLOCKED: "Request authorization or adjust the project command policy before retrying.",
    } as const;

    expect(RESULT_CATEGORIES).toHaveLength(Object.keys(expected).length + 1);
    for (const category of RESULT_CATEGORIES) {
      if (category === "PASS") {
        expect(suggestedActionForCategory(category)).toBeUndefined();
      } else {
        expect(suggestedActionForCategory(category)).toBe(expected[category]);
      }
    }
  });
});
