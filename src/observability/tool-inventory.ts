import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";

import { EXTENSION_VERSION } from "../version.ts";
import { boundedIdentifier } from "./bounded.ts";
import { hashToolParameters, serializeCanonicalJson } from "./canonical-json.ts";
import {
  INVENTORY_FORMAT_VERSION,
  INVENTORY_HASH_ALGORITHM,
  TOOL_INVENTORY_ENTRY_TYPE,
  type ToolInventory,
  type ToolInventoryEntry,
  type ToolInventorySourceInfo,
} from "./types.ts";

/** Tool metadata is untrusted runtime data and may carry values outside this SDK version's types. */
export type ToolInfoWithOptionalMetadata = Omit<
  ToolInfo,
  "annotations" | "exposure" | "namespace"
> & {
  readonly annotations?: unknown;
  readonly exposure?: unknown;
  readonly namespace?: unknown;
};

export type ToolInventoryAPI = Pick<ExtensionAPI, "appendEntry" | "getActiveTools"> & {
  readonly getAllTools: () => readonly ToolInfoWithOptionalMetadata[];
};
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolExposure(value: unknown): ToolInventoryEntry["exposure"] {
  switch (value) {
    case "direct":
    case "model-only":
    case "codemode":
    case "deferred":
    case "hidden":
      return value;
    default:
      return undefined;
  }
}

function toolNamespace(value: unknown): ToolInventoryEntry["namespace"] {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
    return undefined;
  }
  return { name: boundedIdentifier(value.name) };
}

function toolAnnotations(value: unknown): ToolInventoryEntry["annotations"] {
  if (!isRecord(value)) return undefined;
  const annotations = {
    ...(typeof value.readOnlyHint === "boolean" ? { readOnlyHint: value.readOnlyHint } : {}),
    ...(typeof value.destructiveHint === "boolean"
      ? { destructiveHint: value.destructiveHint }
      : {}),
    ...(typeof value.idempotentHint === "boolean" ? { idempotentHint: value.idempotentHint } : {}),
    ...(typeof value.openWorldHint === "boolean" ? { openWorldHint: value.openWorldHint } : {}),
  };
  return Object.keys(annotations).length === 0 ? undefined : annotations;
}

function inventoryEntry(
  tool: ToolInfoWithOptionalMetadata,
  activeTools: ReadonlySet<string>,
): ToolInventoryEntry {
  const exposure = toolExposure(tool.exposure);
  const namespace = toolNamespace(tool.namespace);
  const annotations = toolAnnotations(tool.annotations);
  return {
    name: tool.name,
    active: activeTools.has(tool.name),
    sourceInfo: sourceInfo(tool.sourceInfo),
    schemaHash: hashToolParameters(tool.parameters),
    ...(exposure === undefined ? {} : { exposure }),
    ...(namespace === undefined ? {} : { namespace }),
    ...(annotations === undefined ? {} : { annotations }),
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
