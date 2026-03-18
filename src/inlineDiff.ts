export type InlineDiffHunkKind = "add" | "delete" | "modify";

export interface InlineDiffHunk {
  kind: InlineDiffHunkKind;
  originalStart: number;
  originalEnd: number;
  modifiedStart: number;
  modifiedEnd: number;
  originalLines: string[];
  modifiedLines: string[];
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function splitLines(content: string): string[] {
  const normalized = normalizeContent(content);
  if (!normalized) {
    return [];
  }
  return normalized.split("\n");
}

function joinLines(lines: string[]): string {
  return lines.join("\n");
}

function buildFallbackDiff(
  originalLines: string[],
  modifiedLines: string[],
): InlineDiffHunk[] {
  let prefix = 0;
  while (
    prefix < originalLines.length &&
    prefix < modifiedLines.length &&
    originalLines[prefix] === modifiedLines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < originalLines.length - prefix &&
    suffix < modifiedLines.length - prefix &&
    originalLines[originalLines.length - 1 - suffix] ===
      modifiedLines[modifiedLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const originalSlice = originalLines.slice(prefix, originalLines.length - suffix);
  const modifiedSlice = modifiedLines.slice(prefix, modifiedLines.length - suffix);

  if (originalSlice.length === 0 && modifiedSlice.length === 0) {
    return [];
  }

  return [
    {
      kind:
        originalSlice.length === 0
          ? "add"
          : modifiedSlice.length === 0
            ? "delete"
            : "modify",
      originalStart: prefix,
      originalEnd: originalLines.length - suffix,
      modifiedStart: prefix,
      modifiedEnd: modifiedLines.length - suffix,
      originalLines: originalSlice,
      modifiedLines: modifiedSlice,
    },
  ];
}

function buildLcsMatrix(
  originalLines: string[],
  modifiedLines: string[],
): Uint32Array {
  const cols = modifiedLines.length + 1;
  const matrix = new Uint32Array((originalLines.length + 1) * cols);

  for (let i = originalLines.length - 1; i >= 0; i--) {
    for (let j = modifiedLines.length - 1; j >= 0; j--) {
      const index = i * cols + j;
      if (originalLines[i] === modifiedLines[j]) {
        matrix[index] = matrix[(i + 1) * cols + (j + 1)] + 1;
      } else {
        matrix[index] = Math.max(
          matrix[(i + 1) * cols + j],
          matrix[i * cols + (j + 1)],
        );
      }
    }
  }

  return matrix;
}

function collectMatches(
  originalLines: string[],
  modifiedLines: string[],
  matrix: Uint32Array,
): Array<[number, number]> {
  const matches: Array<[number, number]> = [];
  const cols = modifiedLines.length + 1;
  let i = 0;
  let j = 0;

  while (i < originalLines.length && j < modifiedLines.length) {
    if (originalLines[i] === modifiedLines[j]) {
      matches.push([i, j]);
      i++;
      j++;
      continue;
    }

    const down = matrix[(i + 1) * cols + j];
    const right = matrix[i * cols + (j + 1)];
    if (down >= right) {
      i++;
    } else {
      j++;
    }
  }

  return matches;
}

export function computeInlineDiffHunks(
  originalContent: string,
  modifiedContent: string,
): InlineDiffHunk[] {
  const originalLines = splitLines(originalContent);
  const modifiedLines = splitLines(modifiedContent);

  if (
    originalLines.length === modifiedLines.length &&
    originalLines.every((line, index) => line === modifiedLines[index])
  ) {
    return [];
  }

  const cellCount = (originalLines.length + 1) * (modifiedLines.length + 1);
  if (cellCount > 2_000_000) {
    return buildFallbackDiff(originalLines, modifiedLines);
  }

  const matrix = buildLcsMatrix(originalLines, modifiedLines);
  const matches = collectMatches(originalLines, modifiedLines, matrix);
  const hunks: InlineDiffHunk[] = [];

  let previousOriginalIndex = 0;
  let previousModifiedIndex = 0;

  const pushHunk = (nextOriginalIndex: number, nextModifiedIndex: number) => {
    if (
      nextOriginalIndex === previousOriginalIndex &&
      nextModifiedIndex === previousModifiedIndex
    ) {
      return;
    }

    const originalSlice = originalLines.slice(
      previousOriginalIndex,
      nextOriginalIndex,
    );
    const modifiedSlice = modifiedLines.slice(
      previousModifiedIndex,
      nextModifiedIndex,
    );

    hunks.push({
      kind:
        originalSlice.length === 0
          ? "add"
          : modifiedSlice.length === 0
            ? "delete"
            : "modify",
      originalStart: previousOriginalIndex,
      originalEnd: nextOriginalIndex,
      modifiedStart: previousModifiedIndex,
      modifiedEnd: nextModifiedIndex,
      originalLines: originalSlice,
      modifiedLines: modifiedSlice,
    });
  };

  for (const [originalIndex, modifiedIndex] of matches) {
    pushHunk(originalIndex, modifiedIndex);
    previousOriginalIndex = originalIndex + 1;
    previousModifiedIndex = modifiedIndex + 1;
  }

  pushHunk(originalLines.length, modifiedLines.length);
  return hunks;
}

export function acceptInlineDiffHunk(
  baselineContent: string,
  currentContent: string,
  hunk: InlineDiffHunk,
): string {
  const baselineLines = splitLines(baselineContent);
  const currentLines = splitLines(currentContent);

  const nextBaseline = [
    ...baselineLines.slice(0, hunk.originalStart),
    ...currentLines.slice(hunk.modifiedStart, hunk.modifiedEnd),
    ...baselineLines.slice(hunk.originalEnd),
  ];

  return joinLines(nextBaseline);
}

export function rejectInlineDiffHunk(
  baselineContent: string,
  currentContent: string,
  hunk: InlineDiffHunk,
): string {
  const baselineLines = splitLines(baselineContent);
  const currentLines = splitLines(currentContent);

  const nextCurrent = [
    ...currentLines.slice(0, hunk.modifiedStart),
    ...baselineLines.slice(hunk.originalStart, hunk.originalEnd),
    ...currentLines.slice(hunk.modifiedEnd),
  ];

  return joinLines(nextCurrent);
}
