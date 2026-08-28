import { expect, it } from "vitest";
import {
  fingerprintProjectCommandDefinition,
  getProjectCommandDefinitions,
  projectCommandIdentity,
  projectCommandReusePolicy,
  normalizeProjectCommandReusePolicy,
} from "../../src/tools/project-command/definitions.ts";

it("keeps the catalog and its command arguments immutable", () => {
  const definitions = getProjectCommandDefinitions();

  expect(Object.isFrozen(definitions)).toBe(true);
  expect(definitions.every((definition) => Object.isFrozen(definition))).toBe(true);
  expect(definitions.every((definition) => Object.isFrozen(definition.args))).toBe(true);
  expect(() => Object.assign(definitions, { length: 0 })).toThrow();
  expect(() => Object.assign(definitions[0], { description: "changed" })).toThrow();
  expect(() => Object.assign(definitions[1].args, { 0: "changed" })).toThrow();
});

it("keeps audit identities independent of the selected base revision", () => {
  const auditDefinition = getProjectCommandDefinitions().find(
    (definition) => definition.commandId === "fallow_audit",
  );
  if (auditDefinition === undefined) throw new Error("missing Fallow audit definition");
  const resolved = (base: string) => ({
    executable: process.execPath,
    args: [...auditDefinition.args, "--base", base],
    fingerprintArgs: auditDefinition.argvTemplate,
  });
  expect(fingerprintProjectCommandDefinition(auditDefinition, resolved("HEAD~1"))).toBe(
    fingerprintProjectCommandDefinition(auditDefinition, resolved("origin/main")),
  );

  const changedTemplate = {
    ...auditDefinition,
    argvTemplate: [...(auditDefinition.argvTemplate ?? []), "<static-change>"],
  };
  expect(fingerprintProjectCommandDefinition(changedTemplate)).not.toBe(
    fingerprintProjectCommandDefinition(auditDefinition),
  );
});

it("includes static catalog metadata and resolved script hashes in identities", () => {
  const definition = getProjectCommandDefinitions().find(
    (candidate) => candidate.commandId === "node_test",
  );
  if (definition === undefined) throw new Error("missing node_test definition");
  const base = fingerprintProjectCommandDefinition(definition);
  const withHash = fingerprintProjectCommandDefinition(definition, {
    executable: "/usr/bin/npm",
    args: ["run", "test"],
    fingerprintArgs: definition.argvTemplate,
    scriptHash: "a".repeat(64),
  });
  expect(withHash).not.toBe(base);
  expect(
    fingerprintProjectCommandDefinition(definition, {
      executable: "/usr/bin/npm",
      args: ["run", "test", "--", "one.ts"],
      fingerprintArgs: definition.argvTemplate,
      scriptHash: "a".repeat(64),
    }),
  ).toBe(withHash);
});

it("defaults unknown policies to never and gates unsafe definitions", () => {
  const workspaceDefinition = getProjectCommandDefinitions()[0];
  if (workspaceDefinition === undefined) throw new Error("missing workspace_path definition");
  expect(normalizeProjectCommandReusePolicy(undefined)).toBe("never");
  expect(normalizeProjectCommandReusePolicy("future-policy")).toBe("never");
  expect(projectCommandReusePolicy(workspaceDefinition)).toBe("static");
  expect(
    projectCommandReusePolicy({ ...workspaceDefinition, reusePolicy: "project-metadata" }),
  ).toBe("project-metadata");
  expect(
    projectCommandReusePolicy({
      ...workspaceDefinition,
      mutatesWorkspace: true,
      reusePolicy: "static",
    }),
  ).toBe("never");
  expect(
    projectCommandReusePolicy({
      ...workspaceDefinition,
      uncontrolledExternalState: true,
      reusePolicy: "static",
    }),
  ).toBe("never");
  expect(
    projectCommandReusePolicy({ ...workspaceDefinition, reusePolicy: "workspace-snapshot" }),
  ).toBe("never");
  expect(
    projectCommandReusePolicy({
      ...workspaceDefinition,
      reusePolicy: "workspace-snapshot",
      workspaceSnapshotApproved: true,
    }),
  ).toBe("workspace-snapshot");
});

it("keeps reuse metadata separate from authorization identity", () => {
  const definition = getProjectCommandDefinitions()[0];
  if (definition === undefined) throw new Error("missing workspace_path definition");
  expect(projectCommandIdentity({ ...definition, reusePolicy: "project-metadata" })).toEqual(
    projectCommandIdentity(definition),
  );
});

it("uses stable sha-256 identities that distinguish definitions", () => {
  const definitions = getProjectCommandDefinitions();
  const identities = definitions.map(projectCommandIdentity);
  expect(identities[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(identities[1]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(identities[0]?.fingerprint).not.toBe(identities[1]?.fingerprint);
  expect(identities[0]?.fingerprint).toBe(fingerprintProjectCommandDefinition(definitions[0]));
});
