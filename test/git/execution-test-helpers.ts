import { readFile } from "node:fs/promises";

import { CHILD_TERMINATION_GRACE_MS } from "../../src/tools/git/execution.ts";

export function waitForPid(pidPath: string, attempt = 0): Promise<number> {
  return readFile(pidPath, "utf8")
    .then((value) => Number(value))
    .catch((error: unknown) => {
      if (attempt >= 100) throw error;
      return new Promise<number>((resolve) => setTimeout(resolve, 5)).then(() =>
        waitForPid(pidPath, attempt + 1),
      );
    });
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

export function waitForProcessGone(pid: number, attempt = 0): Promise<boolean> {
  if (processIsGone(pid)) return Promise.resolve(true);
  if (attempt >= 100) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => setTimeout(resolve, 5)).then(() =>
    waitForProcessGone(pid, attempt + 1),
  );
}

export interface ParkedChildPaths {
  readonly pidPath: string;
  readonly terminatePath: string;
  readonly exitPath: string;
  readonly beforePark?: string;
}

export function parkedChildSource(paths: ParkedChildPaths): string {
  return [
    "const fs = require('node:fs');",
    "process.stdout.on('error', () => {});",
    "process.stderr.on('error', () => {});",
    `fs.writeFileSync(${JSON.stringify(paths.pidPath)}, String(process.pid));`,
    `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(paths.terminatePath)}, 'terminated'); });`,
    `process.on('SIGUSR1', () => { fs.writeFileSync(${JSON.stringify(paths.exitPath)}, 'released'); process.exit(0); });`,
    paths.beforePark ?? "",
    "setInterval(() => {}, 1000);",
  ].join(" ");
}

export function waitForFile(path: string, attempt = 0): Promise<string> {
  return readFile(path, "utf8").catch((error: unknown) => {
    if (attempt >= 400) throw error;
    return new Promise<string>((resolve) => setTimeout(resolve, 2)).then(() =>
      waitForFile(path, attempt + 1),
    );
  });
}

const STILL_PENDING = "still-pending";

export async function expectStillPending(pending: Promise<unknown>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const outcome = await Promise.race([
    pending.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<typeof STILL_PENDING>((resolve) => setTimeout(() => resolve(STILL_PENDING), 0)),
  ]);
  if (outcome !== STILL_PENDING) {
    throw new Error("boundedGitExec settled before the child emitted close");
  }
}

export function releaseParkedChild(pid: number): void {
  const escalationWon = new Error(
    `child ${pid} was already killed when the SIGUSR1 release was attempted: the ` +
      `CHILD_TERMINATION_GRACE_MS (${CHILD_TERMINATION_GRACE_MS} ms) escalation window was exhausted ` +
      "by an event-loop stall in the test harness, not by a change in termination ordering",
  );
  if (processIsGone(pid)) {
    throw escalationWon;
  }
  try {
    process.kill(pid, "SIGUSR1");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      throw escalationWon;
    }
    throw error;
  }
}
