import { describe, expect, it } from "vitest";
import {
  fingerprintProjectCommandDefinition,
  getProjectCommandDefinitions,
} from "../../src/tools/project-command/definitions.ts";

describe("project command definitions", () => {
  it("keeps descriptions out of stable command identities", () => {
    const definitions = getProjectCommandDefinitions();
    const definition = definitions[0];
    if (definition === undefined) {
      throw new Error("missing workspace_path definition");
    }
    const changedDescription = { ...definition, description: "A different description" };

    expect(fingerprintProjectCommandDefinition(changedDescription)).toBe(
      fingerprintProjectCommandDefinition(definition),
    );
  });
});
