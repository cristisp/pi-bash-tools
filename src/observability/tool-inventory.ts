import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { hashToolParameters, serializeCanonicalJson } from "./canonical-json.ts";
import { EXTENSION_VERSION } from "../version.ts";
import {
  INVENTORY_FORMAT_VERSION,
  INVENTORY_HASH_ALGORITHM,
  TOOL_INVENTORY_ENTRY_TYPE,
  type ToolInventory,
  type ToolInventoryEntry,
  type ToolInventorySourceInfo,
} from "./types.ts";

export type ToolInventoryAPI = Pick<ExtensionAPI, "appendEntry" | "getActiveTools" | "getAllTools">;
export type ToolInventoryContext = {
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
};

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sourceInfo(info: ToolInfo["sourceInfo"]): ToolInventorySourceInfo {
  const minimized: ToolInventorySourceInfo = {
    path: info.path,
    source: info.source,
    scope: info.scope,
    origin: info.origin,
  };
  if (info.baseDir !== undefined) {
    return { ...minimized, baseDir: info.baseDir };
  }
  return minimized;
}

function inventoryEntry(tool: ToolInfo, activeTools: ReadonlySet<string>): ToolInventoryEntry {
  return {
    name: tool.name,
    active: activeTools.has(tool.name),
    sourceInfo: sourceInfo(tool.sourceInfo),
    schemaHash: hashToolParameters(tool.parameters),
  };
}

export function createToolInventory(
  api: Pick<ToolInventoryAPI, "getActiveTools" | "getAllTools">,
  event: Pick<SessionStartEvent, "reason">,
  context: ToolInventoryContext,
): ToolInventory {
  const activeTools = [...new Set(api.getActiveTools())].sort(compareStrings);
  const activeToolSet = new Set(activeTools);
  const tools = api
    .getAllTools()
    .map((tool) => inventoryEntry(tool, activeToolSet))
    .sort((left, right) => {
      const nameOrder = compareStrings(left.name, right.name);
      if (nameOrder !== 0) {
        return nameOrder;
      }
      return compareStrings(serializeCanonicalJson(left), serializeCanonicalJson(right));
    });

  return {
    inventoryFormatVersion: INVENTORY_FORMAT_VERSION,
    extensionVersion: EXTENSION_VERSION,
    sessionId: context.sessionManager.getSessionId(),
    sessionStartReason: event.reason,
    hashAlgorithm: INVENTORY_HASH_ALGORITHM,
    activeTools,
    tools,
  };
}

/** Create a session-local recorder that persists only new inventory snapshots. */
export function createToolInventoryRecorder(
  api: ToolInventoryAPI,
): (event: SessionStartEvent, context: ToolInventoryContext) => void {
  const recordedInventories = new Set<string>();

  return (event, context) => {
    const inventory = createToolInventory(api, event, context);
    const serialized = serializeCanonicalJson(inventory);
    if (recordedInventories.has(serialized)) {
      return;
    }
    api.appendEntry(TOOL_INVENTORY_ENTRY_TYPE, inventory);
    recordedInventories.add(serialized);
  };
}
