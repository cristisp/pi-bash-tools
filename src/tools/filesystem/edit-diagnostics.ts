const MAX_MATCH_COUNT = 10;
const MAX_CANDIDATES = 4;
const MAX_CANDIDATE_LINES = 2_048;
const MAX_EDITS = 32;
const MAX_CONTENT_LENGTH = 256_000;
const MAX_EDIT_TEXT_LENGTH = 16_000;
const MAX_TEXT_LENGTH = 2_000;

export interface FilesystemEditInput {
  readonly oldText: string;
  readonly newText: string;
}

export interface EditDiagnosticCandidate {
  readonly line: number;
}

export interface EditDiagnostic {
  readonly code: "edit-empty-old-text" | "edit-no-match" | "edit-ambiguous" | "edit-overlap";
  readonly editIndex: number;
  readonly matchCount?: number;
  readonly matchCountCapped?: boolean;
  readonly nearestCandidates?: readonly EditDiagnosticCandidate[];
  readonly whitespaceMismatch?: boolean;
  readonly hint: string;
}

function normalizeToLf(text: string): string {
  return text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/gu, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/gu, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, " ");
}

function countOccurrences(content: string, oldText: string): number {
  if (oldText.length === 0) return 0;
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  let count = 0;
  let offset = fuzzyContent.indexOf(fuzzyOldText);
  while (offset >= 0 && count <= MAX_MATCH_COUNT) {
    count += 1;
    offset = fuzzyContent.indexOf(fuzzyOldText, offset + Math.max(fuzzyOldText.length, 1));
  }
  return count;
}

function lineAtOffset(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < content.length; index += 1) {
    if (content[index] === "\n") line += 1;
  }
  return line;
}

function withoutWhitespace(text: string): string {
  return text.replace(/\s/gu, "");
}

function editDistance(left: string, right: string): number {
  const boundedLeft = left.slice(0, MAX_TEXT_LENGTH);
  const boundedRight = right.slice(0, MAX_TEXT_LENGTH);
  const previous = Array.from({ length: boundedRight.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= boundedLeft.length; leftIndex += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= boundedRight.length; rightIndex += 1) {
      const above = previous[rightIndex] ?? 0;
      const cost = boundedLeft[leftIndex - 1] === boundedRight[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min(
        (previous[rightIndex - 1] ?? 0) + 1,
        above + 1,
        diagonal + cost,
      );
      diagonal = above;
    }
  }
  return previous[boundedRight.length] ?? 0;
}

function nearestCandidates(content: string, oldText: string): readonly EditDiagnosticCandidate[] {
  const anchor = normalizeForFuzzyMatch(oldText).split("\n")[0]?.trim() ?? "";
  if (anchor.length === 0) return [];
  const candidates = content
    .split("\n")
    .slice(0, MAX_CANDIDATE_LINES)
    .map((line, index) => ({
      line: index + 1,
      distance: editDistance(anchor, normalizeForFuzzyMatch(line).trim()),
    }));
  candidates.sort((left, right) => left.distance - right.distance || left.line - right.line);
  return Object.freeze(candidates.slice(0, MAX_CANDIDATES).map(({ line }) => ({ line })));
}

function matchingLineCandidates(
  content: string,
  oldText: string,
): readonly EditDiagnosticCandidate[] {
  const candidates: EditDiagnosticCandidate[] = [];
  let offset = content.indexOf(oldText);
  while (offset >= 0 && candidates.length < MAX_CANDIDATES) {
    candidates.push({ line: lineAtOffset(content, offset) });
    offset = content.indexOf(oldText, offset + Math.max(oldText.length, 1));
  }
  return Object.freeze(candidates);
}

function whitespaceOnlyMismatch(content: string, oldText: string): boolean {
  const normalizedContent = withoutWhitespace(normalizeToLf(content));
  const normalizedOldText = withoutWhitespace(normalizeToLf(oldText));
  return normalizedOldText.length > 0 && normalizedContent.includes(normalizedOldText);
}

function noMatchDiagnostic(content: string, oldText: string, editIndex: number): EditDiagnostic {
  const whitespaceMismatch = whitespaceOnlyMismatch(content, oldText);
  return {
    code: "edit-no-match",
    editIndex,
    matchCount: 0,
    nearestCandidates: nearestCandidates(content, oldText),
    ...(whitespaceMismatch ? { whitespaceMismatch: true } : {}),
    hint: whitespaceMismatch
      ? "The text differs only in whitespace; preserve indentation, line endings, and trailing spaces."
      : "Provide a larger unique context that matches the file exactly.",
  };
}

export function diagnoseFilesystemEdits(
  content: string,
  edits: readonly FilesystemEditInput[],
): EditDiagnostic | undefined {
  if (
    content.length > MAX_CONTENT_LENGTH ||
    edits.length > MAX_EDITS ||
    edits.some(
      (edit) =>
        edit.oldText.length > MAX_EDIT_TEXT_LENGTH || edit.newText.length > MAX_EDIT_TEXT_LENGTH,
    )
  ) {
    return undefined;
  }
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLf(edit.oldText),
    newText: normalizeToLf(edit.newText),
  }));
  const emptyIndex = normalizedEdits.findIndex((edit) => edit.oldText.length === 0);
  if (emptyIndex >= 0) {
    return {
      code: "edit-empty-old-text",
      editIndex: emptyIndex,
      hint: "Provide non-empty oldText for the replacement.",
    };
  }

  const normalizedContent = normalizeToLf(content);
  const initialMatches = normalizedEdits.map((edit) => {
    const exactIndex = normalizedContent.indexOf(edit.oldText);
    if (exactIndex >= 0) return { index: exactIndex, fuzzy: false };
    const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
    const fuzzyOldText = normalizeForFuzzyMatch(edit.oldText);
    return { index: fuzzyContent.indexOf(fuzzyOldText), fuzzy: true };
  });
  const usedFuzzy = initialMatches.some((match) => match.fuzzy && match.index >= 0);
  const baseContent = usedFuzzy ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;
  const matches: Array<{ index: number; length: number; editIndex: number }> = [];

  for (let editIndex = 0; editIndex < normalizedEdits.length; editIndex += 1) {
    const edit = normalizedEdits[editIndex];
    if (edit === undefined) continue;
    const oldText = usedFuzzy ? normalizeForFuzzyMatch(edit.oldText) : edit.oldText;
    const index = baseContent.indexOf(oldText);
    if (index < 0) return noMatchDiagnostic(content, edit.oldText, editIndex);
    const occurrences = countOccurrences(baseContent, oldText);
    if (occurrences > 1) {
      return {
        code: "edit-ambiguous",
        editIndex,
        matchCount: Math.min(occurrences, MAX_MATCH_COUNT),
        ...(occurrences > MAX_MATCH_COUNT ? { matchCountCapped: true } : {}),
        nearestCandidates: matchingLineCandidates(baseContent, oldText),
        hint: "Provide more surrounding context so oldText matches exactly one region.",
      };
    }
    matches.push({ index, length: oldText.length, editIndex });
  }

  matches.sort((left, right) => left.index - right.index);
  for (let index = 1; index < matches.length; index += 1) {
    const previous = matches[index - 1];
    const current = matches[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.index + previous.length > current.index
    ) {
      return {
        code: "edit-overlap",
        editIndex: current.editIndex,
        hint: "Merge overlapping edits into one replacement or target disjoint regions.",
      };
    }
  }
  return undefined;
}
