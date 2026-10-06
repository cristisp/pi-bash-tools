import { describe, expect, it } from "vitest";

import { toJsonValue } from "../../src/tools/value-validation.ts";

describe("toJsonValue", () => {
  it("passes JSON primitives through", () => {
    expect(toJsonValue(null)).toBe(null);
    expect(toJsonValue(false)).toBe(false);
    expect(toJsonValue(42)).toBe(42);
    expect(toJsonValue("text")).toBe("text");
  });

  it("drops undefined object properties like JSON.stringify", () => {
    expect(toJsonValue({ present: "x", absent: undefined })).toEqual({ present: "x" });
    expect(toJsonValue({ present: "x", absent: undefined })).toEqual(
      JSON.parse(JSON.stringify({ present: "x", absent: undefined })),
    );
  });

  it("maps undefined array elements to null", () => {
    expect(toJsonValue(["x", undefined, 1])).toEqual(["x", null, 1]);
  });

  it("recurses into nested values", () => {
    expect(toJsonValue({ outer: { inner: ["x", undefined] } })).toEqual({
      outer: { inner: ["x", null] },
    });
  });

  it("rejects values JSON.stringify also rejects", () => {
    expect(() => toJsonValue(() => undefined)).toThrow(TypeError);
    expect(() => toJsonValue(1n)).toThrow(TypeError);
    expect(() => toJsonValue(Symbol("x"))).toThrow(TypeError);
    expect(() => toJsonValue(Number.NaN)).toThrow(TypeError);
  });

  it("rejects non-plain objects instead of stringifying them", () => {
    expect(() => toJsonValue(new Date(0))).toThrow(TypeError);
    expect(() => toJsonValue(new Map())).toThrow(TypeError);
  });

  it("accepts null-prototype objects", () => {
    const value: Record<string, unknown> = { path: "src/file.ts" };
    Object.setPrototypeOf(value, null);
    expect(toJsonValue(value)).toEqual({ path: "src/file.ts" });
  });

  it("matches a JSON.stringify round trip", () => {
    const value = {
      repositoryRoot: "/repo",
      entries: [{ path: "a", indexStatus: "M", worktreeStatus: " " }],
      head: undefined,
    };
    expect(JSON.parse(JSON.stringify(toJsonValue(value)))).toEqual(
      JSON.parse(JSON.stringify(value)),
    );
  });
});
