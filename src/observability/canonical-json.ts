import { createHash } from "node:crypto";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

function unsupported(path: string): TypeError {
  return new TypeError(`Unsupported JSON value at ${path}`);
}

function serializeArray(
  value: readonly unknown[],
  path: string,
  ancestors: WeakSet<object>,
): string {
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      throw unsupported(path);
    }
    if (key === "length") {
      continue;
    }
    if (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) {
      throw unsupported(`${path}.${key}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined) {
      throw unsupported(`${path}.${key}`);
    }
  }

  const values: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw unsupported(`${path}[${index}]`);
    }
    values.push(serialize(value[index], `${path}[${index}]`, ancestors));
  }
  return `[${values.join(",")}]`;
}

function serializeObject(value: object, path: string, ancestors: WeakSet<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw unsupported(path);
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw unsupported(path);
  }

  // TypeBox keeps its internal kind marker as a non-enumerable property. JSON
  // serialization ignores that marker, so canonicalization does the same for
  // all non-enumerable string properties.
  const keys = Object.keys(value).sort();
  const properties: string[] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw unsupported(`${path}.${key}`);
    }
    properties.push(
      `${JSON.stringify(key)}:${serialize(descriptor.value, `${path}.${key}`, ancestors)}`,
    );
  }
  return `{${properties.join(",")}}`;
}

function serialize(value: unknown, path: string, ancestors: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw unsupported(path);
      }
      return JSON.stringify(value);
    case "object":
      if (ancestors.has(value)) {
        throw unsupported(path);
      }
      ancestors.add(value);
      try {
        return Array.isArray(value)
          ? serializeArray(value, path, ancestors)
          : serializeObject(value, path, ancestors);
      } finally {
        ancestors.delete(value);
      }
    default:
      throw unsupported(path);
  }
}

/** Serialize JSON-compatible metadata with recursively sorted object keys. */
export function serializeCanonicalJson(value: unknown): string {
  return serialize(value, "$", new WeakSet<object>());
}

/** Hash JSON-compatible metadata using SHA-256 over its canonical serialization. */
export function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(serializeCanonicalJson(value), "utf8").digest("hex");
}

/** Hash a tool parameter schema using its canonical JSON representation. */
export function hashToolParameters(parameters: unknown): string {
  return hashCanonicalJson(parameters);
}

export const canonicalJson = serializeCanonicalJson;
export const hashJson = hashCanonicalJson;
