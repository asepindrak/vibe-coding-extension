// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { SidebarProvider } from "./SidebarProvider";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";

async function fetchAi(
  url: string,
  options: any,
  model?: string,
  provider?: string,
  userApiKey?: string,
  context?: vscode.ExtensionContext,
) {
  if (provider === "ollama") {
    let ollamaModel = model || "llama3";
    if (ollamaModel.startsWith("ollama:")) {
      ollamaModel = ollamaModel.replace("ollama:", "");
    }

    const ollamaUrl = "http://localhost:11434/v1/chat/completions";

    // Reconstruct messages from body
    let messages = [];
    const body = options.body ? JSON.parse(options.body) : {};

    if (url.endsWith("/suggest")) {
      messages = [
        {
          role: "system",
          content:
            "You are a code completion engine. Read the provided file name, language, and surrounding code. " +
            "Return ONLY the continuation for the current line with no explanations, no markdown, no code fences, " +
            "no newlines, and do not repeat existing text.",
        },
        { role: "user", content: body.message || "" },
      ];
    } else {
      messages = [{ role: "user", content: body.message || "" }];
    }

    const response = await fetch(ollamaUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        messages: messages,
        stream: false,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama error: ${errText}`);
    }

    const json: any = await response.json();
    const content = json.choices?.[0]?.message?.content || "";

    // Sanitize suggestion if it's a suggest request
    const message = url.endsWith("/suggest")
      ? content
        .replace(/\r/g, "")
        .split("\n")
        .map((s: string) => s.trim())
        .filter(Boolean)[0] || ""
      : content;

    return {
      ok: true,
      status: 200,
      json: async () => ({ message }),
      text: async () => JSON.stringify({ message }),
    } as any;
  }

  // If using custom API key for OpenAI (BYOK) or custom endpoint
  const customUrl = context?.globalState.get<string>("vico.customApiUrl");
  if ((userApiKey && userApiKey.trim()) || (customUrl && customUrl.trim())) {
    const body = options.body ? JSON.parse(options.body) : {};
    let apiUrl = "https://api.openai.com/v1/chat/completions";

    if (customUrl && customUrl.trim()) {
      apiUrl = customUrl;
    }

    let messages = [];
    if (url.endsWith("/suggest")) {
      messages = [
        {
          role: "system",
          content:
            "You are a code completion engine. Return ONLY the continuation for the current line.",
        },
        { role: "user", content: body.message || "" },
      ];
    } else {
      messages = [{ role: "user", content: body.message || "" }];
    }

    const headers: any = {
      "Content-Type": "application/json",
    };

    if (userApiKey && userApiKey.trim()) {
      headers["Authorization"] = `Bearer ${userApiKey}`;
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        model: model || "gpt-4o",
        messages: messages,
        stream: false,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Custom API/OpenAI error: ${errText}`);
    }

    const json: any = await response.json();
    const content = json.choices?.[0]?.message?.content || "";
    const message = url.endsWith("/suggest")
      ? content.replace(/\r/g, "").split("\n")[0].trim() || ""
      : content;

    return {
      ok: true,
      status: 200,
      json: async () => ({ message }),
      text: async () => JSON.stringify({ message }),
    } as any;
  }

  return fetch(url, options);
}

import logger from "vico-logger";
import { DiffManager } from "./DiffManager";
import {
  buildDiffFingerprint,
  cleanSearchReplaceText,
  applySearchReplaceWithFallback,
  markAndCheckRecentDiff,
  debounce,
  stripPrefix,
  collapseAdjacentDuplicateJsxInvocations,
  normalizeInlineSuggestion,
  deriveStyleHints,
  removeCommentTags,
} from "./utils";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

let lastSuggestion: string | null = null;
let lastLinePrefix: string | null = null;

// Tracking variables for better context
let lastClipboardText = "";
let recentCodingHistory: { file: string; line: number; text: string }[] = [];
const MAX_HISTORY = 5;

function updateHistory(file: string, line: number, text: string) {
  if (!text.trim()) return;
  const entry = { file, line, text: text.trim() };
  // Avoid duplicate consecutive entries
  if (recentCodingHistory.length > 0 && recentCodingHistory[0].text === entry.text) return;
  recentCodingHistory.unshift(entry);
  if (recentCodingHistory.length > MAX_HISTORY) {
    recentCodingHistory.pop();
  }
}

let requestId = 0;
let currentAbortController: AbortController | null = null;
let lastRequestLine: number | null = null;
let lastRequestPrefix: string | null = null;

let lastTypedAt = Date.now();
let lastWasNewLine = false;

