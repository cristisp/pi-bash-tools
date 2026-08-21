import { afterEach, describe, it } from "vitest";
import { getProjectCommandDefinition } from "../../../src/tools/project-command/definitions.ts";
import { resolveProjectCommand } from "../../../src/tools/project-command/resolution.ts";
import {
  createProjectDirectory,
  createResolutionTestScope,
  expectResolutionError,
} from "./test-fixtures.ts";

const scope = createResolutionTestScope();

afterEach(scope.cleanup);

describe("Fallow project binary availability", () => {
  it("fails closed when a Fallow project binary is unavailable", async () => {
    const directory = await createProjectDirectory(scope);
    const definition = getProjectCommandDefinition("fallow_health");
    if (definition === undefined) throw new Error("missing Fallow definition");
    await expectResolutionError(
      resolveProjectCommand(definition, directory, undefined),
      "binary-resolution",
      "missing-node-modules-root",
    );
  });
});
