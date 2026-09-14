import { describe, expect, it } from "vitest";

import {
  FilesystemPathResolutionError,
  asPathResolutionError,
  classifyPathResolutionFailure,
  filesystemPathResolutionActions,
  pathResolutionDiagnostic,
  pathResolutionFailureDetails,
  type FilesystemPathResolutionReason,
} from "../../src/tools/filesystem/path-resolution-diagnostics.ts";

const reasons: readonly FilesystemPathResolutionReason[] = [
  "missing-target",
  "unreadable",
  "symlink",
  "control-character",
  "wildcard-path",
  "invalid-path-form",
  "unknown",
];

function errorWithCode(code: string): Error {
  return Object.assign(new Error(`failed with ${code}`), { code });
}

describe("filesystem path resolution diagnostics", () => {
  it("classifies every bounded reason from its failing resolution step", () => {
    expect(classifyPathResolutionFailure(errorWithCode("ENOENT"))).toBe("missing-target");
    expect(classifyPathResolutionFailure(errorWithCode("ENOTDIR"))).toBe("missing-target");
    expect(classifyPathResolutionFailure(errorWithCode("EACCES"))).toBe("unreadable");
    expect(classifyPathResolutionFailure(errorWithCode("EPERM"))).toBe("unreadable");
    expect(classifyPathResolutionFailure(errorWithCode("ELOOP"))).toBe("symlink");
    expect(
      classifyPathResolutionFailure(new Error("Filesystem path contains a symbolic link")),
    ).toBe("symlink");
    expect(classifyPathResolutionFailure(new Error("policy invalid"), "/tmp/bad\nname")).toBe(
      "control-character",
    );
    expect(classifyPathResolutionFailure(new Error("policy invalid"), "/tmp/bad*name")).toBe(
      "wildcard-path",
    );
    expect(classifyPathResolutionFailure(new Error("policy invalid"), "/tmp/bad[name")).toBe(
      "wildcard-path",
    );
    expect(classifyPathResolutionFailure(new Error("policy invalid"), "relative/path")).toBe(
      "invalid-path-form",
    );
    expect(classifyPathResolutionFailure(new Error("anything else"))).toBe("unknown");
  });

  it("is idempotent for typed resolution errors", () => {
    for (const reason of reasons) {
      const error = new FilesystemPathResolutionError(reason);
      expect(classifyPathResolutionFailure(error)).toBe(reason);
      expect(asPathResolutionError(error)).toBe(error);
    }
  });

  it("uses a fixed message per reason and preserves the symbolic link message", () => {
    expect(new FilesystemPathResolutionError("symlink").message).toBe(
      "Filesystem path contains a symbolic link",
    );
    for (const reason of reasons) {
      const error = new FilesystemPathResolutionError(reason);
      expect(error.name).toBe("FilesystemPathResolutionError");
      expect(error.reason).toBe(reason);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it("wraps untyped errors with the classified reason and preserves the cause", () => {
    const cause = errorWithCode("EACCES");
    const error = asPathResolutionError(cause);
    expect(error.reason).toBe("unreadable");
    expect(error.cause).toBe(cause);
  });

  it("attaches a bounded reason and action without path content", () => {
    expect(pathResolutionFailureDetails(errorWithCode("ENOENT"))).toEqual({
      resolutionFailure: {
        reason: "missing-target",
        action: filesystemPathResolutionActions["missing-target"],
      },
    });
    expect(pathResolutionDiagnostic(new Error("unexpected failure"))).toEqual({
      reason: "unknown",
      action: filesystemPathResolutionActions.unknown,
    });
    expect(Object.keys(filesystemPathResolutionActions).sort()).toEqual([...reasons].sort());
    for (const reason of reasons) {
      const action = filesystemPathResolutionActions[reason];
      expect(action.length).toBeGreaterThan(0);
      expect(action.length).toBeLessThanOrEqual(120);
    }
    const sensitive = pathResolutionFailureDetails(
      new Error("policy invalid"),
      "/tmp/secret\npath",
    );
    expect(JSON.stringify(sensitive)).not.toContain("secret");
    expect(JSON.stringify(sensitive)).not.toContain("/tmp");
  });
});
