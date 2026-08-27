import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
  hashToolParameters,
  serializeCanonicalJson,
} from "../../src/observability/canonical-json.ts";
import {
  createToolInventory,
  createToolInventoryRecorder,
  type ToolInventoryAPI,
  type ToolInventoryContext,
} from "../../src/observability/tool-inventory.ts";
import { TOOL_INVENTORY_ENTRY_TYPE } from "../../src/observability/types.ts";

function tool(
  name: string,
  parameters: ToolInfo["parameters"],
  sourceInfo: ToolInfo["sourceInfo"],
): ToolInfo {
  return {
    name,
    description: `${name} description should not be persisted`,
    parameters,
    sourceInfo,
  };
}

function context(sessionId: string): ToolInventoryContext {
  return { sessionManager: { getSessionId: () => sessionId } };
}

const startup = { type: "session_start" as const, reason: "startup" as const };

describe("canonical metadata JSON", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(
      serializeCanonicalJson({
        z: [{ second: 2, first: 1 }, { value: true }],
        a: "first",
      }),
    ).toBe('{"a":"first","z":[{"first":1,"second":2},{"value":true}]}');

    expect(hashToolParameters({ type: "object", properties: { a: 1, b: 2 } })).toBe(
      hashToolParameters({ properties: { b: 2, a: 1 }, type: "object" }),
    );
    expect(hashToolParameters({ required: ["first", "second"] })).not.toBe(
      hashToolParameters({ required: ["second", "first"] }),
    );
  });

  it("rejects values that are not JSON-compatible metadata", () => {
    expect(() => serializeCanonicalJson({ missing: undefined })).toThrow(TypeError);
    expect(() => serializeCanonicalJson({ nonFinite: Number.NaN })).toThrow(TypeError);
    expect(() => serializeCanonicalJson({ unsupported: new Date(0) })).toThrow(TypeError);
    expect(() => serializeCanonicalJson(new Array(1))).toThrow(TypeError);
  });
});

describe("tool inventory", () => {
  it("records sorted configured tools, active state, provenance, and schema hashes", () => {
    const readParameters = Type.Object({ path: Type.String() });
    const allTools = [
      tool("write", Type.Object({ content: Type.String(), path: Type.String() }), {
        path: "/extensions/files.ts",
        source: "bash-tools",
        scope: "project",
        origin: "package",
        baseDir: "/extensions",
      }),
      tool("read", readParameters, {
        path: "/core/read.ts",
        source: "pi",
        scope: "user",
        origin: "top-level",
      }),
    ];
    const api: ToolInventoryAPI = {
      appendEntry: vi.fn(),
      getActiveTools: vi.fn(() => ["write"]),
      getAllTools: vi.fn(() => allTools),
    };

    const inventory = createToolInventory(api, startup, context("session-1"));

    expect(inventory).toMatchObject({
      inventoryFormatVersion: 1,
      sessionId: "session-1",
      sessionStartReason: "startup",
      hashAlgorithm: "sha256",
      activeTools: ["write"],
    });
    expect(inventory.tools).toEqual([
      {
        name: "read",
        active: false,
        sourceInfo: {
          path: "/core/read.ts",
          source: "pi",
          scope: "user",
          origin: "top-level",
        },
        schemaHash: hashToolParameters(readParameters),
      },
      {
        name: "write",
        active: true,
        sourceInfo: {
          path: "/extensions/files.ts",
          source: "bash-tools",
          scope: "project",
          origin: "package",
          baseDir: "/extensions",
        },
        schemaHash: hashToolParameters(allTools[0].parameters),
      },
    ]);
    expect(inventory).not.toHaveProperty("description");
  });

  it("deduplicates identical snapshots only within the recorder runtime", () => {
    let allTools = [
      tool("read", Type.Object({ path: Type.String() }), {
        path: "/core/read.ts",
        source: "pi",
        scope: "user",
        origin: "top-level",
      }),
    ];
    let activeTools = ["read"];
    const appendEntry = vi.fn();
    const api: ToolInventoryAPI = {
      appendEntry,
      getActiveTools: () => activeTools,
      getAllTools: () => allTools,
    };
    const recorder = createToolInventoryRecorder(api);

    recorder(startup, context("session-1"));
    recorder(startup, context("session-1"));
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledWith(TOOL_INVENTORY_ENTRY_TYPE, expect.any(Object));

    activeTools = ["read", "write"];
    allTools = [
      ...allTools,
      tool("write", Type.Object({ path: Type.String(), value: Type.String() }), {
        path: "/extensions/write.ts",
        source: "bash-tools-v2",
        scope: "project",
        origin: "package",
      }),
    ];
    recorder({ type: "session_start", reason: "reload" }, context("session-1"));
    expect(appendEntry).toHaveBeenCalledTimes(2);

    const secondRecorder = createToolInventoryRecorder(api);
    secondRecorder({ type: "session_start", reason: "reload" }, context("session-1"));
    expect(appendEntry).toHaveBeenCalledTimes(3);
  });
});
