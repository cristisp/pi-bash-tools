import { describe, expect, it } from "vitest";
import {
  PROJECT_COMMAND_NAMESPACE,
  fingerprintProjectCommandDefinition,
  getProjectCommandDefinitions,
  projectCommandIdentity,
} from "./definitions.ts";

describe("project command definitions", () => {
  it("contains exactly the extension-owned prototype catalog", () => {
    const definitions = getProjectCommandDefinitions();
    expect(definitions.map((definition) => definition.commandId)).toEqual([
      "workspace_path",
      "node_version",
    ]);
    expect(
      definitions.every((definition) => definition.namespace === PROJECT_COMMAND_NAMESPACE),
    ).toBe(true);
    expect(definitions[0]).toMatchObject({
      executable: "/bin/pwd",
      args: [],
      cwdStrategy: "canonical-project",
      sanitizedEnvironmentProfile: "minimal-static-v1",
    });
    expect(definitions[1]).toMatchObject({
      executable: process.execPath,
      args: ["--version"],
    });
  });

  it("uses stable sha-256 identities that distinguish definitions", () => {
    const definitions = getProjectCommandDefinitions();
    const identities = definitions.map(projectCommandIdentity);
    expect(identities[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(identities[1]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(identities[0]?.fingerprint).not.toBe(identities[1]?.fingerprint);
    expect(identities[0]?.fingerprint).toBe(fingerprintProjectCommandDefinition(definitions[0]));
  });
});
