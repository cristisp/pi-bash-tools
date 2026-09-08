import type { NodeProjectInfo, NodeProjectResolutionOptions } from "../node.ts";
import { readNodeProjectState } from "./project-state/reader.ts";

export {
  canonicalizeNodeScriptsInternal,
  hashNodeScriptsInternal,
} from "./project-state/manifest.ts";
export { readNodeProjectState } from "./project-state/reader.ts";

export async function readNodeProjectInfoInternal(
  projectPath: string,
  options: NodeProjectResolutionOptions = {},
): Promise<NodeProjectInfo> {
  return (
    await readNodeProjectState(projectPath, options, {
      allowMissing: true,
      probeFallow: true,
    })
  ).info;
}
