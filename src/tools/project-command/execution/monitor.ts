import type { ChildProcess } from "node:child_process";

import type { ProjectCommandExit } from "../execution.ts";
import { Capture } from "./capture.ts";
import { terminateChild } from "./termination.ts";

export interface ChildRunState {
  exit: ProjectCommandExit;
  spawnFailure: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

export interface ChildMonitor {
  readonly state: ChildRunState;
  readonly close: Promise<void>;
  readonly termination: () => Promise<void> | undefined;
  readonly requestTermination: () => Promise<void>;
}

export function setupChildMonitor(
  child: ChildProcess,
  stdout: Capture,
  stderr: Capture,
  platform: NodeJS.Platform,
  graceMs: number,
): ChildMonitor {
  const state: ChildRunState = {
    exit: { code: null, signal: null },
    spawnFailure: false,
    timedOut: false,
    cancelled: false,
  };
  let closeResolve!: () => void;
  const close = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  const onClose = (code: number | null, childSignal: NodeJS.Signals | null): void => {
    state.exit = {
      code: typeof code === "number" ? code : null,
      signal: typeof childSignal === "string" ? childSignal : null,
    };
    closeResolve();
  };
  let termination: Promise<void> | undefined;
  const requestTermination = (): Promise<void> => {
    termination ??= terminateChild(child, platform, close, graceMs).catch(() => undefined);
    return termination;
  };
  const onError = (): void => {
    state.spawnFailure = true;
    void requestTermination();
  };
  child.once("error", onError);
  child.once("close", onClose);
  child.stdout!.on("data", (chunk: Buffer | string) => stdout.append(chunk));
  child.stderr!.on("data", (chunk: Buffer | string) => stderr.append(chunk));
  return { state, close, termination: () => termination, requestTermination };
}

export async function monitorChild(
  monitor: ChildMonitor,
  signal: AbortSignal | undefined,
  processTimeoutMs: number,
): Promise<ChildRunState> {
  const onAbort = (): void => {
    monitor.state.cancelled = true;
    void monitor.requestTermination();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutId = setTimeout(
    () => {
      monitor.state.timedOut = true;
      void monitor.requestTermination();
    },
    Math.max(0, processTimeoutMs),
  );
  if (signal?.aborted) {
    onAbort();
  }
  try {
    await monitor.close;
    const termination = monitor.termination();
    if (termination !== undefined) {
      await termination;
    }
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onAbort);
  }
  return monitor.state;
}
