import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

import { createToolErrorDetailsStore, type ToolErrorDetailsStore } from "../error-details-store.ts";
import { VerifyToolError } from "./schema.ts";

export type VerifyErrorDetails = Readonly<Record<string, unknown>>;
export type VerifyErrorDetailsRecorder = ToolErrorDetailsStore["record"];
export type VerifyErrorDetailsStore = ToolErrorDetailsStore;

export function createVerifyErrorDetailsStore(): VerifyErrorDetailsStore {
  return createToolErrorDetailsStore();
}

function boundedDiagnostic(message: string): string {
  return message.length <= 2_048 ? message : `${message.slice(0, 2_045)}...`;
}

export function verifyToolErrorDetails(error: VerifyToolError): VerifyErrorDetails {
  return Object.freeze({
    ...error.details,
    diagnostic: boundedDiagnostic(error.message),
    ...(error.resultCategory === undefined ? {} : { resultCategory: error.resultCategory }),
    ...(error.executed === undefined ? {} : { executed: error.executed }),
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
  });
}

export interface VerifyToolResultHandlerResult {
  readonly details?: unknown;
}

export function createVerifyToolResultHandler(
  errorDetails: VerifyErrorDetailsStore,
): (event: ToolResultEvent) => VerifyToolResultHandlerResult | undefined {
  return (event) => {
    if (event.toolName !== "verify") return undefined;
    const details = errorDetails.take(event.toolCallId);
    return details === undefined ? undefined : { details };
  };
}
