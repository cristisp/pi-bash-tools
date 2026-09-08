import { describe, expect, it } from "vitest";

import { canonicalizeNodeScripts, hashNodeScripts } from "../../src/tools/project-command/node.ts";

describe("Node project command facade", () => {
  it("canonicalizes script key order while retaining script string identity", () => {
    expect(canonicalizeNodeScripts({ z: "z", a: "a" })).toBe('{"a":"a","z":"z"}');
    expect(hashNodeScripts({ a: "same", z: "same" })).toBe(
      hashNodeScripts({ z: "same", a: "same" }),
    );
    expect(hashNodeScripts({ a: "same" })).not.toBe(hashNodeScripts({ a: "changed" }));
  });
});
