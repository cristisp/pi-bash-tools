import { describe, expect, it } from "vitest";
import {
  applyProjectCommandPolicyDecision,
  findProjectCommandPolicyDecision,
} from "./policy-decisions.ts";
import { createEmptyProjectCommandPolicy } from "../environment/policy/document.ts";

const projectPath = "/tmp/project-command-policy";
const identity = { commandId: "workspace_path", fingerprint: "a".repeat(64) };
const otherIdentity = { commandId: "workspace_path", fingerprint: "b".repeat(64) };

function add(
  decision: "deny-global" | "deny-project" | "allow-global" | "allow-project",
  command = identity,
  globalSafe = true,
) {
  return applyProjectCommandPolicyDecision(
    createEmptyProjectCommandPolicy(),
    projectPath,
    command,
    decision,
    globalSafe,
  );
}

describe("project command policy precedence", () => {
  it("uses global deny, project deny, global allow, project allow, then unknown", () => {
    const globalDeny = add("deny-global");
    const projectAllow = {
      ...globalDeny,
      projects: { [projectPath]: { allow: [identity], deny: [] } },
    };
    expect(findProjectCommandPolicyDecision(projectAllow, projectPath, identity, true)).toBe(
      "deny-global",
    );

    const projectDeny = add("deny-project");
    const globalAllow = {
      ...projectDeny,
      global: { allow: [identity], deny: [] },
    };
    expect(findProjectCommandPolicyDecision(globalAllow, projectPath, identity, true)).toBe(
      "deny-project",
    );

    const globallyAllowed = add("allow-global");
    expect(findProjectCommandPolicyDecision(globallyAllowed, projectPath, identity, true)).toBe(
      "allow-global",
    );
    expect(findProjectCommandPolicyDecision(globallyAllowed, projectPath, identity, false)).toBe(
      "unknown",
    );
    expect(
      findProjectCommandPolicyDecision(add("allow-project"), projectPath, identity, true),
    ).toBe("allow-project");
    expect(
      findProjectCommandPolicyDecision(
        createEmptyProjectCommandPolicy(),
        projectPath,
        identity,
        true,
      ),
    ).toBe("unknown");
  });

  it("isolates stale fingerprints and rejects unsafe global approvals", () => {
    const policy = add("allow-project", otherIdentity);
    expect(findProjectCommandPolicyDecision(policy, projectPath, identity, true)).toBe("unknown");
    expect(() => add("allow-global", identity, false)).toThrow(/invalid or unreadable/iu);
  });
});
