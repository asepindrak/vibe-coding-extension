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
    return false;
  }
}

async function writeFileVico(
  context: vscode.ExtensionContext,
  editor: vscode.TextEditor,
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

    // 2. Parse [file name="path"]...[/file]
    // Improved regex to handle newlines and various attributes robustly
    const fileRegex =
      /\[file\s+name="([^"]+)"(?:\s+type="[^"]+")?\]([\s\S]*?)\[\/file\]/g;
    let fileMatch;
    let filesCreated = 0;

    while ((fileMatch = fileRegex.exec(contentToProcess)) !== null) {
      const relativePath = fileMatch[1].trim();
      const fileContent = fileMatch[2].trim();

      const fileUri = vscode.Uri.joinPath(projectRoot, relativePath);
      const dirUri = vscode.Uri.file(path.dirname(fileUri.fsPath));

      // 3. Create directory if it doesn't exist
      await vscode.workspace.fs.createDirectory(dirUri);

      // 4. Handle Diff & Write
      const success = await handleDiff(
        fileUri,
        fileContent,
        relativePath,
        context,
      );
      if (success) filesCreated++;
    }

    // Fallback: Check for XML-style tags <file path="...">...</file> (sometimes agents use this)
    if (filesCreated === 0) {
      const xmlRegex = /<file\s+path="([^"]+)">([\s\S]*?)<\/file>/g;
      while ((fileMatch = xmlRegex.exec(contentToProcess)) !== null) {
        const relativePath = fileMatch[1].trim();
        const fileContent = fileMatch[2].trim();
        const fileUri = vscode.Uri.joinPath(projectRoot, relativePath);
        const dirUri = vscode.Uri.file(path.dirname(fileUri.fsPath));
        await vscode.workspace.fs.createDirectory(dirUri);
        const success = await handleDiff(
          fileUri,
          fileContent,
          relativePath,
          context,
        );
        if (success) filesCreated++;
      }
    }

    if (filesCreated > 0) {
      vscode.window.showInformationMessage(
        `🎉 Successfully created/updated ${filesCreated} files.`,
      );
    } else {
      // Log content to debug why regex failed
      logger.warn(
        "No file blocks found. Content preview:",
        contentToProcess.substring(0, 200),
      );
      vscode.window.showWarningMessage(
        'No file blocks found to create. Format: [file name="path"]content[/file]',
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
      await writeFileVico(context, vscode.window.activeTextEditor!);
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
    ),
  );

  // Register a command to update the webview with the current file and line information
  context.subscriptions.push(
    vscode.commands.registerCommand("vibe-coding.updateWebview", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const filePath = editor.document.fileName;
        const fileName = path.basename(filePath); // Dapatkan nama file saja
        const selection = editor.selection;
        const startLine = selection.start.line + 1; // Line numbers are 0-based
        const endLine = selection.end.line + 1; // Line numbers are 0-based
        const webview = sidebarProvider._view;
        if (webview) {
          webview.webview.postMessage({
            command: "updateFileInfo",
            filePath: fileName, // Kirim nama file saja
            selectedLine: `${startLine}-${endLine}`, // Kirim rentang baris yang dipilih
          });
        }
      }
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

        for (const file of files) {
          try {
            let cleanPath = file.filePath.trim();
            if (cleanPath.startsWith("/") || cleanPath.startsWith("\\")) {
              cleanPath = cleanPath.substring(1);
            }
            const fullPath = path.join(projectRoot, cleanPath);

            // Ensure directory exists
            const dirPath = path.dirname(fullPath);
            if (!fs.existsSync(dirPath)) {
              fs.mkdirSync(dirPath, { recursive: true });
            }

            fs.writeFileSync(fullPath, file.code);

            // Accept diff in DiffManager
            await diffManager.acceptFile(vscode.Uri.file(fullPath));

            successCount++;
          } catch (e) {
            console.error(`Failed to write ${file.filePath}:`, e);
            failCount++;
          }
        }

        if (successCount > 0) {
          vscode.window.showInformationMessage(
            `Successfully kept ${successCount} files.`,
          );
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
