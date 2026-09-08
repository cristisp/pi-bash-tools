import { afterEach, describe, expect, it } from "vitest";

import { getProjectCommandDefinition } from "../../../src/tools/project-command/definitions.ts";
import { resolveProjectCommand } from "../../../src/tools/project-command/resolution.ts";
import { createResolutionTestScope } from "./test-fixtures.ts";

const scope = createResolutionTestScope();

afterEach(scope.cleanup);

describe("Fallow project command applicability", () => {
  it("dispatches only the fallow-binary applicability to Fallow resolution", async () => {
    const definition = getProjectCommandDefinition("fallow_health");
    if (definition === undefined) throw new Error("missing Fallow definition");
    const nonFallowApplicability = { ...definition, applicability: "always" as const };

    const resolved = await resolveProjectCommand(
      nonFallowApplicability,
      "/missing-project",
      undefined,
    );

    expect(resolved.executable).toBe(definition.executable);
    expect(resolved.args).toBe(definition.args);
  });
});
