import { describe, expect, it } from "vitest";
import extension from "./index.ts";

describe("bash tools extension", () => {
  it("exports a pi extension factory", () => {
    expect(extension).toBeTypeOf("function");
  });
});
