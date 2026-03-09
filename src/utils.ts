import * as crypto from "crypto";
import logger from "vico-logger";

const recentAppliedDiffFingerprints: Map<string, number> = new Map();

/**
 * Membangun fingerprint unik untuk sebuah blok diff SEARCH/REPLACE.
 */
export function buildDiffFingerprint(
  filePath: string,
  searchText: string,
  replaceText: string,
): string {
  return crypto
    .createHash("md5")
    .update(
      `${filePath}\n---SEARCH---\n${searchText}\n---REPLACE---\n${replaceText}`,
    )
    .digest("hex");
}

/**
 * Menandai dan memeriksa apakah sebuah diff baru saja diterapkan untuk menghindari perulangan.
 */
export function markAndCheckRecentDiff(fingerprint: string): boolean {
  const now = Date.now();
  const last = recentAppliedDiffFingerprints.get(fingerprint);
  // Treat same diff as duplicate for 10 minutes to avoid looped reinserts.
  const isDuplicate = typeof last === "number" && now - last < 10 * 60 * 1000;
  recentAppliedDiffFingerprints.set(fingerprint, now);
  // Cleanup old entries
  for (const [k, t] of recentAppliedDiffFingerprints.entries()) {
    if (now - t > 30 * 60 * 1000) {
      recentAppliedDiffFingerprints.delete(k);
    }
  }
  return isDuplicate;
}

/**
 * Membersihkan marker diff (+, -, @@) dan teks "new:" dari konten.
 * Berguna saat AI menyertakan format diff di dalam blok SEARCH/REPLACE.
 */
export function cleanSearchReplaceText(text: string, isReplace: boolean): string {
  if (!text) return text;

  let cleaned = stripMarkdownFences(text);

  // Hapus teks "new:" atau "new" di awal (AI sering melakukan ini di luar blok atau di awal blok)
  // Kita hanya hapus jika benar-benar di awal string/baris pertama
  const newPrefixMatch = cleaned.match(/^\s*new:?\s*[\r\n]*/i);
  if (newPrefixMatch) {
    cleaned = cleaned.substring(newPrefixMatch[0].length);
  }

  const lines = cleaned.split(/\r?\n/);
  const resultLines: string[] = [];
  let hasDiffMarkers = false;

  // Deteksi apakah ada marker diff (+ atau -) di awal baris yang bukan bagian dari operator ++ atau --
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      (line.startsWith("+") && !line.startsWith("++")) ||
      (line.startsWith("-") && !line.startsWith("--")) ||
      (trimmed.startsWith("@@") && trimmed.includes("@@"))
    ) {
      hasDiffMarkers = true;
      break;
    }
  }

  if (!hasDiffMarkers) return cleaned;

  logger.info(
    `[utils] Diff markers detected in ${isReplace ? "REPLACE" : "SEARCH"} block, cleaning...`,
  );

  for (let line of lines) {
    // 1. Skip hunk headers
    const trimmed = line.trim();
    if (trimmed.startsWith("@@") && trimmed.includes("@@")) {
      continue;
    }

    if (isReplace) {
      // Di blok REPLACE:
      // - Simpan baris yang diawali '+' (tanpa '+')
      // - Lewati baris yang diawali '-'
      // - Simpan baris normal
      if (line.startsWith("+") && !line.startsWith("++")) {
        resultLines.push(line.substring(1));
      } else if (line.startsWith("-") && !line.startsWith("--")) {
        continue;
      } else {
        resultLines.push(line);
      }
    } else {
      // Di blok SEARCH:
      // - Simpan baris yang diawali '-' (tanpa '-')
      // - Lewati baris yang diawali '+'
      // - Simpan baris normal
      if (line.startsWith("-") && !line.startsWith("--")) {
        resultLines.push(line.substring(1));
      } else if (line.startsWith("+") && !line.startsWith("++")) {
        continue;
      } else {
        resultLines.push(line);
      }
    }
  }

  return resultLines.join("\n");
}

export function applySearchReplaceWithFallback(
  currentContent: string,
  searchText: string,
  replaceText: string,
): { matched: boolean; next: string; strategy: string } {
  if (searchText && currentContent.includes(searchText)) {
    return {
      matched: true,
      next: replaceFirstOccurrence(currentContent, searchText, replaceText),
      strategy: "exact",
    };
  }

  const fuzzy = applyFuzzySearchReplace(
    currentContent,
    searchText,
    replaceText,
  );
  if (fuzzy.matched) {
    return {
      matched: true,
      next: fuzzy.next,
      strategy: "fuzzy",
    };
  }

  const eol = detectEol(currentContent);
  const currentLf = toLf(currentContent);
  const searchLf = toLf(searchText);
  const replaceLf = toLf(replaceText);

  if (searchLf && currentLf.includes(searchLf)) {
    const nextLf = replaceFirstOccurrence(currentLf, searchLf, replaceLf);
    return {
      matched: true,
      next: fromLf(nextLf, eol),
      strategy: "normalized-eol",
    };
  }

  const loose = replaceByTrimmedLineMatch(currentLf, searchLf, replaceLf);
  if (loose.matched) {
    return {
      matched: true,
      next: fromLf(loose.next, eol),
      strategy: "trimmed-line",
    };
  }

  return { matched: false, next: currentContent, strategy: "none" };
}

