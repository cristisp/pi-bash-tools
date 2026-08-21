import { decodeUtf8Prefix, decodeUtf8Suffix } from "../../truncation.ts";
import {
  PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
  type ProjectCommandDefinition,
} from "../definitions.ts";
import type {
  ProjectCommandExecutionOutcome,
  ProjectCommandExecutionStatus,
  ProjectCommandOutput,
} from "../execution.ts";

export class Capture {
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;
  private lineBreaks = 0;
  private hasContentSinceLineBreak = false;
  private previousWasCarriageReturn = false;
  private tailBytes = Buffer.alloc(0);

  constructor(
    private readonly limit: number,
    private readonly direction: "head" | "tail",
  ) {}

  append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.totalBytes += chunk.byteLength;
    for (const byte of chunk) {
      if (byte === 0x0d) {
        this.lineBreaks += 1;
        this.hasContentSinceLineBreak = false;
        this.previousWasCarriageReturn = true;
      } else if (byte === 0x0a) {
        if (!this.previousWasCarriageReturn) {
          this.lineBreaks += 1;
        }
        this.hasContentSinceLineBreak = false;
        this.previousWasCarriageReturn = false;
      } else {
        this.hasContentSinceLineBreak = true;
        this.previousWasCarriageReturn = false;
      }
    }
    if (this.direction === "head") {
      if (this.retainedBytes >= this.limit) {
        return;
      }
      const retained = chunk.subarray(0, this.limit - this.retainedBytes);
      this.chunks.push(retained);
      this.retainedBytes += retained.byteLength;
      return;
    }
    if (this.limit === 0) {
      return;
    }
    const combined = Buffer.concat([this.tailBytes, chunk]);
    this.tailBytes = combined.subarray(Math.max(0, combined.byteLength - this.limit));
  }

  output(): ProjectCommandOutput {
    const bytes =
      this.direction === "head" ? Buffer.concat(this.chunks, this.retainedBytes) : this.tailBytes;
    const truncated = this.totalBytes > this.limit;
    return {
      text:
        this.direction === "head"
          ? decodeUtf8Prefix(bytes, this.limit, truncated)
          : decodeUtf8Suffix(bytes),
      truncated,
      totalBytes: this.totalBytes,
      totalLines:
        this.totalBytes === 0 ? 0 : this.lineBreaks + (this.hasContentSinceLineBreak ? 1 : 0),
    };
  }
}

function emptyOutput(): ProjectCommandOutput {
  return { text: "", truncated: false, totalBytes: 0, totalLines: 0 };
}

export function emptyOutcome(
  status: ProjectCommandExecutionStatus,
): ProjectCommandExecutionOutcome {
  return {
    status,
    exit: { code: null, signal: null },
    timedOut: status === "timeout",
    cancelled: status === "cancelled",
    stdout: emptyOutput(),
    stderr: emptyOutput(),
  };
}

export function outcomeWithOutput(
  status: ProjectCommandExecutionStatus,
  stdout: Capture,
  stderr: Capture,
): ProjectCommandExecutionOutcome {
  const empty = emptyOutcome(status);
  return { ...empty, stdout: stdout.output(), stderr: stderr.output() };
}

export function outputCaptures(definition: ProjectCommandDefinition): {
  readonly stdout: Capture;
  readonly stderr: Capture;
} {
  const limit = Math.min(definition.outputLimitBytes, PROJECT_COMMAND_OUTPUT_LIMIT_BYTES);
  const direction = definition.truncationDirection ?? "head";
  return {
    stdout: new Capture(limit, direction),
    stderr: new Capture(limit, direction),
  };
}
