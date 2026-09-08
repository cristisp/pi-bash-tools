import { afterEach, describe, expect, it } from "vitest";

import {
  getProjectCommandDefinition,
  projectCommandIdentity,
} from "../../../src/tools/project-command/definitions.ts";
import { resolveFixedProjectCommand } from "../../../src/tools/project-command/resolution.ts";
import { createResolutionTestScope } from "./test-fixtures.ts";

const scope = createResolutionTestScope();

afterEach(scope.cleanup);

describe("fixed project command resolution", () => {
  it("resolves fixed commands without changing executable, arguments, or identity", () => {
    const definition = getProjectCommandDefinition("node_version");
    if (definition === undefined) {
      throw new Error("missing node_version definition");
    }
    const resolved = resolveFixedProjectCommand(definition);
    expect(resolved).toEqual({
      definition,
      executable: process.execPath,
      args: ["--version"],
    });
    expect(resolved.executable).toBe(definition.executable);
    expect(resolved.args).toBe(definition.args);
    expect(projectCommandIdentity(definition, resolved)).toEqual(
      projectCommandIdentity(definition),
    );
  });
});
