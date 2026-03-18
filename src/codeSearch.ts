export type SearchMode = "literal" | "regex";

export type ParsedSearchQuery = {
  mode: SearchMode;
  regex: RegExp;
  normalizedQuery: string;
  warnings: string[];
};

export type RankedSearchMatch = {
  relativePath: string;
  lineNum: number;
  preview: string;
  score: number;
};

export type RankedSymbolMatch = {
  name: string;
  kind: string;
  relativePath: string;
  lineNum: number;
  score: number;
};

const MAX_PREVIEW_LENGTH = 200;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tryParseSlashRegex(rawQuery: string): RegExp | null {
  const match = rawQuery.match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
  if (!match) return null;

  try {
    return new RegExp(match[1], match[2] || "i");
  } catch {
    return null;
  }
}

function buildDefinitionPatterns(normalizedQuery: string): RegExp[] {
  const escaped = escapeRegex(normalizedQuery);
  return [
    new RegExp(`\\bfunction\\s+${escaped}\\b`, "i"),
    new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=`, "i"),
    new RegExp(`\\bclass\\s+${escaped}\\b`, "i"),
    new RegExp(`\\b(?:interface|type|enum)\\s+${escaped}\\b`, "i"),
    new RegExp(`\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?\\(`, "i"),
    new RegExp(`\\b${escaped}\\s*\\(`, "i"),
    new RegExp(`\\bimport\\b[\\s\\S]*\\b${escaped}\\b`, "i"),
    new RegExp(`\\bexport\\b[\\s\\S]*\\b${escaped}\\b`, "i"),
  ];
}

export function parseSearchQuery(rawQuery: string): ParsedSearchQuery {
  const trimmed = rawQuery.trim();
  const warnings: string[] = [];

  if (!trimmed) {
    return {
      mode: "literal",
      regex: new RegExp("$^"),
      normalizedQuery: "",
      warnings: ["Empty search query."],
    };
  }

  const explicitLiteral = trimmed.match(/^literal:\s*([\s\S]+)$/i);
  if (explicitLiteral) {
    const literalQuery = explicitLiteral[1].trim();
    return {
      mode: "literal",
      regex: new RegExp(escapeRegex(literalQuery), "i"),
      normalizedQuery: literalQuery,
      warnings,
    };
  }

  const explicitRegex = trimmed.match(/^re(?:gex)?:\s*([\s\S]+)$/i);
  if (explicitRegex) {
    const regexBody = explicitRegex[1].trim();
    const slashRegex = tryParseSlashRegex(regexBody);
    if (slashRegex) {
      return {
        mode: "regex",
        regex: slashRegex,
        normalizedQuery: regexBody,
        warnings,
      };
    }

    try {
      return {
        mode: "regex",
        regex: new RegExp(regexBody, "i"),
        normalizedQuery: regexBody,
        warnings,
      };
    } catch {
      warnings.push(
        `Invalid regex "${regexBody}". Falling back to literal search.`,
      );
      return {
        mode: "literal",
        regex: new RegExp(escapeRegex(regexBody), "i"),
        normalizedQuery: regexBody,
        warnings,
      };
    }
  }

  const slashRegex = tryParseSlashRegex(trimmed);
  if (slashRegex) {
    return {
      mode: "regex",
      regex: slashRegex,
      normalizedQuery: trimmed,
      warnings,
    };
  }

  return {
    mode: "literal",
    regex: new RegExp(escapeRegex(trimmed), "i"),
    normalizedQuery: trimmed,
    warnings,
  };
}

export function shouldRejectSearchQuery(parsed: ParsedSearchQuery): boolean {
  return parsed.mode === "literal" && parsed.normalizedQuery.length <= 2;
}

export function createSearchResultPreview(line: string): string {
  return line.trim().substring(0, MAX_PREVIEW_LENGTH);
}

export function rankSearchMatch(params: {
  relativePath: string;
  lineNum: number;
  line: string;
  normalizedQuery: string;
}): number {
  const { relativePath, lineNum, line, normalizedQuery } = params;
  const lowerPath = relativePath.toLowerCase();
  const lowerLine = line.toLowerCase();
  const lowerQuery = normalizedQuery.toLowerCase();
  const fileName = relativePath.split(/[\\/]/).pop()?.toLowerCase() || "";
  let score = 0;

  if (fileName === lowerQuery || fileName.startsWith(`${lowerQuery}.`)) {
    score += 140;
  }
  if (lowerPath.includes(lowerQuery)) {
    score += 50;
  }
  if (lineNum <= 80) {
    score += Math.max(0, 30 - lineNum);
  }
  if (lowerLine.includes(lowerQuery)) {
    score += 20;
  }

  const definitionPatterns = buildDefinitionPatterns(normalizedQuery);
  if (definitionPatterns.some((pattern) => pattern.test(line))) {
    score += 220;
  }

  if (/^\s*(function|class|interface|type|enum|const|let|var|export|import)\b/i.test(line)) {
    score += 40;
  }

  return score;
}

export function formatRankedSearchResults(
  matches: RankedSearchMatch[],
): string[] {
  return matches.map(
    (match) => `${match.relativePath}:${match.lineNum}: ${match.preview}`,
  );
}

export function formatSymbolKind(kind: number): string {
  const symbolKinds: Record<number, string> = {
    0: "File",
    1: "Module",
    2: "Namespace",
    3: "Package",
    4: "Class",
    5: "Method",
    6: "Property",
    7: "Field",
    8: "Constructor",
    9: "Enum",
    10: "Interface",
    11: "Function",
    12: "Variable",
    13: "Constant",
    14: "String",
    15: "Number",
    16: "Boolean",
    17: "Array",
    18: "Object",
    19: "Key",
    20: "Null",
    21: "EnumMember",
    22: "Struct",
    23: "Event",
    24: "Operator",
    25: "TypeParameter",
  };

  return symbolKinds[kind] || "Symbol";
}

export function rankSymbolMatch(params: {
  symbolName: string;
  symbolKind: string;
  relativePath: string;
  lineNum: number;
  normalizedQuery: string;
}): number {
  const { symbolName, symbolKind, relativePath, lineNum, normalizedQuery } =
    params;
  const lowerName = symbolName.toLowerCase();
  const lowerKind = symbolKind.toLowerCase();
  const lowerPath = relativePath.toLowerCase();
  const lowerQuery = normalizedQuery.toLowerCase();
  let score = 0;

  if (lowerName === lowerQuery) score += 260;
  if (lowerName.startsWith(lowerQuery)) score += 120;
  if (lowerName.includes(lowerQuery)) score += 60;
  if (lowerPath.includes(lowerQuery)) score += 20;
  if (lineNum <= 120) score += Math.max(0, 20 - Math.floor(lineNum / 6));
  if (/(function|method|class|interface|variable|constant|enum)/.test(lowerKind)) {
    score += 40;
  }

  return score;
}

export function formatRankedSymbolResults(
  matches: RankedSymbolMatch[],
): string[] {
  return matches.map(
    (match) =>
      `${match.relativePath}:${match.lineNum}: [${match.kind}] ${match.name}`,
  );
}