export function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyFuzzySearchReplace(
  currentContent: string,
  searchText: string,
  replaceText: string,
): { matched: boolean; next: string } {
  if (!searchText) return { matched: false, next: currentContent };
  const tokens = searchText
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return { matched: false, next: currentContent };
  const pattern = tokens.map(escapeRegex).join("\\s+");
  const regex = new RegExp(pattern, "m");
  const match = currentContent.match(regex);
  if (!match || typeof match.index !== "number") {
    return { matched: false, next: currentContent };
  }
  const next =
    currentContent.slice(0, match.index) +
    replaceText +
    currentContent.slice(match.index + match[0].length);
  return { matched: true, next };
}

export function replaceFirstOccurrence(
  content: string,
  search: string,
  replace: string,
): string {
  const index = content.indexOf(search);
  if (index === -1) return content;
  return (
    content.slice(0, index) + replace + content.slice(index + search.length)
  );
}

export function replaceByTrimmedLineMatch(
  currentLf: string,
  searchLf: string,
  replaceLf: string,
): { matched: boolean; next: string } {
  const lines = currentLf.split("\n");
  const searchLines = searchLf.split("\n");
  if (searchLines.length === 0) return { matched: false, next: currentLf };

  for (let i = 0; i <= lines.length - searchLines.length; i++) {
    let match = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (lines[i + j].trim() !== searchLines[j].trim()) {
        match = false;
        break;
      }
    }
    if (match) {
      const nextLines = [
        ...lines.slice(0, i),
        replaceLf,
        ...lines.slice(i + searchLines.length),
      ];
      return { matched: true, next: nextLines.join("\n") };
    }
  }
  return { matched: false, next: currentLf };
}

export function detectEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function fromLf(text: string, eol: string): string {
  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function debounce(func: (...args: any[]) => void, wait: number) {
  let timeout: NodeJS.Timeout | null;
  return function executedFunction(...args: any[]) {
    const later = () => {
      timeout = null; // Clear timeout
      func(...args); // Execute the function
    };
    if (timeout) {
      clearTimeout(timeout); // Clear the previous timeout
    }
    timeout = setTimeout(later, wait); // Set new timeout
  };
}

export function stripPrefix(suggestion: string, linePrefix: string) {
  if (suggestion.startsWith(linePrefix)) {
    return suggestion.slice(linePrefix.length);
  }
  return suggestion;
}

export function collapseAdjacentDuplicateJsxInvocations(content: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  const jsxSelfClosing = /^\s*<([A-Z][A-Za-z0-9_]*)\b[^>]*\/>\s*$/;
  for (const line of lines) {
    const prev = out.length > 0 ? out[out.length - 1] : "";
    const sameTrimmed = prev.trim() === line.trim();
    if (sameTrimmed && jsxSelfClosing.test(line) && jsxSelfClosing.test(prev)) {
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export function normalizeInlineSuggestion(text: string) {
  return text.replace(/\n/g, "").replace(/\r/g, "").slice(0, 120);
}

export function deriveStyleHints(
  text: string,
  lineCount: number,
  lang: string,
): string {
  if (lang === "javascript" || lang === "typescript") {
    const semicolonLineMatches = text.match(/;\s*$/gm) || [];
    const usesSemicolons = semicolonLineMatches.length > lineCount * 0.1;
    const singleQuotes = (text.match(/'[^'\\\n]*(?:\\.[^'\\\n]*)*'/g) || [])
      .length;
    const doubleQuotes = (text.match(/"[^"\\\n]*(?:\\.[^"\\\n]*)*"/g) || [])
      .length;
    const prefersSingle = singleQuotes >= doubleQuotes;
    const tabMatches = text.match(/^\t+/gm) || [];
    const spaceMatches = text.match(/^ +/gm) || [];
    const tabs = tabMatches.length;
    const spaces = spaceMatches.length;
    let indent = "";
    if (tabs > spaces) indent = "use tabs";
    else {
      const spaceIndents = spaceMatches
        .map((m) => m.length)
        .filter((n) => n >= 2);
      let two = 0;
      let four = 0;
      for (const n of spaceIndents) {
        if (n % 4 === 0) four++;
        else if (n % 2 === 0) two++;
      }
      indent = four >= two ? "use 4-space indent" : "use 2-space indent";
    }
    return `${usesSemicolons ? "use semicolons" : "no semicolons"}; ${prefersSingle ? "prefer single quotes" : "prefer double quotes"
      }; ${indent}`;
  }
  return "";
}

export function removeCommentTags(code: string) {
  return code
    .replace(/\/\/(.*)$/gm, "$1") // Menghapus // dan menyimpan teks setelahnya
    .replace(/\/\*[\s\S]*?\*\//g, "") // Menghapus komentar multi-baris
    .replace(/#(.*)$/gm, "$1") // Menghapus # dan menyimpan teks setelahnya
    .replace(/<!--(.*?)-->/g, "$1") // Menghapus komentar HTML
    .replace(/\n\s*\n/g, "\n") // Menghapus baris kosong yang tersisa
    .trim(); // Menghapus spasi di awal dan akhir
}

export function stripMarkdownFences(text: string): string {
  if (!text) return text;

  let cleaned = text.trim();

  // Case 1: Entire string is a code block
  const fullMatch = cleaned.match(/^```[\w-]*\s*[\r\n]+([\s\S]*?)[\r\n]+```$/i);
  if (fullMatch) {
    return fullMatch[1].trim();
  }

  // Case 2: Contains a code block somewhere (take the first one)
  const partialMatch = cleaned.match(/```[\w-]*\s*[\r\n]+([\s\S]*?)[\r\n]+```/i);
  if (partialMatch) {
    return partialMatch[1].trim();
  }

  return cleaned;
}
