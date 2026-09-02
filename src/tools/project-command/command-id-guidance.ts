import type { ProjectCommandDefinition } from "./definitions.ts";

export interface ProjectCommandIdGuidance {
  readonly validCommandIds: readonly string[];
  readonly nearestCommandId?: string;
  readonly canonicalCommandId?: string;
  readonly canonicalVariant?: string;
  readonly correctedExample?: Readonly<Record<string, string>>;
  readonly remediation: string;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex] ?? 0;
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min(
        (previous[rightIndex - 1] ?? 0) + 1,
        above + 1,
        diagonal + cost,
      );
      diagonal = above;
    }
  }
  return previous[right.length] ?? left.length;
}

function legacyVariant(
  commandId: string,
): { readonly commandId: string; readonly variant: string } | undefined {
  const match = /^(node_(?:test|lint|format))([_:])(.+)$/u.exec(commandId);
  if (match === null) return undefined;
  const base = match[1];
  const suffix = match[3];
  if (base === undefined || suffix === undefined || suffix.length === 0) return undefined;
  return { commandId: base, variant: match[2] === "_" ? suffix.replaceAll("_", ":") : suffix };
}

export function projectCommandIdGuidance(
  commandId: string,
  definitions: readonly ProjectCommandDefinition[],
): ProjectCommandIdGuidance {
  const validCommandIds = Object.freeze(
    definitions.map((definition) => definition.commandId).sort(),
  );
  if (validCommandIds.includes(commandId)) {
    return {
      validCommandIds,
      remediation: "Retry with the documented parameters for this commandId.",
    };
  }

  const legacy = legacyVariant(commandId);
  if (legacy !== undefined && validCommandIds.includes(legacy.commandId)) {
    const packageScript = `${legacy.commandId.replace("node_", "")}:${legacy.variant}`;
    return {
      validCommandIds,
      nearestCommandId: legacy.commandId,
      canonicalCommandId: legacy.commandId,
      canonicalVariant: legacy.variant,
      correctedExample: { commandId: legacy.commandId, variant: legacy.variant },
      remediation: `Use { commandId: "${legacy.commandId}", variant: "${legacy.variant}" } for the ${packageScript} package script instead of embedding the variant in commandId.`,
    };
  }

  const candidates = validCommandIds.map((candidate) => ({
    candidate,
    distance: editDistance(commandId, candidate),
  }));
  candidates.sort(
    (left, right) =>
      left.distance - right.distance || left.candidate.localeCompare(right.candidate),
  );
  const nearest = candidates[0];
  const threshold = Math.max(2, Math.ceil(commandId.length * 0.4));
  const nearestCommandId =
    nearest !== undefined && nearest.distance <= threshold ? nearest.candidate : undefined;
  return {
    validCommandIds,
    ...(nearestCommandId === undefined ? {} : { nearestCommandId }),
    ...(nearestCommandId === undefined
      ? {}
      : { correctedExample: { commandId: nearestCommandId } }),
    remediation:
      nearestCommandId === undefined
        ? `Use one of the valid commandId values listed in validCommandIds.`
        : `Use commandId "${nearestCommandId}". Correct the commandId and retry.`,
  };
}
