import { describe, expect, it } from "vitest";
import { displayPath } from "./path-display.ts";

describe("displayPath", () => {
  const home = "/Users/alice";

  it("shortens the home directory itself", () => {
    expect(displayPath(home, home)).toBe("~");
  });

  it("shortens paths below the home directory", () => {
    expect(displayPath(`${home}/project/src`, home)).toBe("~/project/src");
  });

  it("does not shorten paths with a shared prefix outside the home directory", () => {
    expect(displayPath("/Users/alice-other/project", home)).toBe("/Users/alice-other/project");
  });

  it("does not shorten paths outside the home directory", () => {
    expect(displayPath("/Volumes/work/project", home)).toBe("/Volumes/work/project");
  });
});
