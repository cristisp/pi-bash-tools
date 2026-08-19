import { describe, expect, it } from "vitest";
import {
  applyEnvironmentPolicyDecision,
  applyProjectCommandPolicyDecision,
  findEnvironmentPolicyDecision,
} from "./decisions.ts";
import { DEFAULT_CONFIRMATION_TIMEOUT_MS, parseEnvironmentPolicy, policyError } from "./format.ts";
import { parsePolicyDocument, serializePolicyDocument } from "./document.ts";

describe("shared policy format", () => {
  it("parses version one environment policies and applies precedence", () => {
    const projectPath = "/tmp/environment-project";
    const document = parsePolicyDocument(
      JSON.stringify({
        version: 1,
        global: { allow: ["GLOBAL_ALLOW"], deny: ["HARD_DENY"] },
        projects: {
          [projectPath]: { allow: ["PROJECT_ALLOW"], deny: ["PROJECT_DENY"] },
        },
      }),
    );
    if (document.version !== 1) {
      throw policyError();
    }
    const loaded = {
      projectPath,
      confirmationTimeoutMs: document.environment.confirmationTimeoutMs,
      document,
    };
    expect(findEnvironmentPolicyDecision(loaded, "HARD_DENY")).toBe("deny-global");
    expect(findEnvironmentPolicyDecision(loaded, "PROJECT_DENY")).toBe("deny-project");
    expect(findEnvironmentPolicyDecision(loaded, "GLOBAL_ALLOW")).toBe("allow-global");
    expect(findEnvironmentPolicyDecision(loaded, "PROJECT_ALLOW")).toBe("allow-project");
    expect(findEnvironmentPolicyDecision(loaded, "UNKNOWN")).toBe("unknown");
    expect(document.environment.confirmationTimeoutMs).toBe(DEFAULT_CONFIRMATION_TIMEOUT_MS);
  });

  it("rejects malformed, conflicting, wildcard, and project-timeout rules", () => {
    const invalidPolicies = [
      "{}",
      '{"version":2}',
      '{"version":1,"extra":true}',
      '{"version":1,"global":{"allow":["DUP","DUP"]}}',
      '{"version":1,"global":{"allow":["CONFLICT"],"deny":["CONFLICT"]}}',
      '{"version":1,"global":{"allow":["*"]}}',
      '{"version":1,"projects":{"relative":{"allow":["KEY"]}}}',
      '{"version":1,"projects":{"/tmp/project":{"confirmationTimeoutMs":1}}}',
      '{"version":1,"confirmationTimeoutMs":-1}',
    ];
    for (const text of invalidPolicies) {
      expect(() => parseEnvironmentPolicy(text)).toThrow(/invalid or unreadable/iu);
    }
  });

  it("keeps exact version one serialization for environment writes", () => {
    const document = parsePolicyDocument(
      JSON.stringify({ version: 1, global: { allow: ["TOKEN"], deny: [] } }),
    );
    expect(serializePolicyDocument(document)).toBe(`{
  "version": 1,
  "confirmationTimeoutMs": 120000,
  "global": {
    "allow": [
      "TOKEN"
    ],
    "deny": []
  },
  "projects": {}
}
`);
  });

  it("keeps environment-only updates at version one", () => {
    const document = parsePolicyDocument('{"version":1}');
    const next = applyEnvironmentPolicyDecision(document, "/tmp/project", "TOKEN", "allow-project");
    expect(next.version).toBe(1);
    expect(serializePolicyDocument(next)).toBe(`{
  "version": 1,
  "confirmationTimeoutMs": 120000,
  "global": {
    "allow": [],
    "deny": []
  },
  "projects": {
    "/tmp/project": {
      "allow": [
        "TOKEN"
      ],
      "deny": []
    }
  }
}
`);
  });

  it("serializes command migration and preserves both namespaces", () => {
    const identity = { commandId: "workspace_path", fingerprint: "a".repeat(64) };
    const versionOne = parsePolicyDocument('{"version":1}');
    const migrated = applyProjectCommandPolicyDecision(
      versionOne,
      "/tmp/project",
      identity,
      "allow-project",
      true,
    );
    expect(serializePolicyDocument(migrated)).toBe(`{
  "version": 2,
  "environment": {
    "version": 1,
    "confirmationTimeoutMs": 120000,
    "global": {
      "allow": [],
      "deny": []
    },
    "projects": {}
  },
  "projectCommands": {
    "version": 1,
    "global": {
      "allow": [],
      "deny": []
    },
    "projects": {
      "/tmp/project": {
        "allow": [
          {
            "commandId": "workspace_path",
            "fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        ],
        "deny": []
      }
    }
  }
}
`);
    const withEnvironment = applyEnvironmentPolicyDecision(
      migrated,
      "/tmp/project",
      "TOKEN",
      "allow-global",
    );
    expect(serializePolicyDocument(withEnvironment)).toContain('"projectCommands"');
    expect(serializePolicyDocument(withEnvironment)).toContain('"commandId": "workspace_path"');
  });
});
