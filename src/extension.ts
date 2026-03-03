// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { SidebarProvider } from "./SidebarProvider";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import logger from "vico-logger";
import { DiffManager } from "./DiffManager";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

let lastSuggestion: string | null = null;
let lastLinePrefix: string | null = null;

function debounce(func: (...args: any[]) => void, wait: number) {
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

function stripPrefix(suggestion: string, linePrefix: string) {
  if (suggestion.startsWith(linePrefix)) {
    return suggestion.slice(linePrefix.length);
  }
  return suggestion;
}

let requestId = 0;
let currentAbortController: AbortController | null = null;
let lastRequestLine: number | null = null;
let lastRequestPrefix: string | null = null;

let lastTypedAt = Date.now();
let lastWasNewLine = false;
const recentAppliedDiffFingerprints: Map<string, number> = new Map();

function buildDiffFingerprint(
  filePath: string,
  searchText: string,
  replaceText: string,
): string {
  return crypto
    .createHash("md5")
    .update(`${filePath}\n---SEARCH---\n${searchText}\n---REPLACE---\n${replaceText}`)
    .digest("hex");
}

function markAndCheckRecentDiff(fingerprint: string): boolean {
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

function collapseAdjacentDuplicateJsxInvocations(content: string): string {
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

async function fetchSuggestions(
  context: vscode.ExtensionContext,
  editor: vscode.TextEditor,
) {
  if (!isInlineEnabled()) return;

  currentAbortController?.abort();
  const controller = new AbortController();
  currentAbortController = controller;

  const currentRequest = ++requestId;

  const cursorLine = editor.selection.active.line;

  // 👉 Baris sumber (kalau baris kosong, ambil baris atas)
  let sourceLine = cursorLine;
  let lineText = editor.document.lineAt(cursorLine).text;

  if (!lineText.trim() && cursorLine > 0) {
    sourceLine = cursorLine - 1;
    lineText = editor.document.lineAt(sourceLine).text;
  }

  if (!lineText.trim()) return;

  const cleanedInput = removeCommentTags(lineText.trim());
  if (cleanedInput.length < 3 && cursorLine === sourceLine) return;

  // 👉 Inline muncul di posisi cursor (bisa baris kosong)
  const isNewLine = cursorLine !== sourceLine;
  lastWasNewLine = isNewLine;

  lastRequestLine = cursorLine;
  lastRequestPrefix = isNewLine ? "" : cleanedInput;
  lastLinePrefix = lineText;

  const token = context.globalState.get("token");
  if (!token) {
    vscode.window.showErrorMessage(
      "Vibe Coding token is missing. Please login first.",
    );
    return;
  }

  const lang = editor.document.languageId;
  const file = path.basename(editor.document.fileName);
  let CONTEXT_RADIUS = 40;
  if (lang === "python" || file.endsWith(".py")) {
    CONTEXT_RADIUS = 80;
  }
  const contextCenterLine = sourceLine;
  const start = Math.max(0, contextCenterLine - CONTEXT_RADIUS);
  const end = Math.min(
    editor.document.lineCount - 1,
    contextCenterLine + CONTEXT_RADIUS,
  );

  let contextCode = "";
  for (let i = start; i <= end; i++) {
    contextCode += editor.document.lineAt(i).text + "\n";
  }

  // Status bar loading
  loadingStatusBarItem.text = "⚡ Vibe Coding thinking...";
  if (isNewLine) {
    loadingStatusBarItem.text = "✨ Vibe Coding predicting next line...";
  }
  const showLoadingTimeout = setTimeout(() => loadingStatusBarItem.show(), 400);

  const styleHints = deriveStyleHints(editor.document, lang);
  const extraHeuristics =
    lang === "python"
      ? "Avoid inserting closing parentheses, colons, or next-line indentation."
      : lang === "javascript" || lang === "typescript"
        ? "Match the file's quote and semicolon style."
        : lang === "html"
          ? "For HTML/XML contexts: produce a complete, syntactically valid element or a closing tag when appropriate. Never output a bare attribute. When starting a new line, begin with '<' or '</'."
          : "";

  const body = {
    userId: "vscode-user",
    message:
      `File: ${file}\n` +
      `Language: ${lang}\n` +
      `Follow ${lang} best practices and syntax.\n` +
      (styleHints ? `Coding style hints: ${styleHints}\n` : "") +
      (extraHeuristics ? `${extraHeuristics}\n` : "") +
      `Here is the surrounding code context:\n${contextCode}\n\n` +
      (isNewLine
        ? `The user just pressed Enter and is starting a new line.\n` +
          `Suggest ONLY the next single line of code that should appear here.\n`
        : `The user is currently typing this line: "${cleanedInput}".\n` +
          `Complete ONLY this line.\n`) +
      `Return a SINGLE LINE completion only.\n` +
      `Do NOT add new lines.\n` +
      `Do NOT return multiple statements.\n` +
      `Do NOT repeat any existing text from the current line.\n` +
      `Do NOT add braces, semicolons, or syntax that already exists later in the file.\n` +
      `Return ONLY the continuation text without explanations, markdown, or code fences.`,
  };

  // 👉 simpan posisi cursor saat request dikirim
  const requestLine = cursorLine;

  try {
    const response = await fetch("http://localhost:13100/api/suggest", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorMessage = await response.text();
      throw new Error(`Error ${response.status}: ${errorMessage}`);
    }

    if (currentRequest !== requestId) return; // ❌ skip response lama

    const suggestions: any = await response.json();

    // ❌ Kalau user pindah baris, skip
    if (editor.selection.active.line !== requestLine) return;

    // Filter khusus HTML agar tidak menyarankan atribut tunggal saat new line
    if (
      lastWasNewLine &&
      (lang === "html" || file.toLowerCase().endsWith(".html"))
    ) {
      const candidate = (suggestions?.message ?? "").trim();
      if (
        candidate &&
        (!candidate.startsWith("<") || !candidate.includes(">"))
      ) {
        console.log("Drop invalid HTML new-line suggestion:", candidate);
        return;
      }
    }

    const freshLine = editor.document.lineAt(requestLine).text;
    presentSuggestions(suggestions.message, freshLine);

    await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
    setTimeout(() => {
      if (lastSuggestion) {
        vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
      }
    }, 50);
  } catch (error) {
    if ((error as any).name === "AbortError") return;
    console.error("Error while fetching suggestions:", error);
  } finally {
    clearTimeout(showLoadingTimeout);
    loadingStatusBarItem.hide();
  }
}

function isInlineEnabled() {
  return vscode.workspace
    .getConfiguration("vibeCoding")
    .get<boolean>("inline.enabled", true);
}

function normalizeInlineSuggestion(text: string) {
  return text.replace(/\n/g, "").replace(/\r/g, "").slice(0, 120);
}

function deriveStyleHints(document: vscode.TextDocument, lang: string): string {
  const text = document.getText();
  if (lang === "javascript" || lang === "typescript") {
    const semicolonLineMatches = text.match(/;\s*$/gm) || [];
    const usesSemicolons =
      semicolonLineMatches.length > document.lineCount * 0.1;
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
    return `${usesSemicolons ? "use semicolons" : "no semicolons"}; ${
      prefersSingle ? "prefer single quotes" : "prefer double quotes"
    }; ${indent}`;
  }
  return "";
}

async function presentSuggestions(suggestion: string, linePrefix?: string) {
  console.log("Presenting suggestion:", suggestion);

  if (suggestion && suggestion.trim().length > 0) {
    let next = suggestion;

    if (linePrefix) {
      next = stripPrefix(suggestion, linePrefix);
    }

    lastSuggestion = normalizeInlineSuggestion(next);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function handleDiff(
  fileUri: vscode.Uri,
  fileContent: string,
  relativePath: string,
  context: vscode.ExtensionContext,
) {
  try {
    const diffManager = DiffManager.getInstance(context);
    return await diffManager.openDiff(fileUri, fileContent);
  } catch (err: any) {
    logger.error("Failed to write file:", err);
    vscode.window.showErrorMessage(
      "Failed to write file: " + (err.message || err.toString()),
    );
    return { success: false, originalContent: null };
  }
}

function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function fromLf(text: string, eol: "\r\n" | "\n"): string {
  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function replaceFirstOccurrence(
  text: string,
  search: string,
  replace: string,
): string {
  const idx = text.indexOf(search);
  if (idx === -1) return text;
  return text.slice(0, idx) + replace + text.slice(idx + search.length);
}

function trimEdgeBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

function replaceByTrimmedLineMatch(
  currentLf: string,
  searchLf: string,
  replaceLf: string,
): { matched: boolean; next: string } {
  const currentLines = currentLf.split("\n");
  const searchLinesRaw = searchLf.split("\n");
  const searchLines = trimEdgeBlankLines(searchLinesRaw);
  if (searchLines.length === 0) {
    return { matched: false, next: currentLf };
  }

  for (let i = 0; i <= currentLines.length - searchLines.length; i++) {
    let ok = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (currentLines[i + j].trimEnd() !== searchLines[j].trimEnd()) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const nextLines = [
      ...currentLines.slice(0, i),
      ...replaceLf.split("\n"),
      ...currentLines.slice(i + searchLines.length),
    ];
    return { matched: true, next: nextLines.join("\n") };
  }
  return { matched: false, next: currentLf };
}

function applySearchReplaceWithFallback(
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

  const eol = detectEol(currentContent);
  const currentLf = toLf(currentContent);
  const searchLf = toLf(searchText);
  const replaceLf = toLf(replaceText);

  if (searchLf && currentLf.includes(searchLf)) {
    const nextLf = replaceFirstOccurrence(currentLf, searchLf, replaceLf);
    return { matched: true, next: fromLf(nextLf, eol), strategy: "normalized-eol" };
  }

  const loose = replaceByTrimmedLineMatch(currentLf, searchLf, replaceLf);
  if (loose.matched) {
    return { matched: true, next: fromLf(loose.next, eol), strategy: "trimmed-line" };
  }

  return { matched: false, next: currentContent, strategy: "none" };
}

async function writeFileVico(
  context: vscode.ExtensionContext,
  editor: vscode.TextEditor,
  sidebarProvider: SidebarProvider,
) {
  logger.info("writeFileVico called");

  const writeContent = context.globalState.get<string>("writeContent");
  if (!writeContent) {
    vscode.window.showWarningMessage(
      "No content to write. No response from assistant.",
    );
    return;
  }

  if (!vscode.workspace.workspaceFolders) {
    vscode.window.showErrorMessage("No workspace folder open!");
    return;
  }

  const projectRoot = vscode.workspace.workspaceFolders[0].uri;
  const projectRootPath = projectRoot.fsPath;
  const dependencyMarkers = [
    "package.json",
    "requirements.txt",
    "pyproject.toml",
    "go.mod",
    "Cargo.toml",
    "pom.xml",
    "build.gradle",
    "composer.json",
  ];
  const hasDependencyFile = dependencyMarkers.some((f) =>
    fs.existsSync(path.join(projectRootPath, f)),
  );
  let blockedMetaWrites = 0;
  const resolveWorkspaceTarget = async (
    rawRelativePath: string,
  ): Promise<{ fileUri: vscode.Uri; relativePath: string }> => {
    let cleanPath = rawRelativePath.trim().replace(/^\.\//, "");
    if (cleanPath.startsWith("/") || cleanPath.startsWith("\\")) {
      cleanPath = cleanPath.substring(1);
    }

    const directUri = vscode.Uri.joinPath(projectRoot, cleanPath);
    if (fs.existsSync(directUri.fsPath)) {
      return { fileUri: directUri, relativePath: cleanPath };
    }

    const hasPathSeparator = cleanPath.includes("/") || cleanPath.includes("\\");
    if (!hasPathSeparator) {
      const excludePattern =
        "**/{node_modules,.git,dist,build,out,coverage,.vscode,.idea,tmp,temp,venv,__pycache__,.vico}/**";
      const matches = await vscode.workspace.findFiles(
        `**/${cleanPath}`,
        excludePattern,
        20,
      );
      if (matches.length > 0) {
        const sorted = matches
          .map((u) => vscode.workspace.asRelativePath(u).replace(/\\/g, "/"))
          .sort((a, b) => a.length - b.length);
        const resolvedRelative = sorted[0];
        logger.info(
          `[writeFile] Resolved target "${rawRelativePath}" -> "${resolvedRelative}"`,
        );
        return {
          fileUri: vscode.Uri.joinPath(projectRoot, resolvedRelative),
          relativePath: resolvedRelative,
        };
      }
    }

    return { fileUri: directUri, relativePath: cleanPath };
  };

  try {
    // 1. Extract block [writeFile]...[/writeFile]
    // Supports both single block or multiple blocks if the AI outputs them sequentially
    const blockRegex = /\[writeFile\]([\s\S]*?)\[\/writeFile\]/g;
    let match;
    let contentToProcess = "";

    // Accumulate all content within [writeFile] tags
    while ((match = blockRegex.exec(writeContent)) !== null) {
      contentToProcess += match[1] + "\n";
    }

    if (!contentToProcess.trim()) {
      // Fallback: try to parse the whole message if the tags are missing but command was triggered
      // or if the tag was just [writeFile] without closing (though regex above requires closing)
      // Let's try to match open tag until end of string if no closing tag found
      const openTagMatch = writeContent.match(/\[writeFile\]([\s\S]*)/);
      if (openTagMatch) {
        contentToProcess = openTagMatch[1];
      } else {
        contentToProcess = writeContent;
      }
    }

    // 2. Parse [file name="path"]...[/file] OR [diff name="path"]...[/diff]
    // Improved regex to handle newlines and various attributes robustly
    const fileRegex =
      /\[file\s+(?:name|path)=["']([^"']+)["'](?:\s+type=["'][^"']+["'])?\]([\s\S]*?)\[\/file\]/g;
    const diffRegex = /\[diff\s+(?:name|path)=["']([^"']+)["']\]([\s\S]*?)\[\/diff\]/g;
    let fileMatch;
    let filesCreated = 0;
    let duplicateSkipped = false;
    let sawWritableBlocks = false;
    const fileChanges: { filePath: string; originalContent: string | null }[] =
      [];

    // 2.1 Handle [file] blocks (Full file writes)
    while ((fileMatch = fileRegex.exec(contentToProcess)) !== null) {
      sawWritableBlocks = true;
      const relativePath = fileMatch[1].trim();
      let fileContent = fileMatch[2].trim();
      const normalizedRelative = relativePath.replace(/\\/g, "/");
      const isVicoMetaTarget =
        normalizedRelative.startsWith(".vico/") ||
        normalizedRelative === "memory.md";
      if (isVicoMetaTarget && !hasDependencyFile) {
        blockedMetaWrites++;
        logger.warn(
          `Blocked pre-scaffold metadata write: ${relativePath}. Scaffold first.`,
        );
        continue;
      }

      // STRIP MARKDOWN CODE BLOCKS FROM CONTENT
      // Often agents wrap the content in ```typescript ... ```
      // IMPROVED: Use a more robust check that handles any language identifier and whitespace
      if (fileContent.startsWith("```") && fileContent.endsWith("```")) {
        const lines = fileContent.split("\n");
        // Check if it looks like a code block (at least 2 lines: opener and closer)
        if (lines.length >= 2) {
          // Remove first line (```language)
          lines.shift();
          // Remove last line (```)
          lines.pop();

          // Rejoin
          fileContent = lines.join("\n").trim();
        }
      }

      const resolvedTarget = await resolveWorkspaceTarget(relativePath);
      const effectiveRelativePath = resolvedTarget.relativePath;
      const fileUri = resolvedTarget.fileUri;
      const dirUri = vscode.Uri.file(path.dirname(fileUri.fsPath));

      // 3. Create directory if it doesn't exist
      await vscode.workspace.fs.createDirectory(dirUri);

      // Special handling for history.md, lessons.md, architecture.md, and style.md:
      // Append and write directly (no diff) for log files.
      // Overwrite directly for structural/style definition files (architecture.md, style.md) as they are source of truth.
      const isLogFile =
        effectiveRelativePath.toLowerCase().endsWith("history.md") ||
        effectiveRelativePath.toLowerCase().endsWith("lessons.md") ||
        effectiveRelativePath.toLowerCase().endsWith("memory.md");
      const isStructuralFile =
        effectiveRelativePath.toLowerCase().endsWith("architecture.md") ||
        effectiveRelativePath.toLowerCase().endsWith("style.md");

      if (isLogFile || isStructuralFile) {
        let newContent = fileContent;
        let originalContent = null;

        if (isLogFile) {
          try {
            const existingBytes = await vscode.workspace.fs.readFile(fileUri);
            const existingString = Buffer.from(existingBytes).toString("utf8");

            if (existingString.includes(fileContent.trim())) {
              duplicateSkipped = true;
              continue;
            }

            if (existingString.trim().length > 0) {
              originalContent = existingString;
              // Append with a separator and timestamp for better organization
              const timestamp = new Date().toISOString().split("T")[0];
              newContent =
                existingString + `\n\n## [${timestamp}]\n` + newContent;
            }
          } catch (e) {
            // File doesn't exist, proceed with newContent
          }
        } else {
          // Structural files: Read original for history tracking, but overwrite content
          try {
            const existingBytes = await vscode.workspace.fs.readFile(fileUri);
            originalContent = Buffer.from(existingBytes).toString("utf8");
          } catch (e) {}
        }

        try {
          await vscode.workspace.fs.writeFile(
            fileUri,
            Buffer.from(newContent, "utf8"),
          );
          filesCreated++;
          fileChanges.push({
            filePath: effectiveRelativePath,
            originalContent: originalContent,
          });
          continue; // Skip handleDiff
        } catch (e) {
          logger.error(`Failed to write .vico file:`, e);
          // Fallback to handleDiff if direct write fails? No, just log error.
        }
      }

      // 4. Handle Diff & Write
      const result = await handleDiff(
        fileUri,
        fileContent,
        effectiveRelativePath,
        context,
      );
      if (result && result.success) {
        filesCreated++;
        fileChanges.push({
          filePath: effectiveRelativePath,
          originalContent: result.originalContent,
        });
      }
    }

    // 2.2 Handle [diff] blocks (Partial targeted diffs)
    const liveContentByPath = new Map<string, string>();
    const originalContentByPath = new Map<string, string>();
    const changedPaths = new Set<string>();
    while ((fileMatch = diffRegex.exec(contentToProcess)) !== null) {
      sawWritableBlocks = true;
      const relativePath = fileMatch[1].trim();
      const diffContent = fileMatch[2].trim();
      const normalizedRelative = relativePath.replace(/\\/g, "/");
      const isVicoMetaTarget =
        normalizedRelative.startsWith(".vico/") ||
        normalizedRelative === "memory.md";
      if (isVicoMetaTarget && !hasDependencyFile) {
        blockedMetaWrites++;
        logger.warn(
          `Blocked pre-scaffold metadata diff: ${relativePath}. Scaffold first.`,
        );
        continue;
      }

      try {
        const resolvedTarget = await resolveWorkspaceTarget(relativePath);
        const effectiveRelativePath = resolvedTarget.relativePath;
        const fileUri = resolvedTarget.fileUri;
        let currentContent = liveContentByPath.get(relativePath);
        if (typeof currentContent !== "string") {
          const existingBytes = await vscode.workspace.fs.readFile(fileUri);
          const originalContent = Buffer.from(existingBytes).toString("utf8");
          currentContent = originalContent;
          liveContentByPath.set(relativePath, originalContent);
          originalContentByPath.set(relativePath, originalContent);
        }

        // Extract SEARCH/REPLACE blocks
        const searchReplaceRegex =
          /<<<<<<<\s*SEARCH\s*[\r\n]*([\s\S]*?)\s*=======[\r\n]*([\s\S]*?)\s*>>>>>>>\s*REPLACE/g;
        let srMatch;
        let matchedBlocks = 0;
        let totalBlocks = 0;
        let failedBlocks = 0;
        let lastReplaceText = "";
        let nextContent = currentContent;

        while ((srMatch = searchReplaceRegex.exec(diffContent)) !== null) {
          totalBlocks++;
          const searchText = srMatch[1];
          const replaceText = srMatch[2];
          lastReplaceText = replaceText;
          const diffFingerprint = buildDiffFingerprint(
            relativePath,
            searchText,
            replaceText,
          );
          const isDuplicateDiff = markAndCheckRecentDiff(diffFingerprint);
          if (
            isDuplicateDiff &&
            replaceText.trim().length > 0 &&
            nextContent.includes(replaceText.trim())
          ) {
            matchedBlocks++;
            logger.warn(
              `Skipped duplicate diff block for ${relativePath} (fingerprint repeated).`,
            );
            continue;
          }
          const applyResult = applySearchReplaceWithFallback(
            nextContent,
            searchText,
            replaceText,
          );
          if (applyResult.matched) {
            nextContent = applyResult.next;
            matchedBlocks++;
            logger.info(
              `Applied diff block in ${relativePath} using strategy=${applyResult.strategy}`,
            );
          } else {
            failedBlocks++;
            logger.warn(`Search text not found in ${relativePath}:\n${searchText}`);
          }
        }

        // Multi-block diffs are treated as transactional to avoid corrupted partial files.
        if (totalBlocks > 1 && failedBlocks > 0) {
          logger.warn(
            `Aborting partial multi-block diff for ${relativePath}: matched=${matchedBlocks}, failed=${failedBlocks}, total=${totalBlocks}.`,
          );
          vscode.window.showWarningMessage(
            `Could not safely apply multi-step diff to ${relativePath} (partial match). Re-run with full file overwrite to avoid corrupted code.`,
          );
          continue;
        }

        currentContent = nextContent;

        if (matchedBlocks > 0) {
          if (/\.(tsx|jsx)$/i.test(relativePath)) {
            currentContent = collapseAdjacentDuplicateJsxInvocations(
              currentContent,
            );
          }
          const result = await handleDiff(
            fileUri,
            currentContent,
            effectiveRelativePath,
            context,
          );
          if (result && result.success) {
            liveContentByPath.set(relativePath, currentContent);
            if (!changedPaths.has(relativePath)) {
              changedPaths.add(relativePath);
              filesCreated++;
              fileChanges.push({
                filePath: effectiveRelativePath,
                originalContent:
                  originalContentByPath.get(relativePath) ||
                  result.originalContent,
              });
            }
          }
        } else {
          const canFallbackToFullRewrite =
            totalBlocks === 1 &&
            ((lastReplaceText.trim().length > 200 &&
              /(export\s+default|function\s+\w+|\breturn\s*\()/i.test(
                lastReplaceText,
              )) ||
              (effectiveRelativePath.replace(/\\/g, "/").toLowerCase() ===
                "app/page.tsx" &&
                lastReplaceText.trim().length > 0));
          if (canFallbackToFullRewrite) {
            let rewritten = lastReplaceText;
            if (/\.(tsx|jsx)$/i.test(relativePath)) {
              rewritten = collapseAdjacentDuplicateJsxInvocations(rewritten);
            }
            logger.warn(
              `SEARCH not found for ${relativePath}. Using controlled full-rewrite fallback.`,
            );
            const fallbackResult = await handleDiff(
              fileUri,
              rewritten,
              effectiveRelativePath,
              context,
            );
            if (fallbackResult && fallbackResult.success) {
              liveContentByPath.set(relativePath, rewritten);
              if (!changedPaths.has(relativePath)) {
                changedPaths.add(relativePath);
                filesCreated++;
                fileChanges.push({
                  filePath: effectiveRelativePath,
                  originalContent:
                    originalContentByPath.get(relativePath) ||
                    fallbackResult.originalContent,
                });
              }
            } else {
              vscode.window.showWarningMessage(
                `Could not apply changes to ${relativePath}. SEARCH block not found and fallback rewrite failed.`,
              );
            }
          } else {
            vscode.window.showWarningMessage(
              `Could not apply changes to ${relativePath}. SEARCH block not found (exact/eol/trimmed match failed).`,
            );
          }
        }
      } catch (err: any) {
        logger.error(`Failed to apply diff to ${relativePath}:`, err);
        vscode.window.showErrorMessage(`Failed to read file ${relativePath}`);
      }
    }

    // Fallback: Check for XML-style tags <file path="...">...</file> (sometimes agents use this)
    if (filesCreated === 0) {
      const xmlRegex = /<file\s+path="([^"]+)">([\s\S]*?)<\/file>/g;
      while ((fileMatch = xmlRegex.exec(contentToProcess)) !== null) {
        sawWritableBlocks = true;
        const relativePath = fileMatch[1].trim();
        const fileContent = fileMatch[2].trim();
        const normalizedRelative = relativePath.replace(/\\/g, "/");
        const isVicoMetaTarget =
          normalizedRelative.startsWith(".vico/") ||
          normalizedRelative === "memory.md";
        if (isVicoMetaTarget && !hasDependencyFile) {
          blockedMetaWrites++;
          logger.warn(
            `Blocked pre-scaffold metadata XML write: ${relativePath}. Scaffold first.`,
          );
          continue;
        }
        const resolvedTarget = await resolveWorkspaceTarget(relativePath);
        const effectiveRelativePath = resolvedTarget.relativePath;
        const fileUri = resolvedTarget.fileUri;
        const dirUri = vscode.Uri.file(path.dirname(fileUri.fsPath));
        await vscode.workspace.fs.createDirectory(dirUri);

        // Special handling for memory.md: Append and write directly (no diff)
        if (effectiveRelativePath.toLowerCase().endsWith("memory.md")) {
          let newContent = fileContent;
          let originalContent = null;
          try {
            const existingBytes = await vscode.workspace.fs.readFile(fileUri);
            const existingString = Buffer.from(existingBytes).toString("utf8");

            if (existingString.includes(fileContent.trim())) {
              duplicateSkipped = true;
              continue;
            }

            if (existingString.trim().length > 0) {
              originalContent = existingString;
              const timestamp = new Date().toISOString().split("T")[0];
              newContent =
                existingString + `\n\n## [${timestamp}]\n` + newContent;
            }
          } catch (e) {
            // File doesn't exist
          }

          try {
            await vscode.workspace.fs.writeFile(
              fileUri,
              Buffer.from(newContent, "utf8"),
            );
            filesCreated++;
            fileChanges.push({
              filePath: effectiveRelativePath,
              originalContent: originalContent,
            });
            continue;
          } catch (e) {
            logger.error(`Failed to write memory.md:`, e);
          }
        }

        const result = await handleDiff(
          fileUri,
          fileContent,
          effectiveRelativePath,
          context,
        );
        if (result && result.success) {
          filesCreated++;
          fileChanges.push({
            filePath: effectiveRelativePath,
            originalContent: result.originalContent,
          });
        }
      }
    }

    if (filesCreated > 0) {
      // Check if the only file created is memory.md - if so, be silent
      const isSilentUpdate =
        fileChanges.length === 1 &&
        fileChanges[0].filePath.toLowerCase().endsWith("memory.md");

      if (!isSilentUpdate) {
        vscode.window.showInformationMessage(
          `🎉 Successfully created/updated ${filesCreated} files.`,
        );
      }
      // Send file changes to webview for history tracking
      if (sidebarProvider) {
        sidebarProvider.postMessage({
          command: "filesModified",
          changes: fileChanges,
        });
      }
    } else if (!duplicateSkipped && !sawWritableBlocks) {
      if (blockedMetaWrites > 0) {
        vscode.window.showWarningMessage(
          "Blocked .vico/memory writes because project is not scaffolded yet. Initialize framework first.",
        );
        return;
      }
      // Log content to debug why regex failed
      logger.warn(
        "No file blocks found. Content preview:",
        contentToProcess.substring(0, 200),
      );
      vscode.window.showWarningMessage(
        'No writable blocks found. Use [file name="path"]...[/file] or [diff name="path"]...[/diff] inside [writeFile].',
      );
    }
  } catch (err: any) {
    logger.error("Failed to write file:", err);
    vscode.window.showErrorMessage(
      "Failed to write file: " + (err.message || err.toString()),
    );
  }
}

let loadingStatusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  loadingStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  context.subscriptions.push(loadingStatusBarItem);
  // Disini kita daftarin command
  let disposable = vscode.commands.registerCommand(
    "vibe-coding.writeFile",
    async () => {
      logger.info("writeFile command triggered");
      await writeFileVico(
        context,
        vscode.window.activeTextEditor!,
        sidebarProvider,
      );
    },
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vibe-coding.openDiff",
      async (args: any) => {
        // args: { filePath, code }
        if (!args || !args.filePath || !args.code) {
          vscode.window.showErrorMessage("Invalid arguments for openDiff");
          return;
        }

        if (!vscode.workspace.workspaceFolders) {
          vscode.window.showErrorMessage("No workspace folder open!");
          return;
        }

        const projectRoot = vscode.workspace.workspaceFolders[0].uri;
        let cleanPath = args.filePath.trim();
        if (cleanPath.startsWith("/") || cleanPath.startsWith("\\")) {
          cleanPath = cleanPath.substring(1);
        }

        const fileUri = vscode.Uri.joinPath(projectRoot, cleanPath);

        // Ensure directory exists
        const dirUri = vscode.Uri.file(path.dirname(fileUri.fsPath));
        await vscode.workspace.fs.createDirectory(dirUri);

        const tempDir = os.tmpdir();
        const fileName = path.basename(fileUri.fsPath);
        // Use hash of file path to ensure only one diff tab per file
        const fileHash = crypto
          .createHash("md5")
          .update(fileUri.fsPath)
          .digest("hex");
        const tempFilePath = path.join(
          tempDir,
          `vico_diff_${fileHash}_${fileName}`,
        );

        fs.writeFileSync(tempFilePath, args.code);
        const tempUri = vscode.Uri.file(tempFilePath);

        await vscode.commands.executeCommand(
          "vscode.diff",
          fileUri,
          tempUri,
          `${fileName} ↔ Proposed Changes`,
          {
            preview: false,
            viewColumn: vscode.ViewColumn.Beside,
          },
        );
      },
    ),
  );

  context.subscriptions.push(disposable);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vibeCoding.inline.enabled")) {
        lastSuggestion = null; // clear ghost text
        vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
      }
    }),
  );

  const SUPPORTED_LANGUAGES = [
    "javascript",
    "typescript",
    "python",
    "php",
    "go",
    "java",
    "c",
    "cpp",
    "csharp",
    "rust",
    "ruby",
    "json",
    "html",
    "css",
    "bash",
    "yaml",
    "dockerfile",
    "markdown",
    "sql",
  ];

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      SUPPORTED_LANGUAGES.map((lang) => ({ scheme: "file", language: lang })),
      {
        provideCompletionItems(document, position) {
          if (!lastSuggestion || !lastSuggestion.trim()) return;

          const item = new vscode.CompletionItem(
            lastSuggestion,
            vscode.CompletionItemKind.Snippet,
          );
          item.insertText = new vscode.SnippetString(lastSuggestion);
          item.detail = "AI Suggestion from Vibe Coding";
          item.sortText = "\u0000";
          item.command = {
            command: "vibe-coding.clearSuggestion",
            title: "",
          };

          return [item];
        },
      },
      "", // manual trigger
    ),
  );

  // Command untuk menghapus suggestion setelah dipilih
  context.subscriptions.push(
    vscode.commands.registerCommand("vibe-coding.clearSuggestion", () => {
      lastSuggestion = null;
    }),
  );
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "vibe-coding" is now active!');
  // Register the Sidebar Panel
  const sidebarProvider = new SidebarProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "vibe-coding-sidebar",
      sidebarProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
  );

  // Register a command to update the webview with the current file and line information
  context.subscriptions.push(
    vscode.commands.registerCommand("vibe-coding.updateWebview", () => {
      const editor = vscode.window.activeTextEditor;
      const webview = sidebarProvider._view;
      if (!webview) return;

      let filePath = "";
      let fileName = "";
      let selectedLine = "";
      let whitelist: string[] = [];

      if (editor) {
        filePath = editor.document.fileName;
        fileName = path.basename(filePath);
        const selection = editor.selection;
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        selectedLine = `${startLine}-${endLine}`;
      }

      webview.webview.postMessage({
        command: "updateFileInfo",
        filePath: fileName,
        selectedLine: selectedLine,
        guardrails: {
          whitelist: whitelist,
          lineLimits: selectedLine ? { [fileName]: selectedLine } : {},
        },
      });
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { scheme: "file" },
      {
        async provideInlineCompletionItems(document, position) {
          if (!isInlineEnabled()) return [];
          if (!lastSuggestion) return [];
          if (lastRequestLine !== position.line) return [];

          const lineText = document.lineAt(position.line).text;
          const isNewLine = lineText.trim() === "";

          if (
            !isNewLine &&
            lastRequestPrefix &&
            !lineText.trim().startsWith(lastRequestPrefix)
          ) {
            return [];
          }

          return [
            {
              insertText: lastSuggestion,
              range: new vscode.Range(position, position),
            },
          ];
        },
      },
    ),
  );

  const debouncedFetch = debounce(() => {
    const editor = vscode.window.activeTextEditor;
    if (editor) fetchSuggestions(context, editor);
  }, 600);

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const change = e.contentChanges[0];
      if (!change) return;

      lastSuggestion = null;
      vscode.commands.executeCommand("editor.action.inlineSuggest.hide");

      const isNewLine = change.text === "\n";
      const isTyping = change.text.length > 0 && change.text !== "\n";

      if (isTyping || isNewLine) {
        debouncedFetch();
      }

      if (isNewLine) {
        setTimeout(() => {
          vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
        }, 80);
      }
    }),
  );

  vscode.workspace.onDidChangeTextDocument((e) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const change = e.contentChanges[0];
    if (!change) return;

    // 👉 Detect user tekan Enter
    if (change.text === "\n") {
      setTimeout(() => {
        vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
      }, 50);
    }
  });

  // Trigger the updateWebview command when the active editor changes or the selection changes
  vscode.window.onDidChangeActiveTextEditor(() => {
    vscode.commands.executeCommand("vibe-coding.updateWebview");
  });
  vscode.window.onDidChangeTextEditorSelection(() => {
    vscode.commands.executeCommand("vibe-coding.updateWebview");
  });

  // Initial trigger to update the webview
  vscode.commands.executeCommand("vibe-coding.updateWebview");

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vibe-coding.applyCodeSelection",
      async (args: any) => {
        // Handle argument passing from webview which might be just "code" string or object
        let code = "";
        let filePath = null;

        if (typeof args === "string") {
          code = args;
        } else if (typeof args === "object") {
          code = args.code;
          filePath = args.filePath;
        }

        console.log(
          "apply code from chat",
          filePath ? `to ${filePath}` : "to active editor",
        );

        try {
          let document;
          let selection;
          let editor = vscode.window.activeTextEditor;

          if (filePath) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders) {
              const rootPath = workspaceFolders[0].uri.fsPath;
              let cleanPath = filePath.trim();
              if (cleanPath.startsWith("/") || cleanPath.startsWith("\\")) {
                cleanPath = cleanPath.substring(1);
              }
              const fullPath = path.join(rootPath, cleanPath);

              if (fs.existsSync(fullPath)) {
                document = await vscode.workspace.openTextDocument(fullPath);
              } else {
                vscode.window.showErrorMessage(`File not found: ${filePath}`);
                return;
              }
            }
          }

          if (!document && editor) {
            document = editor.document;
            selection = editor.selection;
          }

          if (document) {
            const originalText = document.getText();
            let newText = code;

            if (!filePath && selection && !selection.isEmpty) {
              const startOffset = document.offsetAt(selection.start);
              const endOffset = document.offsetAt(selection.end);
              newText =
                originalText.substring(0, startOffset) +
                code +
                originalText.substring(endOffset);
            } else if (filePath) {
              newText = code;
            } else {
              // Chat Mode (no file path) and no selection -> Append or Replace?
              // Usually chat mode without selection assumes replacement or new content?
              // Let's stick to replacing everything if no selection, OR warn user.
              // But for safety, let's just use the code as is for the diff.
              newText = code;
            }

            const tempDir = os.tmpdir();
            const fileName = path.basename(document.fileName);
            const fileHash = crypto
              .createHash("md5")
              .update(document.uri.fsPath)
              .digest("hex");
            const tempFilePath = path.join(
              tempDir,
              `vico_diff_${fileHash}_${fileName}`,
            );

            fs.writeFileSync(tempFilePath, newText);

            const tempUri = vscode.Uri.file(tempFilePath);
            const originalUri = document.uri;

            await vscode.commands.executeCommand(
              "vscode.diff",
              originalUri,
              tempUri,
              `${fileName} ↔ Proposed Changes`,
            );

            // Show confirmation dialog
            const choice = await vscode.window.showInformationMessage(
              `Review changes for ${fileName}. Do you want to apply these changes?`,
              "Apply Changes",
              "Discard",
            );

            if (choice === "Apply Changes") {
              // Apply changes to the original file
              fs.writeFileSync(document.fileName, newText);

              // Close the diff editor (optional, but good for UX)
              await vscode.commands.executeCommand(
                "workbench.action.closeActiveEditor",
              );

              // Show success message
              vscode.window.showInformationMessage(
                `Changes applied to ${fileName}`,
              );

              // Open the updated file
              const doc = await vscode.workspace.openTextDocument(
                document.fileName,
              );
              await vscode.window.showTextDocument(doc);

              // Notify webview about the change
              if (sidebarProvider) {
                const relativePath = vscode.workspace.asRelativePath(
                  document.uri,
                );
                sidebarProvider.postMessage({
                  command: "filesModified",
                  changes: [
                    {
                      filePath: relativePath,
                      originalContent: originalText,
                    },
                  ],
                });
              }
            } else {
              // Discard - maybe delete temp file?
              // fs.unlinkSync(tempFilePath); // Optional: cleanup
              vscode.window.showInformationMessage("Changes discarded.");
              await vscode.commands.executeCommand(
                "workbench.action.closeActiveEditor",
              );
            }
          } else {
            vscode.window.showErrorMessage(
              "No active editor or file found to apply code.",
            );
          }
        } catch (err) {
          console.error("Failed to open diff:", err);
          vscode.window.showErrorMessage("Failed to open diff view.");
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vibe-coding.keepAllModifiedFiles",
      async (args: any) => {
        const files = args?.files;
        if (!files || !Array.isArray(files) || files.length === 0) {
          vscode.window.showErrorMessage("No files to keep.");
          return;
        }

        if (!vscode.workspace.workspaceFolders) {
          vscode.window.showErrorMessage("No workspace folder open!");
          return;
        }

        const projectRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const diffManager = DiffManager.getInstance(context);
        let successCount = 0;
        let failCount = 0;
        const changes: { filePath: string; originalContent: string | null }[] =
          [];

        for (const file of files) {
          try {
            let cleanPath = file.filePath.trim();
            if (cleanPath.startsWith("/") || cleanPath.startsWith("\\")) {
              cleanPath = cleanPath.substring(1);
            }
            const fullPath = path.join(projectRoot, cleanPath);

            // Capture original content before overwriting
            let originalContent: string | null = null;
            if (fs.existsSync(fullPath)) {
              originalContent = fs.readFileSync(fullPath, "utf8");
            }

            // Ensure directory exists
            const dirPath = path.dirname(fullPath);
            if (!fs.existsSync(dirPath)) {
              fs.mkdirSync(dirPath, { recursive: true });
            }

            fs.writeFileSync(fullPath, file.code);

            // Accept diff in DiffManager
            await diffManager.acceptFile(vscode.Uri.file(fullPath));

            successCount++;
            changes.push({
              filePath: cleanPath,
              originalContent,
            });
          } catch (e) {
            console.error(`Failed to write ${file.filePath}:`, e);
            failCount++;
          }
        }

        if (successCount > 0) {
          vscode.window.showInformationMessage(
            `Successfully kept ${successCount} files.`,
          );
          // Notify webview
          if (sidebarProvider) {
            sidebarProvider.postMessage({
              command: "filesModified",
              changes: changes,
            });
          }
          // Close all diff editors
          await vscode.commands.executeCommand(
            "workbench.action.closeEditorsInGroup",
          );
        }
        if (failCount > 0) {
          vscode.window.showErrorMessage(`Failed to keep ${failCount} files.`);
        }
      },
    ),
  );

  vscode.commands.registerCommand(
    "vibe-coding.revertChanges",
    async (args: any) => {
      const changes = args?.changes;
      if (!changes || !Array.isArray(changes) || changes.length === 0) {
        vscode.window.showErrorMessage("No changes to revert.");
        return;
      }

      if (!vscode.workspace.workspaceFolders) {
        vscode.window.showErrorMessage("No workspace folder open!");
        return;
      }

      const projectRoot = vscode.workspace.workspaceFolders[0].uri;
      let successCount = 0;

      for (const change of changes) {
        try {
          const cleanPath = change.filePath.trim().replace(/^[\/\\]/, "");
          const fullUri = vscode.Uri.joinPath(projectRoot, cleanPath);

          if (change.originalContent === null) {
            // File was created, so delete it
            try {
              await vscode.workspace.fs.delete(fullUri);
              successCount++;
            } catch (e) {
              // Ignore if already deleted
            }
          } else {
            // File was modified, restore original content
            const data = Buffer.from(change.originalContent, "utf8");
            await vscode.workspace.fs.writeFile(fullUri, data);
            successCount++;
          }
        } catch (e) {
          console.error(`Failed to revert ${change.filePath}:`, e);
        }
      }

      if (successCount > 0) {
        vscode.window.showInformationMessage(
          `Successfully reverted ${successCount} files.`,
        );
      }
    },
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vibe-coding.fetchSuggestions", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        fetchSuggestions(context, editor);
      } else {
        vscode.window.showInformationMessage("No active text editor found.");
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vibe-coding.triggerCompletion", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const currentLine = editor.selection.active.line;
        // Lakukan edit untuk menambahkan newline di posisi kursor
        editor
          .edit((editBuilder) => {
            // Sisipkan newline di posisi kursor
            editBuilder.insert(editor.selection.active, "\n");
          })
          .then(() => {
            const currentLineText = editor.document.lineAt(currentLine).text;

            // Cek apakah baris sebelumnya adalah komentar
            if (/^\s*(\/\/|\/\*|\*|#|<!--)/.test(currentLineText)) {
              console.log("code completion generate..");
              // Jika baris sebelumnya adalah komentar, jalankan logika triggerCodeCompletion
              const allCode = editor.document.getText(); // Dapatkan seluruh kode dari editor
              let coding = currentLineText + "\n"; // Tambahkan baris sebelumnya ke coding

              // Panggil fungsi untuk membersihkan comment dan trigger completion
              const cleanCode = removeCommentTags(coding);
              triggerCodeCompletion(context, cleanCode, allCode);
            }
          });
      }
    }),
  );
}

