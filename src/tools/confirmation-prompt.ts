export type TimedPromptResult =
  | { readonly kind: "selected"; readonly choice: string | undefined }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "error" };

export async function promptWithTimeout(
  select: (signal: AbortSignal) => Promise<string | undefined>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<TimedPromptResult> {
  if (signal?.aborted) {
    return { kind: "cancelled" };
  }
  const dialogController = new AbortController();
  let timedOut = false;
  let externallyCancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = (): void => undefined;
  const timeout = new Promise<TimedPromptResult>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      dialogController.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const cancellation = new Promise<TimedPromptResult>((resolve) => {
    if (signal === undefined) {
      return;
    }
    const onAbort = (): void => {
      externallyCancelled = true;
      dialogController.abort();
      resolve({ kind: "cancelled" });
    };
    removeAbortListener = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const selection = async (): Promise<TimedPromptResult> => {
    try {
      const choice = await select(dialogController.signal);
      return timedOut
        ? { kind: "timeout" }
        : externallyCancelled
          ? { kind: "cancelled" }
          : { kind: "selected", choice };
    } catch {
      return { kind: "error" };
    }
  };
  try {
    return await Promise.race([selection(), timeout, cancellation]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    removeAbortListener();
  }
}
