import type { ChildProcess } from "node:child_process";

function isAlreadyExited(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ESRCH"
  );
}

function sendSignal(child: ChildProcess, platform: NodeJS.Platform, signal: NodeJS.Signals): void {
  try {
    if (platform === "darwin") {
      const pid = child.pid;
      if (typeof pid !== "number") {
        throw new Error("process cleanup is unsupported");
      }
      process.kill(-pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (!isAlreadyExited(error)) {
      throw error;
    }
  }
}

function waitForCloseOrTimeout(close: Promise<void>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(closed);
    };
    void close.then(() => finish(true));
    setTimeout(() => finish(false), Math.max(0, milliseconds));
  });
}

export async function terminateChild(
  child: ChildProcess,
  platform: NodeJS.Platform,
  close: Promise<void>,
  graceMs: number,
): Promise<void> {
  let terminationError: unknown;
  try {
    sendSignal(child, platform, "SIGTERM");
  } catch (error) {
    terminationError = error;
  }
  if (!(await waitForCloseOrTimeout(close, graceMs))) {
    try {
      sendSignal(child, platform, "SIGKILL");
    } catch (error) {
      terminationError ??= error;
    }
    await close;
  }
  if (terminationError !== undefined) {
    throw terminationError;
  }
}
