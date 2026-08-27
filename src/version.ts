import { createRequire } from "node:module";

function readPackageVersion(metadata: unknown): string {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    !("version" in metadata) ||
    typeof metadata.version !== "string" ||
    metadata.version.length === 0
  ) {
    throw new Error("The extension package.json must contain a non-empty version string");
  }
  return metadata.version;
}

const packageMetadata: unknown = createRequire(import.meta.url)("../package.json");

export const EXTENSION_VERSION = readPackageVersion(packageMetadata);
