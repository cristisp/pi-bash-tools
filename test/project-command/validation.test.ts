import { expect, it } from "vitest";

import { validateProjectCommandInput } from "../../src/tools/project-command/schema.ts";
import { validateVerifyInput } from "../../src/tools/verify/schema.ts";

it("normalizes a full-property execution payload with null placeholders for project_command", () => {
  expect(
    validateProjectCommandInput({
      commandId: "node_project_info",
      force: null,
      paths: null,
      variant: null,
      base: null,
      publish: null,
      covers: null,
      ref: null,
      flowId: null,
    }),
  ).toEqual({
    commandId: "node_project_info",
    coercions: [
      "force:null-to-absent",
      "paths:null-to-absent",
      "variant:null-to-absent",
      "base:null-to-absent",
      "publish:null-to-absent",
      "covers:null-to-absent",
      "ref:null-to-absent",
      "flowId:null-to-absent",
    ],
  });
});

it("classifies commandId null with a ref string as a lookup request", () => {
  expect(validateProjectCommandInput({ commandId: null, ref: "pc_example", flowId: null })).toEqual(
    {
      ref: "pc_example",
      coercions: ["commandId:null-to-absent", "flowId:null-to-absent"],
    },
  );
});

it("keeps lookup-only coercion payloads fail-closed for junk references", () => {
  expect(() =>
    validateProjectCommandInput({ commandId: "node_project_info", ref: "junk-string" }),
  ).toThrow(/lookup requests.*only.*ref.*flowId.*covers/iu);
  expect(() => validateProjectCommandInput({ ref: "" })).toThrow(/invalid/iu);
});

it("keeps non-null invalid values failing with unchanged messages", () => {
  expect(() => validateProjectCommandInput({ commandId: "fallow_audit", base: "--help" })).toThrow(
    /invalid/iu,
  );
  expect(() =>
    validateProjectCommandInput({ commandId: "node_lint", variant: "bad;command" }),
  ).toThrow(/invalid/iu);
  expect(() =>
    validateProjectCommandInput({ commandId: "node_project_info", covers: [42] }),
  ).toThrow(/covers/iu);
  expect(() =>
    validateProjectCommandInput({ ref: "pc_example", publish: { flowId: "flow-1" } }),
  ).toThrow(/lookup requests.*only/iu);
});

it("rejects null placeholders on unknown fields instead of stripping them", () => {
  expect(() =>
    validateProjectCommandInput({ commandId: "workspace_path", futureOption: null }),
  ).toThrow(/invalid/iu);
});

it("normalizes a full-property verify payload with null placeholders as execution", () => {
  expect(
    validateVerifyInput({
      paths: null,
      omit: ["typecheck"],
      scripts: null,
      continueOnFailure: null,
      ref: null,
      flowId: null,
      fresh: null,
      publish: null,
      covers: null,
    }),
  ).toEqual({
    paths: [],
    omit: ["typecheck"],
    scripts: {},
    continueOnFailure: false,
    fresh: false,
    covers: [],
    coercions: [
      "paths:null-to-absent",
      "scripts:null-to-absent",
      "continueOnFailure:null-to-absent",
      "ref:null-to-absent",
      "flowId:null-to-absent",
      "fresh:null-to-absent",
      "publish:null-to-absent",
      "covers:null-to-absent",
    ],
  });
});

it("keeps verify null classification fail-closed", () => {
  expect(() => validateVerifyInput({ ref: "bad.ref", fresh: false })).toThrow(
    /bounded reference/iu,
  );
  expect(() => validateVerifyInput({ futureOption: null })).toThrow(/unsupported field/iu);
});
