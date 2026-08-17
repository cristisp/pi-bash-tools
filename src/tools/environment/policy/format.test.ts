import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIRMATION_TIMEOUT_MS,
  findEnvironmentPolicyDecision,
  parseEnvironmentPolicy,
} from "../policy.ts";

describe("environment policy format", () => {
  it("parses strict version one policies and applies precedence", () => {
    const projectPath = "/tmp/environment-project";
    const policy = parseEnvironmentPolicy(
      JSON.stringify({
        version: 1,
        global: { allow: ["GLOBAL_ALLOW"], deny: ["HARD_DENY"] },
        projects: {
          [projectPath]: { allow: ["PROJECT_ALLOW"], deny: ["PROJECT_DENY"] },
        },
      }),
    );
    expect(findEnvironmentPolicyDecision(policy, projectPath, "HARD_DENY")).toBe("deny-global");
    expect(findEnvironmentPolicyDecision(policy, projectPath, "PROJECT_DENY")).toBe("deny-project");
    expect(findEnvironmentPolicyDecision(policy, projectPath, "GLOBAL_ALLOW")).toBe("allow-global");
    expect(findEnvironmentPolicyDecision(policy, projectPath, "PROJECT_ALLOW")).toBe(
      "allow-project",
    );
    expect(findEnvironmentPolicyDecision(policy, projectPath, "UNKNOWN")).toBe("unknown");
    expect(policy.confirmationTimeoutMs).toBe(DEFAULT_CONFIRMATION_TIMEOUT_MS);
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
});
