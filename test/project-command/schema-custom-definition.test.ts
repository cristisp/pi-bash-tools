import { expect, it } from "vitest";

import type { ProjectCommandDefinition } from "../../src/tools/project-command/definitions.ts";
import {
  createProjectCommandInputSchema,
  validateProjectCommandInput,
} from "../../src/tools/project-command/schema.ts";

it("uses the supplied definitions for schema and validation", () => {
  const customDefinition = {
    namespace: "bash-tools.project-command",
    commandId: "custom_command",
    description: "Run the custom command.",
    executable: "/bin/echo",
    args: ["custom"],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "minimal-static-v1",
    processTimeoutMs: 30_000,
    outputLimitBytes: 50 * 1024,
    risk: "workspace-observation",
    globalSafe: true,
  } satisfies ProjectCommandDefinition<"custom_command">;
  const definitions = [customDefinition] as const;
  const schema = createProjectCommandInputSchema(definitions);

  expect(JSON.stringify(schema)).toContain('"const":"custom_command"');
  expect(JSON.stringify(schema)).toContain("Run the custom command.");
  expect(validateProjectCommandInput({ commandId: "custom_command" }, definitions)).toEqual({
    commandId: "custom_command",
  });
  expect(() => validateProjectCommandInput({ commandId: "workspace_path" }, definitions)).toThrow(
    /invalid/iu,
  );
  expect(() => validateProjectCommandInput({ commandId: "custom_command" })).toThrow(/invalid/iu);
});
