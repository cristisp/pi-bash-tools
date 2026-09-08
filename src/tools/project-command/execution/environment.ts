import { homedir } from "node:os";
import { dirname } from "node:path";

import type { ProjectCommandDefinition } from "../definitions.ts";

const STATIC_ENVIRONMENT: NodeJS.ProcessEnv = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
});

export const DEFAULT_KILL_GRACE_MS = 150;

export function environmentForProfile(
  profile: ProjectCommandDefinition["sanitizedEnvironmentProfile"],
): NodeJS.ProcessEnv {
  if (profile !== "node-v1") {
    return { ...STATIC_ENVIRONMENT };
  }
  return {
    ...STATIC_ENVIRONMENT,
    HOME: process.env.HOME ?? homedir(),
    CI: "true",
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  };
}
