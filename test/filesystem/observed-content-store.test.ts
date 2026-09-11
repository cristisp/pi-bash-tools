import { describe, expect, it } from "vitest";

import {
  createObservedContentStore,
  DEFAULT_MAX_ENTRIES,
} from "../../src/tools/filesystem/observed-content-store.ts";

describe("observed content store", () => {
  it("records and looks up a content hash by path", () => {
    const store = createObservedContentStore();
    store.record("/workspace/file.txt", "hash-1");
    expect(store.lookup("/workspace/file.txt")).toBe("hash-1");
  });

  it("returns undefined for a missing entry", () => {
    const store = createObservedContentStore();
    expect(store.lookup("/workspace/missing.txt")).toBeUndefined();
  });

  it("overwrites an entry in place on re-record", () => {
    const store = createObservedContentStore();
    store.record("/workspace/file.txt", "hash-1");
    store.record("/workspace/file.txt", "hash-2");
    expect(store.lookup("/workspace/file.txt")).toBe("hash-2");
  });

  it("evicts the oldest entry at the bounded size", () => {
    const store = createObservedContentStore(2);
    store.record("/a", "hash-a");
    store.record("/b", "hash-b");
    store.record("/c", "hash-c");
    expect(store.lookup("/a")).toBeUndefined();
    expect(store.lookup("/b")).toBe("hash-b");
    expect(store.lookup("/c")).toBe("hash-c");
  });

  it("refreshes recency on re-record so refreshed entries survive eviction", () => {
    const store = createObservedContentStore(2);
    store.record("/a", "hash-a");
    store.record("/b", "hash-b");
    store.record("/a", "hash-a2");
    store.record("/c", "hash-c");
    expect(store.lookup("/a")).toBe("hash-a2");
    expect(store.lookup("/b")).toBeUndefined();
    expect(store.lookup("/c")).toBe("hash-c");
  });

  it("rejects empty paths and hashes", () => {
    const store = createObservedContentStore();
    store.record("", "hash-1");
    store.record("/a", "");
    expect(store.lookup("")).toBeUndefined();
    expect(store.lookup("/a")).toBeUndefined();
  });

  it("uses the default bound of 256 entries", () => {
    expect(DEFAULT_MAX_ENTRIES).toBe(256);
    const store = createObservedContentStore();
    for (let index = 0; index < DEFAULT_MAX_ENTRIES; index += 1) {
      store.record(`/p-${index}`, `hash-${index}`);
    }
    store.record("/overflow", "hash-overflow");
    expect(store.lookup("/p-0")).toBeUndefined();
    expect(store.lookup(`/p-${DEFAULT_MAX_ENTRIES - 1}`)).toBe(`hash-${DEFAULT_MAX_ENTRIES - 1}`);
    expect(store.lookup("/overflow")).toBe("hash-overflow");
  });

  it("keys entries by a hash of the path, not the raw path", () => {
    const store = createObservedContentStore();
    store.record("/a", "hash-a");
    store.record("/b", "hash-b");
    expect(store.lookup("/a")).toBe("hash-a");
    expect(store.lookup("/b")).toBe("hash-b");
    expect(store.lookup("/c")).toBeUndefined();
  });
});
