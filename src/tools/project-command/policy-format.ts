import {
  createEmptyProjectCommandPolicy,
  type PolicyDocument,
  type ProjectCommandIdentity,
  type ProjectCommandPolicyData,
} from "../environment/policy/document.ts";
import { readPolicyDocument } from "../environment/policy/storage.ts";
import type { PolicyFileSystem } from "../environment/policy/filesystem.ts";

export { createEmptyProjectCommandPolicy };
export type { ProjectCommandIdentity, ProjectCommandPolicyData };

export async function readProjectCommandPolicy(
  configPath: string,
  fileSystem: PolicyFileSystem,
  suppliedParent?: Parameters<typeof readPolicyDocument>[2],
): Promise<PolicyDocument> {
  return readPolicyDocument(configPath, fileSystem, suppliedParent);
}