function onUserInput(line: string) {
  // Simpan line ke riwayat
  console.log(line);
}
function removeCommentTags(code: string) {
  return code
    .replace(/\/\/(.*)$/gm, "$1") // Menghapus // dan menyimpan teks setelahnya
    .replace(/\/\*[\s\S]*?\*\//g, "") // Menghapus komentar multi-baris
    .replace(/#(.*)$/gm, "$1") // Menghapus # dan menyimpan teks setelahnya
    .replace(/<!--(.*?)-->/g, "$1") // Menghapus komentar HTML
    .replace(/\n\s*\n/g, "\n") // Menghapus baris kosong yang tersisa
    .trim(); // Menghapus spasi di awal dan akhir
}

async function triggerCodeCompletion(
  context: vscode.ExtensionContext,
  comment: string,
  allCode: string,
) {
  const allCodeData = "```" + allCode + "```";
  // Logika untuk generate suggestion berdasarkan lineContent
  const token = context.globalState.get<string>("token");
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const lang = editor.document.languageId;
    const file = path.basename(editor.document.fileName);
    const styleHints = deriveStyleHints(editor.document, lang);
    const extraHeuristics =
      lang === "python"
        ? "Avoid inserting closing parentheses, colons, or next-line indentation."
        : lang === "javascript" || lang === "typescript"
          ? "Match the file's quote and semicolon style."
          : "";
    const body = {
      userId: "vscode-user",
      token: token,
      message:
        `File: ${file}\n` +
        `Language: ${lang}\n` +
        (styleHints ? `Coding style hints: ${styleHints}\n` : "") +
        (extraHeuristics ? `${extraHeuristics}\n` : "") +
        `Here is the surrounding code context:\n${allCode}\n\n` +
        `The user is currently typing this line: "${comment}".\n` +
        `Return a SINGLE LINE continuation only. Do NOT add new lines or multiple statements. Do NOT repeat existing text from the line. Do NOT add braces, semicolons, or syntax that already exists later in the file. Return ONLY the continuation text without explanations.`,
    };

    // Buat StatusBarItem untuk loading
    loadingStatusBarItem.text = "🔄 Vibe Coding loading...";
    loadingStatusBarItem.show();

    try {
      const response = await fetch("http://localhost:13100/api/suggest", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      // Cek apakah response berhasil
      if (!response.ok) {
        const errorMessage = await response.text();
        throw new Error(`Error ${response.status}: ${errorMessage}`);
      }

      // Jika berhasil, ambil data
      const coding: any = await response.json();

      // Menambahkan hasil sementara ke editor
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const currentLine = editor.selection.active.line;

        // Tampilkan pesan instruksi
        const instructionMessage = "Accept code from Vibe Coding...";

        vscode.window
          .showInformationMessage(
            instructionMessage,
            { modal: true },
            "Accept Code",
            "Decline",
          )
          .then((selection) => {
            if (selection === "Accept Code") {
              // Jika pengguna memilih 'Terima Kode'
              editor.edit((editBuilder) => {
                // Hapus pesan instruksi jika ada
                const instructionStartPosition = new vscode.Position(
                  currentLine,
                  0,
                );
                const instructionEndPosition = new vscode.Position(
                  currentLine + 1,
                  0,
                );
                editBuilder.delete(
                  new vscode.Range(
                    instructionStartPosition,
                    instructionEndPosition,
                  ),
                );

                // Sisipkan hasil code completion
                editBuilder.insert(
                  new vscode.Position(currentLine, 0),
                  `${coding.message}\n`,
                );
              });
            } else if (selection === "Decline") {
              // Jika pengguna memilih 'Tolak Kode', lakukan sesuatu jika perlu
              console.log("Kode ditolak.");
            }
          });
      }
    } catch (error) {
      console.error(error);
    } finally {
      // Sembunyikan StatusBarItem loading setelah selesai
      loadingStatusBarItem.hide();
    }
  }
}

//implementasi disini

// This method is called when your extension is deactivated
export function deactivate() {}
