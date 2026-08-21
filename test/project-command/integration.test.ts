import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIntegrationFixture,
  createProjectCommandIntegrationScope,
} from "./integration-fixtures.ts";

const scope = createProjectCommandIntegrationScope();

afterEach(scope.cleanup);

describe("project command integration fixtures", () => {
  it("creates a real project fixture and a tracked policy directory", async () => {
    const { fixture, userAgent } = await createIntegrationFixture(
      scope,
      "bash-tools-project-command-fixture-policy-",
    );
    expect(await readFile(`${fixture.directory}/package.json`, "utf8")).toContain(
      "bash-tools-fixture",
    );
    expect(userAgent).not.toBe(fixture.directory);
  });
});
