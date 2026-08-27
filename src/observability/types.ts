import type { SessionStartEvent, SourceInfo } from "@earendil-works/pi-coding-agent";

export const INVENTORY_FORMAT_VERSION = 1 as const;
export const INVENTORY_HASH_ALGORITHM = "sha256" as const;
export const TOOL_INVENTORY_ENTRY_TYPE = "bash-tools.tool-inventory" as const;

export type SessionStartReason = SessionStartEvent["reason"];

export interface ToolInventorySourceInfo {
  readonly path: SourceInfo["path"];
  readonly source: SourceInfo["source"];
  readonly scope: SourceInfo["scope"];
  readonly origin: SourceInfo["origin"];
  readonly baseDir?: SourceInfo["baseDir"];
}

export interface ToolInventoryEntry {
  readonly name: string;
  readonly active: boolean;
  readonly sourceInfo: ToolInventorySourceInfo;
  readonly schemaHash: string;
}

export interface ToolInventory {
  readonly inventoryFormatVersion: typeof INVENTORY_FORMAT_VERSION;
  readonly extensionVersion: string;
  readonly sessionId: string;
  readonly sessionStartReason: SessionStartReason;
  readonly hashAlgorithm: typeof INVENTORY_HASH_ALGORITHM;
  readonly activeTools: readonly string[];
  readonly tools: readonly ToolInventoryEntry[];
}