async function fetchSuggestions(
  context: vscode.ExtensionContext,
  editor: vscode.TextEditor,
) {

  currentAbortController?.abort();
  const controller = new AbortController();
  currentAbortController = controller;

  const currentRequest = ++requestId;

  const cursorLine = editor.selection.active.line;

  // 👉 Source line (if empty, take the line above)
  let sourceLine = cursorLine;
  let lineText = editor.document.lineAt(cursorLine).text;

  if (!lineText.trim() && cursorLine > 0) {
    sourceLine = cursorLine - 1;
    lineText = editor.document.lineAt(sourceLine).text;
  }

  if (!lineText.trim()) return;

  const cleanedInput = removeCommentTags(lineText.trim());
  if (cleanedInput.length < 3 && cursorLine === sourceLine) return;

  // 👉 Inline appears at cursor position (could be empty line)
  const isNewLine = cursorLine !== sourceLine;
  lastWasNewLine = isNewLine;

  lastRequestLine = cursorLine;
  lastRequestPrefix = isNewLine ? "" : cleanedInput;
  lastLinePrefix = lineText;

  const model = context.globalState.get<string>("vico.selectedModel") || "gpt-5.1-codex-mini";
  const provider = context.globalState.get<string>("vico.selectedProvider") || "openai";
  const userApiKey = (await context.secrets.get("vico.userOpenAIApiKey")) || "";
  const customApiUrl = context.globalState.get<string>("vico.customApiUrl") || "";

  const token = context.globalState.get("token");
  const isCustomProvider =
    provider === "ollama" ||
    (userApiKey && userApiKey.trim().length > 0) ||
    (customApiUrl && customApiUrl.trim().length > 0);

  if (!token && !isCustomProvider) {
    vscode.window.showErrorMessage(
      "Vibe Coding token is missing. Please log in first.",
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

  const styleHints = deriveStyleHints(
    editor.document.getText(),
    editor.document.lineCount,
    lang,
  );
  const extraHeuristics =
    lang === "python"
      ? "Avoid inserting closing parentheses, colons, or next-line indentation."
      : lang === "javascript" || lang === "typescript"
        ? "Match the file's quote and semicolon style."
        : lang === "html"
          ? "For HTML/XML contexts: produce a complete, syntactically valid element or a closing tag when appropriate. Never output a bare attribute. When starting a new line, begin with '<' or '</'."
          : "";

  // Clipboard context
  try {
    const clip = await vscode.env.clipboard.readText();
    if (clip && clip.trim().length > 0 && clip.length < 500) {
      lastClipboardText = clip.trim();
    }
  } catch (e) {
    // ignore clipboard read errors
  }

  // Activity context string
  let activityContext = "";
  if (recentCodingHistory.length > 0) {
    activityContext = "Recent coding activity:\n" +
      recentCodingHistory.map(h => `- ${h.file}:${h.line + 1}: ${h.text}`).join("\n") + "\n\n";
  }
  if (lastClipboardText) {
    activityContext += `User recently copied this text: "${lastClipboardText}"\n\n`;
  }

  const body = {
    userId: "vscode-user",
    sessionId: context.globalState.get("currentSessionId"),
    model: model,
    message:
      `File: ${file}\n` +
      `Language: ${lang}\n` +
      `Follow ${lang} best practices and syntax.\n` +
      (styleHints ? `Coding style hints: ${styleHints}\n` : "") +
      (extraHeuristics ? `${extraHeuristics}\n` : "") +
      (activityContext ? activityContext : "") +
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

  // 👉 save cursor position when request is sent
  const requestLine = cursorLine;

  try {
    const response = await fetchAi(
      "http://localhost:13100/api/suggest",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      model,
      provider,
      userApiKey,
      context,
    );

    if (!response.ok) {
      const errorMessage = await response.text();
      throw new Error(`Error ${response.status}: ${errorMessage}`);
    }

    if (currentRequest !== requestId) return; // ❌ skip old response

    const suggestions: any = await response.json();

    // ❌ If user moves line, skip
    if (editor.selection.active.line !== requestLine) return;

    // Special filter for HTML to avoid suggesting single attribute on new line
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


/**
 * Fallback parsing for imperfect writeFile formats
 * Handles cases:
 * - [writeFile] without [/writeFile]
 * - [file] without [writeFile] wrapper
 * - Markdown code blocks inside content
 * - Inconsistent attribute formats
 */
function parseWriteFileFallback(content: string): { success: boolean; content: string; reason?: string } {
  logger.info(`[writeFile] Fallback parsing started, content length: ${content.length}`);

  // Try various parsing strategies

  // Strategy 1: Look for [writeFile]... (with or without closing tag)
  const writeFileOpenMatch = content.match(/\[(?:writeFile|writeFileVico)[^\]]*\]/i);
  if (writeFileOpenMatch) {
    logger.info(`[writeFile] Found [writeFile] tag, extracting content using robust regex`);
    // Extract content within [writeFile] blocks, stopping at the next [writeFile] tag or end of string
    const allMatches = content.matchAll(
      /\[(?:writeFile|writeFileVico)[^\]]*\]([\s\S]*?)(?:\[\/(?:writeFile|writeFileVico)\s*\]|(?=\[(?:writeFile|writeFileVico))|$)/gi,
    );
    let accumulatedContent = "";
    for (const match of allMatches) {
      accumulatedContent += match[1] + "\n";
    }
    if (accumulatedContent.trim()) {
      return { success: true, content: accumulatedContent };
    }
  }

  // Strategy 2: Look directly for [file] or [diff] blocks without [writeFile] wrapper
  const hasFileBlocks = /\[file\s+/i.test(content);
  const hasDiffBlocks = /\[diff\s+/i.test(content);

  if (hasFileBlocks || hasDiffBlocks) {
    logger.info(`[writeFile] Found [file] or [diff] blocks without [writeFile] wrapper`);
    return { success: true, content };
  }

  // Strategy 3: Try to extract markdown code blocks that might contain file content
  // More flexible: allow newline or not after triple backticks
  const codeBlockMatches = content.matchAll(/```(?:[\w-]*\s*)?([\s\S]*?)```/g);
  let accumulatedCodeBlocks = "";
  for (const match of codeBlockMatches) {
    accumulatedCodeBlocks += match[1] + "\n";
  }
  if (accumulatedCodeBlocks.trim()) {
    logger.info(`[writeFile] Found markdown code block(s), using as fallback`);
    return { success: true, content: accumulatedCodeBlocks };
  }

  // Strategy 4: If content looks like file content (has extension or path-like)
  const looksLikeFileContent = /\w+\.\w+/.test(content) || /[\/\\]/.test(content);
  if (looksLikeFileContent && content.length > 10) {
    logger.info(`[writeFile] Content looks like file content, using as fallback`);
    return { success: true, content };
  }

  logger.warn(`[writeFile] Fallback parsing failed - no recognizable format found`);
  return { success: false, content: "", reason: "No recognizable writeFile format found" };
}

async function writeFileVico(
  context: vscode.ExtensionContext,
  editor: vscode.TextEditor | undefined,
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
  const hasProjectFiles =
    (
      await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,.git,dist,build,out,coverage,.vscode,.idea,tmp,temp,venv,__pycache__,.vico}/**",
        1,
      )
    ).length > 0;
  const canWriteMetaFiles = hasDependencyFile || hasProjectFiles;
  logger.info(
    `[writeFile] Meta write gate: dependency=${hasDependencyFile}, projectFiles=${hasProjectFiles}, canWriteMeta=${canWriteMetaFiles}`,
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

    const hasPathSeparator =
      cleanPath.includes("/") || cleanPath.includes("\\");
    const excludePattern =
      "**/{node_modules,.git,dist,build,out,coverage,.vscode,.idea,tmp,temp,venv,__pycache__,.vico}/**";

    if (!hasPathSeparator) {
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

    const baseName = path.basename(cleanPath);
    if (baseName) {
      const matches = await vscode.workspace.findFiles(
        `**/${baseName}`,
        excludePattern,
        20,
      );
      if (matches.length > 0) {
        const sorted = matches
          .map((u) => vscode.workspace.asRelativePath(u).replace(/\\/g, "/"))
          .sort((a, b) => a.length - b.length);
        const resolvedRelative = sorted[0];
        logger.info(
          `[writeFile] Fallback resolve "${rawRelativePath}" -> "${resolvedRelative}"`,
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
    logger.info(`[writeFile] Starting parsing, content length: ${writeContent.length}`);
    logger.debug(`[writeFile] Full content: ${writeContent.substring(0, 500)}${writeContent.length > 500 ? '...' : ''}`);

    // 1. Extract block [writeFile]...[/writeFile]
    // Supports both single block or multiple blocks if the AI outputs them sequentially
    const blockRegex =
      /\[(?:writeFile|writeFileVico)\s*\]([\s\S]*?)\[\/(?:writeFile|writeFileVico)\s*\]/gi;
    let match;
    let contentToProcess = "";

    // Accumulate all content within [writeFile] tags
    while ((match = blockRegex.exec(writeContent)) !== null) {
      contentToProcess += match[1] + "\n";
    }

    logger.info(`[writeFile] Extracted content length: ${contentToProcess.length}`);

    if (!contentToProcess.trim()) {
      logger.warn(`[writeFile] No content extracted with proper tags, trying fallback parsing`);

      // Use the fallback parsing function we created
      const fallbackResult = parseWriteFileFallback(writeContent);

      if (fallbackResult.success) {
        contentToProcess = fallbackResult.content;
        logger.info(`[writeFile] Fallback parsing successful, content length: ${contentToProcess.length}`);
      } else {
        logger.error(`[writeFile] All parsing attempts failed: ${fallbackResult.reason}`);
        vscode.window.showErrorMessage(
          `Failed to parse writeFile content: ${fallbackResult.reason}. Please check the agent response format.`
        );
        return;
      }
    } else {
      logger.info(`[writeFile] Successfully extracted content with proper tags`);
    }

    logger.info(`[writeFile] Starting file/diff parsing, content length: ${contentToProcess.length}`);

    // 2. Parse [file name="path"]...[/file] OR [diff name="path"]...[/diff]
    // Improved regex to handle newlines and various attributes robustly, and allow missing closing tags
    // Stop at the next [file], [diff], or [writeFile] tag (opening or closing)
    const fileRegex = /\[file\s+(?:name|path)=["']?([^"'\s\]]+)["']?(?:\s+type=["'][^"']+["'])?\]([\s\S]*?)(?:\[\s*\/file\s*\]|(?=\[\/?(?:file|diff|writeFile|writeFileVico))|$)/gi;
    const diffRegex = /\[diff\s+(?:name|path)=["']?([^"'\s\]]+)["']?\]([\s\S]*?)(?:\[\s*\/diff\s*\]|(?=\[\/?(?:file|diff|writeFile|writeFileVico))|$)/gi;
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
      let fileContent = cleanSearchReplaceText(fileMatch[2].trim(), true);
      const normalizedRelative = relativePath.replace(/\\/g, "/");
      const isVicoMetaTarget =
        normalizedRelative.startsWith(".vico/") ||
        normalizedRelative === "memory.md";

      logger.info(`[writeFile] Processing [file] block: ${relativePath}`);
      logger.debug(`[writeFile] Raw content length: ${fileContent.length}`);

      if (isVicoMetaTarget && !canWriteMetaFiles) {
        blockedMetaWrites++;
        logger.warn(
          `Blocked pre-scaffold metadata write: ${relativePath}. Scaffold first.`,
        );
        continue;
      }

      // STRIP MARKDOWN CODE BLOCKS FROM CONTENT
      // Often agents wrap the content in ```typescript ... ```
      // IMPROVED: Use a more robust check that handles any language identifier and whitespace
      // and strip it even if there is trailing text outside the block
      const markdownCodeBlockRegex = /```[\w-]*\s*\n?([\s\S]*?)```/g;
      const markdownMatch = markdownCodeBlockRegex.exec(fileContent);
      if (markdownMatch) {
        logger.info(`[writeFile] Stripping markdown code blocks from ${relativePath}`);
        fileContent = markdownMatch[1].trim();
        logger.info(`[writeFile] Markdown stripped, new length: ${fileContent.length}`);
      } else if (fileContent.startsWith("```") && fileContent.endsWith("```")) {
        // Fallback for one-liner or weirdly formatted blocks
        const lines = fileContent.split("\n");
        if (lines.length >= 2) {
          lines.shift();
          lines.pop();
          fileContent = lines.join("\n").trim();
          logger.info(`[writeFile] Markdown (legacy strip) stripped, new length: ${fileContent.length}`);
        }
      }

      const resolvedTarget = await resolveWorkspaceTarget(relativePath);
      const effectiveRelativePath = resolvedTarget.relativePath;
      const fileUri = resolvedTarget.fileUri;
      const dirUri = vscode.Uri.file(path.dirname(fileUri.fsPath));

      // 3. Create directory if it doesn't exist
      try {
        await vscode.workspace.fs.createDirectory(dirUri);
        logger.info(`[writeFile] Created directory: ${dirUri.fsPath}`);
      } catch (error) {
        logger.error(`[writeFile] Failed to create directory ${dirUri.fsPath}: ${error}`);
        vscode.window.showErrorMessage(`Failed to create directory for ${relativePath}: ${error}`);
        continue;
      }

      // Special handling for history.md, lessons.md, architecture.md, and style.md:
      // Append and write directly (no diff) for log files.
      // Overwrite directly for structural/style definition files (architecture.md, style.md) as they are source of truth.
      const isLogFile =
        effectiveRelativePath.toLowerCase().endsWith("history.md") ||
        effectiveRelativePath.toLowerCase().endsWith("lessons.md") ||
        effectiveRelativePath.toLowerCase().endsWith("lesson.md") ||
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
          } catch (e) { }
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
          logger.info(`[writeFile] Successfully wrote ${effectiveRelativePath} (${newContent.length} bytes)`);
          continue; // Skip handleDiff
        } catch (e) {
          logger.error(`[writeFile] Failed to write file ${effectiveRelativePath}:`, e);
          vscode.window.showErrorMessage(`Failed to write file ${effectiveRelativePath}: ${e}`);
          // Continue to next file instead of stopping completely
          continue;
        }
      } else {
        // 4. Handle Diff & Write (only if not a new file write)
        logger.info(`[writeFile] Calling handleDiff for [file]: ${effectiveRelativePath}`);
        const result = await handleDiff(
          fileUri,
          fileContent,
          effectiveRelativePath,
          context,
        );
        if (result && result.success) {
          logger.info(`[writeFile] handleDiff success for [file]: ${effectiveRelativePath}`);
          filesCreated++;
          fileChanges.push({
            filePath: effectiveRelativePath,
            originalContent: result.originalContent,
          });
        } else {
          logger.warn(`[writeFile] handleDiff failed or returned false for [file]: ${effectiveRelativePath}`);
        }
      }
    } // End of while loop for file blocks

    // 2.2 Handle [diff] blocks (Partial targeted diffs)
    const liveContentByPath = new Map<string, string>();
    const originalContentByPath = new Map<string, string>();
    const changedPaths = new Set<string>();

    logger.info(`[writeFile] Starting [diff] block parsing`);

    while ((fileMatch = diffRegex.exec(contentToProcess)) !== null) {
      sawWritableBlocks = true;
      const relativePath = fileMatch[1].trim();
      const diffContent = fileMatch[2].trim();
      const normalizedRelative = relativePath.replace(/\\/g, "/");
      const isVicoMetaTarget =
        normalizedRelative.startsWith(".vico/") ||
        normalizedRelative === "memory.md";

      logger.info(`[writeFile] Processing [diff] block: ${relativePath}`);
      logger.debug(`[writeFile] Diff content length: ${diffContent.length}`);

      if (isVicoMetaTarget && !canWriteMetaFiles) {
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
          logger.info(`[writeFile] Reading existing content for diff: ${effectiveRelativePath}`);
          try {
            const existingBytes = await vscode.workspace.fs.readFile(fileUri);
            const originalContent = Buffer.from(existingBytes).toString("utf8");
            currentContent = originalContent;
            liveContentByPath.set(relativePath, originalContent);
            originalContentByPath.set(relativePath, originalContent);
            logger.info(`[writeFile] Read ${originalContent.length} bytes from ${effectiveRelativePath}`);
          } catch (readError) {
            logger.warn(`[writeFile] File ${effectiveRelativePath} doesn't exist, will create new`);
            currentContent = "";
            liveContentByPath.set(relativePath, "");
            originalContentByPath.set(relativePath, "");
          }
        }

        // Extract SEARCH/REPLACE blocks
        // Delimiters must be on their own lines (using 'm' flag and '^')
        // Using [\r\n]* to allow flexible newline handling between delimiters and content
        // 1. Support for <<<<<<< SEARCH / ======= / >>>>>>> REPLACE
        const searchReplaceRegex =
          /(?:<{3,}|<[ <]{3,})\s*SEARCH\s*[\r\n]*([\s\S]*?)[\r\n]*(?:={3,}|=[ =]{3,})[\r\n]*([\s\S]*?)[\r\n]*(?:>{3,}|>[ >]{3,})(?:\s*REPLACE)?/gi;

        // 2. Support for <replace>old</replace> <with>new</with> or <search>old</search> <replace>new</replace>
        const xmlBlockRegex =
          /<(?:replace|search)>([\s\S]*?)<\/(?:replace|search)>\s*[\r\n]*<(?:with|replace)>([\s\S]*?)<\/(?:with|replace)>/gi;

        // 3. Support for [SEARCH] / [REPLACE] or [SEARCH] / [WITH]
        const squareBracketRegex =
          /\[SEARCH\]\s*[\r\n]*([\s\S]*?)[\r\n]*\[(?:REPLACE|WITH|replace|with)\]\s*[\r\n]*([\s\S]*?)[\r\n]*(?:\[\/REPLACE\]|\[\/WITH\]|\[\/replace\]|\[\/with\])?/gi;

        let srMatch;
        let matchedBlocks = 0;
        let totalBlocks = 0;
        let failedBlocks = 0;
        let lastReplaceText = "";
        let nextContent = currentContent;

        logger.info(`[writeFile] Starting SEARCH/REPLACE parsing for ${relativePath}`);
        logger.debug(`[writeFile] Original content length: ${currentContent.length}`);

        // Helper to process a block
        const processBlock = (searchText: string, replaceText: string) => {
          totalBlocks++;
          const cleanedSearch = cleanSearchReplaceText(searchText, false);
          const cleanedReplace = cleanSearchReplaceText(replaceText, true);
          lastReplaceText = cleanedReplace;

          logger.debug(`[writeFile] Processing block ${totalBlocks}: search length=${cleanedSearch.length}, replace length=${cleanedReplace.length}`);

          const diffFingerprint = buildDiffFingerprint(
            relativePath,
            cleanedSearch,
            cleanedReplace,
          );
          const isDuplicateDiff = markAndCheckRecentDiff(diffFingerprint);
          if (
            isDuplicateDiff &&
            cleanedReplace.trim().length > 0 &&
            nextContent.includes(cleanedReplace.trim())
          ) {
            matchedBlocks++;
            logger.warn(
              `Skipped duplicate diff block for ${relativePath} (fingerprint repeated).`,
            );
            return;
          }
          const applyResult = applySearchReplaceWithFallback(
            nextContent,
            cleanedSearch,
            cleanedReplace,
          );
          if (applyResult.matched) {
            nextContent = applyResult.next;
            matchedBlocks++;
            logger.info(
              `Applied diff block in ${relativePath} using strategy=${applyResult.strategy}`,
            );
          } else {
            failedBlocks++;
            logger.warn(
              `Search text not found in ${relativePath}:\n${cleanedSearch}`,
            );
          }
        };

        // Parse both formats
        searchReplaceRegex.lastIndex = 0;
        while ((srMatch = searchReplaceRegex.exec(diffContent)) !== null) {
          processBlock(srMatch[1], srMatch[2]);
        }

        xmlBlockRegex.lastIndex = 0;
        while ((srMatch = xmlBlockRegex.exec(diffContent)) !== null) {
          processBlock(srMatch[1], srMatch[2]);
        }

        squareBracketRegex.lastIndex = 0;
        while ((srMatch = squareBracketRegex.exec(diffContent)) !== null) {
          processBlock(srMatch[1], srMatch[2]);
        }

        logger.info(`[writeFile] SEARCH/REPLACE parsing completed for ${relativePath}: total=${totalBlocks}, matched=${matchedBlocks}, failed=${failedBlocks}`);

        // Multi-block diffs are treated as transactional to avoid corrupted partial files.
        if (totalBlocks > 1 && failedBlocks > 0) {
          logger.warn(
            `Aborting partial multi-block diff for ${relativePath}: matched=${matchedBlocks}, failed=${failedBlocks}, total=${totalBlocks}.`,
          );
          vscode.window.showWarningMessage(
            `Could not safely apply multi-step diff to ${relativePath} (partial match). Re-run with full file overwrite to avoid corrupted code.`,
          );
          const fallbackContent = diffContent
            .replace(searchReplaceRegex, (_match, _search, replaceText) =>
              cleanSearchReplaceText(replaceText, true),
            )
            .replace(xmlBlockRegex, (_match, _search, replaceText) =>
              cleanSearchReplaceText(replaceText, true),
            )
            .replace(squareBracketRegex, (_match, _search, replaceText) =>
              cleanSearchReplaceText(replaceText, true),
            )
            .trim();
          if (fallbackContent.length > 0) {
            logger.info(
              `Fallback diff for ${relativePath}: rewriting with replace-only content.`,
            );
            const fallbackResult = await handleDiff(
              fileUri,
              fallbackContent,
              effectiveRelativePath,
              context,
            );
            if (fallbackResult && fallbackResult.success) {
              liveContentByPath.set(relativePath, fallbackContent);
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
            }
          }
          continue;
        }

        currentContent = nextContent;

        if (matchedBlocks > 0) {
          if (/\.(tsx|jsx)$/i.test(relativePath)) {
            currentContent =
              collapseAdjacentDuplicateJsxInvocations(currentContent);
          }
          logger.info(`[writeFile] Calling handleDiff for [diff] (matchedBlocks=${matchedBlocks}): ${effectiveRelativePath}`);
          const result = await handleDiff(
            fileUri,
            currentContent,
            effectiveRelativePath,
            context,
          );
          if (result && result.success) {
            logger.info(`[writeFile] handleDiff success for [diff]: ${effectiveRelativePath}`);
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
          } else {
            logger.warn(`[writeFile] handleDiff failed or returned false for [diff]: ${effectiveRelativePath}`);
          }
        } else {
          // If no SEARCH/REPLACE blocks found, but diffContent has content, it might be a full rewrite
          if (totalBlocks === 0 && diffContent.trim().length > 0) {
            lastReplaceText = diffContent.trim();
          }

          // Safety check: if it's a [diff] block but no SEARCH/REPLACE was found, 
          // we should be very careful about full-rewrite fallback.
          // If the new content is much smaller than the original, it's likely a partial snippet.
          const isSnippetLikely =
            currentContent.length > 1000 &&
            lastReplaceText.length < currentContent.length * 0.5 &&
            !lastReplaceText.includes("import ") &&
            !lastReplaceText.includes("export ");

          // If it's explicitly a [diff] block, we should be VERY hesitant to do a full rewrite.
          // Usually, a full rewrite should use [file] instead.
          const canFallbackToFullRewrite =
            totalBlocks === 0 && // Only fallback if NO blocks were found at all
            !isSnippetLikely &&
            lastReplaceText.trim().length > 500 && // Must be significant amount of code
            ((lastReplaceText.trim().length > 200 &&
              /(export\s+default|function\s+\w+|\breturn\s*\()/i.test(
                lastReplaceText,
              )) ||
              (effectiveRelativePath.replace(/\\/g, "/").toLowerCase() ===
                "app/page.tsx" &&
                lastReplaceText.trim().length > 0));

          if (canFallbackToFullRewrite) {
            let rewritten = cleanSearchReplaceText(lastReplaceText, true);
            if (/\.(tsx|jsx)$/i.test(relativePath)) {
              rewritten = collapseAdjacentDuplicateJsxInvocations(rewritten);
            }
            logger.warn(
              `SEARCH not found for ${relativePath}. Using controlled full-rewrite fallback.`,
            );
            logger.info(`[writeFile] Calling handleDiff for [diff] fallback: ${effectiveRelativePath}`);
            const fallbackResult = await handleDiff(
              fileUri,
              rewritten,
              effectiveRelativePath,
              context,
            );
            if (fallbackResult && fallbackResult.success) {
              logger.info(`[writeFile] handleDiff success for [diff] fallback: ${effectiveRelativePath}`);
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
              logger.warn(`[writeFile] handleDiff failed or returned false for [diff] fallback: ${effectiveRelativePath}`);
              vscode.window.showWarningMessage(
                `Could not apply changes to ${relativePath}. SEARCH block not found and fallback rewrite failed.`,
              );
            }
          } else {
            logger.warn(`[writeFile] No SEARCH/REPLACE match found for ${relativePath} and fallback not eligible.`);
            const reason = isSnippetLikely
              ? "New content looks like a partial snippet (too small compared to original)."
              : "SEARCH block not found and content doesn't look like a full file.";

            vscode.window.showErrorMessage(
              `Failed to apply diff to ${relativePath}: ${reason}`,
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
        const fileContent = cleanSearchReplaceText(fileMatch[2].trim(), true);
        const normalizedRelative = relativePath.replace(/\\/g, "/");
        const isVicoMetaTarget =
          normalizedRelative.startsWith(".vico/") ||
          normalizedRelative === "memory.md";
        if (isVicoMetaTarget && !canWriteMetaFiles) {
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

        // Special handling for metadata logs: Append and write directly (no diff)
        const isXmlLogFile =
          effectiveRelativePath.toLowerCase().endsWith("history.md") ||
          effectiveRelativePath.toLowerCase().endsWith("lessons.md") ||
          effectiveRelativePath.toLowerCase().endsWith("lesson.md") ||
          effectiveRelativePath.toLowerCase().endsWith("memory.md");
        if (isXmlLogFile) {
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
            logger.error(`Failed to write metadata log file:`, e);
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

    // Comprehensive summary logging
    logger.info(`[writeFile] Processing completed:`);
    logger.info(`[writeFile] - Files created/modified: ${filesCreated}`);
    logger.info(`[writeFile] - Blocked meta writes: ${blockedMetaWrites}`);
    logger.info(`[writeFile] - Duplicate content skipped: ${duplicateSkipped}`);
    logger.info(`[writeFile] - Saw writable blocks: ${sawWritableBlocks}`);
    logger.info(`[writeFile] - File changes: ${fileChanges.map(f => f.filePath).join(', ')}`);

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
      logger.info(`[writeFile] Success: Created/updated ${filesCreated} files`);
      // Send file changes to webview for history tracking
      if (sidebarProvider) {
        sidebarProvider.postMessage({
          command: "filesModified",
          changes: fileChanges,
        });
      }
    } else if (!duplicateSkipped && !sawWritableBlocks) {
      if (blockedMetaWrites > 0) {
        logger.warn(`[writeFile] Blocked ${blockedMetaWrites} meta writes - project not scaffolded`);
        vscode.window.showWarningMessage(
          "Blocked .vico metadata writes because workspace is still empty. Create main project files first.",
        );
        return;
      }
      // Log content to debug why regex failed
      logger.warn(
        `[writeFile] No file blocks found. Content preview: ${contentToProcess.substring(0, 200)}`
      );
      logger.warn(`[writeFile] Full content length: ${contentToProcess.length}`);
      vscode.window.showWarningMessage(
        'No writable blocks found. Use [file name="path"]...[/file] or [diff name="path"]...[/diff] inside [writeFile].',
      );
    } else if (duplicateSkipped) {
      logger.info(`[writeFile] Duplicate content skipped, no changes made`);
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
  // Register the Sidebar Panel FIRST to avoid Temporal Dead Zone
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

  loadingStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  context.subscriptions.push(loadingStatusBarItem);
  // Register commands here
  let disposable = vscode.commands.registerCommand(
    "vibe-coding.writeFile",
    async () => {
      logger.info("writeFile command triggered");
      await writeFileVico(
        context,
        vscode.window.activeTextEditor,
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

  // Command to clear suggestion after it's selected
  context.subscriptions.push(
    vscode.commands.registerCommand("vibe-coding.clearSuggestion", () => {
      lastSuggestion = null;
    }),
  );
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "vibe-coding" is now active!');

  context.subscriptions.push(
    vscode.commands.registerCommand("vibe-coding.clearCodingHistory", () => {
      recentCodingHistory = [];
      lastClipboardText = "";
      logger.info("[extension] Coding history cleared");
    }),
  );

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
  }, 850);

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || e.document !== editor.document) return;

      const change = e.contentChanges[0];
      if (!change) return;

      // Update history for context
      const lineText = editor.document.lineAt(change.range.start.line).text;
      updateHistory(
        path.basename(editor.document.fileName),
        change.range.start.line,
        lineText,
      );

      lastSuggestion = null;
      vscode.commands.executeCommand("editor.action.inlineSuggest.hide");

      const isNewLine = change.text.includes("\n");
      const isTyping = change.text.length > 0 && !isNewLine;
      const isDeleting = change.text.length === 0 && change.rangeLength > 0;

      if (isDeleting) return; // Don't trigger on backspace

      // Trigger logic: reduce frequency
      let shouldTrigger = false;
      if (isNewLine) {
        shouldTrigger = true;
      } else if (isTyping) {
        const text = change.text;
        const lastChar = text[text.length - 1];
        const trimmedLine = lineText.trim();

        // 1. Trigger on specific completion-friendly characters
        if ([" ", ".", "(", "=", "{", ":", ",", "[", ">"].includes(lastChar)) {
          shouldTrigger = true;
        }
        // 2. Or if the user has typed a meaningful amount on this line
        else if (trimmedLine.length >= 3) {
          // But only if it's not a comment or just symbols
          if (!trimmedLine.startsWith("//") && !trimmedLine.startsWith("#")) {
            shouldTrigger = true;
          }
        }
      }

      if (shouldTrigger) {
        debouncedFetch();
      }

      if (isNewLine) {
        setTimeout(() => {
          vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
        }, 100);
      }
    }),
  );

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
        // Edit to add newline at cursor position
        editor
          .edit((editBuilder) => {
            // Insert newline at cursor position
            editBuilder.insert(editor.selection.active, "\n");
          })
          .then(() => {
            const currentLineText = editor.document.lineAt(currentLine).text;

            // Check if previous line is a comment
            if (/^\s*(\/\/|\/\*|\*|#|<!--)/.test(currentLineText)) {
              console.log("code completion generate..");
              // If previous line is a comment, run triggerCodeCompletion logic
              const allCode = editor.document.getText(); // Get all code from editor
              let coding = currentLineText + "\n"; // Add previous line to coding

              // Call function to clean comment and trigger completion
              const cleanCode = removeCommentTags(coding);
              triggerCodeCompletion(context, cleanCode, allCode);
            }
          });
      }
    }),
  );
}

function onUserInput(line: string) {
  // Save line to history
  console.log(line);
}

async function triggerCodeCompletion(
  context: vscode.ExtensionContext,
  comment: string,
  allCode: string,
) {
  const allCodeData = "```" + allCode + "```";
  // Logic to generate suggestion based on lineContent
  const token = context.globalState.get<string>("token");
  const model = context.globalState.get<string>("vico.selectedModel") || "gpt-5.1-codex-mini";
  const provider = context.globalState.get<string>("vico.selectedProvider") || "openai";
  const userApiKey = (await context.secrets.get("vico.userOpenAIApiKey")) || "";
  const customApiUrl = context.globalState.get<string>("vico.customApiUrl") || "";

  const isCustomProvider =
    provider === "ollama" ||
    (userApiKey && userApiKey.trim().length > 0) ||
    (customApiUrl && customApiUrl.trim().length > 0);

  if (!token && !isCustomProvider) {
    vscode.window.showErrorMessage(
      "Vibe Coding token is missing. Please log in first.",
    );
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const lang = editor.document.languageId;
    const file = path.basename(editor.document.fileName);
    const styleHints = deriveStyleHints(
      editor.document.getText(),
      editor.document.lineCount,
      lang,
    );
    const extraHeuristics =
      lang === "python"
        ? "Avoid inserting closing parentheses, colons, or next-line indentation."
        : lang === "javascript" || lang === "typescript"
          ? "Match the file's quote and semicolon style."
          : "";
    const body = {
      userId: "vscode-user",
      token: token,
      model: model,
      message:
        `File: ${file}\n` +
        `Language: ${lang}\n` +
        (styleHints ? `Coding style hints: ${styleHints}\n` : "") +
        (extraHeuristics ? `${extraHeuristics}\n` : "") +
        `Here is the surrounding code context:\n${allCode}\n\n` +
        `The user is currently typing this line: "${comment}".\n` +
        `Return a SINGLE LINE continuation only. Do NOT add new lines or multiple statements. Do NOT repeat existing text from the line. Do NOT add braces, semicolons, or syntax that already exists later in the file. Return ONLY the continuation text without explanations.`,
    };

    // Create StatusBarItem for loading
    loadingStatusBarItem.text = "🔄 Vibe Coding loading...";
    loadingStatusBarItem.show();

    try {
      const response = await fetchAi(
        "http://localhost:13100/api/suggest",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        model,
        provider,
        userApiKey,
        context,
      );

      // Check if response is successful
      if (!response.ok) {
        const errorMessage = await response.text();
        throw new Error(`Error ${response.status}: ${errorMessage}`);
      }

      // If successful, get data
      const coding: any = await response.json();

      // Add temporary result to editor
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const currentLine = editor.selection.active.line;

        // Display instruction message
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
              // If user selects 'Accept Code'
              editor.edit((editBuilder) => {
                // Remove instruction message if exists
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

                // Insert code completion result
                editBuilder.insert(
                  new vscode.Position(currentLine, 0),
                  `${coding.message}\n`,
                );
              });
            } else if (selection === "Decline") {
              // If user selects 'Decline', do something if needed
              console.log("Code declined.");
            }
          });
      }
    } catch (error) {
      console.error(error);
    } finally {
      // Hide loading StatusBarItem when finished
      loadingStatusBarItem.hide();
    }
  }
}

// implementation here

// This method is called when your extension is deactivated
export function deactivate() { }
