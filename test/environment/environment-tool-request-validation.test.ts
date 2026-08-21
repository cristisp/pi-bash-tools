import { afterEach, describe, expect, it } from "vitest";
import { createEnvironmentToolForTesting } from "../../src/tools/environment/environment-tool.ts";
import { createEnvironmentToolTestFixtures } from "./environment-tool-test-fixtures.ts";

const fixtures = createEnvironmentToolTestFixtures();

afterEach(() => fixtures.cleanup());

describe("environment tool request validation", () => {
  it("requires unique valid keys and returns null without enumerating the environment", async () => {
    const fixture = await fixtures.createPolicyFixture({ allow: ["EXPLICIT", "ABSENT"] });
    const source = {
      EXPLICIT: "",
      ABSENT: undefined,
      SECRET: "must not be read",
    };
    const environment = new Proxy(source, {
      ownKeys: () => {
        throw new Error("environment enumeration is forbidden");
      },
    });
    const tool = createEnvironmentToolForTesting({
      configPath: fixture.configPath,
      environment,
    });
    const response = await tool.execute(
      "1",
      { keys: ["EXPLICIT", "ABSENT"] },
      undefined,
      undefined,
      fixtures.context(fixture.directory),
    );
    expect(response.details).toEqual({ values: { EXPLICIT: "", ABSENT: null } });
    await expect(
      tool.execute(
        "2",
        { keys: ["EXPLICIT", "EXPLICIT"] },
        undefined,
        undefined,
        fixtures.context(fixture.directory),
      ),
    ).rejects.toThrow(/unique valid/iu);
    await expect(
      tool.execute(
        "3",
        { keys: ["NOT-VALID"] },
        undefined,
        undefined,
        fixtures.context(fixture.directory),
      ),
    ).rejects.toThrow(/unique valid/iu);
  });
});
