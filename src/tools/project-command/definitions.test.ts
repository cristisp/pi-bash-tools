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
      "node_project_info",
      "node_test",
      "node_build",
      "node_lint",
      "node_typecheck",
      "fallow_dead_code",
      "fallow_dupes",
      "fallow_health",
      "fallow_audit",
      "fallow_list_entry_points",
      "fallow_list_boundaries",
    ]);
    expect(
      definitions.every((definition) => definition.namespace === PROJECT_COMMAND_NAMESPACE),
    ).toBe(true);
    expect(definitions[0]).toMatchObject({
      commandId: "workspace_path",
      description:
        "Report the canonical project directory. Use when the user asks where the project workspace is located.",
      executable: "/bin/pwd",
      args: [],
      cwdStrategy: "canonical-project",
      sanitizedEnvironmentProfile: "minimal-static-v1",
    });
    expect(definitions[1]).toMatchObject({
      commandId: "node_version",
      description:
        "Report the Node.js runtime version. Use when the user asks which Node.js version is active.",
      executable: process.execPath,
      args: ["--version"],
    });
    expect(definitions.slice(2, 7)).toMatchObject([
      { commandId: "node_project_info", risk: "observe", globalSafe: true },
      {
        commandId: "node_test",
        risk: "project-code",
        globalSafe: false,
        fixedScriptKey: "test",
        truncationDirection: "tail",
        environmentProfile: "node-v1",
      },
      { commandId: "node_build", fixedScriptKey: "build" },
      { commandId: "node_lint", fixedScriptKey: "lint" },
      { commandId: "node_typecheck", fixedScriptKey: "typecheck" },
    ]);
    expect(definitions.slice(7)).toMatchObject([
      {
        commandId: "fallow_dead_code",
        executable: process.execPath,
        args: ["dead-code", "--format", "json", "--quiet"],
        risk: "project-code",
        globalSafe: false,
        applicability: "fallow-binary",
        binaryName: "fallow",
        acceptedExitCodes: [1],
        truncationDirection: "tail",
      },
      {
        commandId: "fallow_dupes",
        args: ["dupes", "--format", "json", "--quiet"],
      },
      {
        commandId: "fallow_health",
        args: ["health", "--format", "json", "--quiet"],
      },
      {
        commandId: "fallow_audit",
        args: ["audit", "--format", "json", "--quiet"],
        parameters: [{ name: "base", kind: "revision", required: true, mapping: "flag-value" }],
      },
      {
        commandId: "fallow_list_entry_points",
        args: ["list", "--entry-points", "--format", "json", "--quiet"],
      },
      {
        commandId: "fallow_list_boundaries",
        args: ["list", "--boundaries", "--format", "json", "--quiet"],
      },
    ]);
  });

  it("uses a stable Fallow launcher template without runtime audit parameters", () => {
    const definitions = getProjectCommandDefinitions().filter(
      (definition) => definition.applicability === "fallow-binary",
    );
    expect(definitions).toHaveLength(6);
    expect(
      definitions.every((definition) => definition.argvTemplate?.[0] === "<fallow-launcher>"),
    ).toBe(true);
    expect(
      definitions.find((definition) => definition.commandId === "fallow_audit")?.argvTemplate,
    ).toEqual(["<fallow-launcher>", "audit", "--format", "json", "--quiet"]);
    expect(
      definitions.every(
        (definition) => !JSON.stringify(definition.argvTemplate).includes("<base>"),
      ),
    ).toBe(true);

    const auditDefinition = definitions.find(
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

  it("keeps the catalog and its command arguments immutable", () => {
    const definitions = getProjectCommandDefinitions();

    expect(Object.isFrozen(definitions)).toBe(true);
    expect(definitions.every((definition) => Object.isFrozen(definition))).toBe(true);
    expect(definitions.every((definition) => Object.isFrozen(definition.args))).toBe(true);
    expect(() => Object.assign(definitions, { length: 0 })).toThrow();
    expect(() => Object.assign(definitions[0], { description: "changed" })).toThrow();
    expect(() => Object.assign(definitions[1].args, { 0: "changed" })).toThrow();
  });

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

  it("uses stable sha-256 identities that distinguish definitions", () => {
    const definitions = getProjectCommandDefinitions();
    const identities = definitions.map(projectCommandIdentity);
    expect(identities[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(identities[1]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(identities[0]?.fingerprint).not.toBe(identities[1]?.fingerprint);
    expect(identities[0]?.fingerprint).toBe(fingerprintProjectCommandDefinition(definitions[0]));
  });
});
