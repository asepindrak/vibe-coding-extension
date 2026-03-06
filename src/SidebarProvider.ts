import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import * as cp from "child_process";
import { DiffManager } from "./DiffManager";

export class SidebarProvider implements vscode.WebviewViewProvider {
  public _view?: vscode.WebviewView;
  private fileWatcher?: vscode.FileSystemWatcher;
  private isWorkspaceDirty = false;
  private _abortController: AbortController | null = null;
  private listFilesCache = new Map<
    string,
    { files: string[]; at: number; workspaceVersion: number }
  >();
  private readFileCache = new Map<
    string,
    { content: string; mtimeMs: number; at: number }
  >();
  private workspaceVersion = 0;
  private childProcesses: cp.ChildProcess[] = [];
  private activeCommandProcess: cp.ChildProcess | null = null;
  private activeCommandBuffer = "";
  private inputPromptCooldownAt = 0;
  private recentActions: Map<string, number> = new Map();
  private static readonly FREE_PROMPT_LIMIT = 20;
  private static readonly DEFAULT_MODEL = "gpt-5.1-codex-mini";
  private static readonly FREE_MODELS = new Set([
    "gpt-5.1-codex-mini",
    "gpt-4o-mini",
  ]);
  private static readonly USER_API_KEY_SECRET = "vico.userOpenAIApiKey";
  private static readonly MODEL_SETTING_KEY = "vico.selectedModel";
  private static readonly LIST_FILES_CACHE_TTL_MS = 30000;
  private static readonly READ_FILE_CACHE_TTL_MS = 15000;
  private static readonly READ_FILE_CACHE_MAX_ITEMS = 300;
  private static readonly MACHINE_PROMPT_USAGE_KEY_PREFIX =
    "vico.machinePromptUsage";

  private checkDuplicateAction(actionType: string, payload: any): boolean {
    const hash = crypto
      .createHash("md5")
      .update(JSON.stringify({ type: actionType, payload }))
      .digest("hex");
    const now = Date.now();
    const lastTime = this.recentActions.get(hash);

    // 30 seconds cooldown for exact same action to break loops
    if (lastTime && now - lastTime < 30000) {
      return true;
    }

    this.recentActions.set(hash, now);

    // Clean up old entries (> 2 minutes)
    for (const [key, timestamp] of this.recentActions.entries()) {
      if (now - timestamp > 120000) {
        this.recentActions.delete(key);
      }
    }

    return false;
  }

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.setupFileWatcher();
  }

  private setupFileWatcher() {
    // Watch for changes in supported file types
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      "**/*.{js,ts,jsx,tsx,json,py,go,rs,java,c,cpp,h,hpp,css,scss,html,php}",
    );

    const markDirty = () => {
      this.isWorkspaceDirty = true;
      this.workspaceVersion += 1;
      this.listFilesCache.clear();
      if (this._view) {
        this._view.webview.postMessage({
          command: "workspaceDirty",
          isDirty: true,
          workspaceVersion: this.workspaceVersion,
        });
      }
    };

    this.fileWatcher.onDidChange(markDirty);
    this.fileWatcher.onDidCreate(markDirty);
    this.fileWatcher.onDidDelete(markDirty);
  }

  private normalizeCachePath(fullPath: string): string {
    return path.resolve(fullPath).toLowerCase();
  }

  private getCachedReadFile(fullPath: string): string | null {
    try {
      const key = this.normalizeCachePath(fullPath);
      const cached = this.readFileCache.get(key);
      if (!cached) return null;
      if (Date.now() - cached.at > SidebarProvider.READ_FILE_CACHE_TTL_MS) {
        this.readFileCache.delete(key);
        return null;
      }
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs !== cached.mtimeMs) {
        this.readFileCache.delete(key);
        return null;
      }
      return cached.content;
    } catch (_e) {
      return null;
    }
  }

  private setCachedReadFile(fullPath: string, content: string): void {
    try {
      const stat = fs.statSync(fullPath);
      const key = this.normalizeCachePath(fullPath);
      this.readFileCache.set(key, {
        content,
        mtimeMs: stat.mtimeMs,
        at: Date.now(),
      });
      if (this.readFileCache.size > SidebarProvider.READ_FILE_CACHE_MAX_ITEMS) {
        const oldest = this.readFileCache.keys().next().value;
        if (oldest) this.readFileCache.delete(oldest);
      }
    } catch (_e) {}
  }

  private getCachedListFiles(pattern: string): string[] | null {
    const cached = this.listFilesCache.get(pattern);
    if (!cached) return null;
    if (cached.workspaceVersion !== this.workspaceVersion) {
      this.listFilesCache.delete(pattern);
      return null;
    }
    if (Date.now() - cached.at > SidebarProvider.LIST_FILES_CACHE_TTL_MS) {
      this.listFilesCache.delete(pattern);
      return null;
    }
    return cached.files;
  }

  private setCachedListFiles(pattern: string, files: string[]): void {
    this.listFilesCache.set(pattern, {
      files,
      at: Date.now(),
      workspaceVersion: this.workspaceVersion,
    });
  }

  private getGitBashPath(): string | undefined {
    if (os.platform() === "win32") {
      const possiblePaths = [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      ];
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          return p;
        }
      }
    }
    return undefined;
  }

  private isTransientVicoArtifactPath(relativePath: string): boolean {
    const p = (relativePath || "").replace(/\\/g, "/").toLowerCase();
    return /(^|\/)vico_backup_[^/]+/.test(p) || /(^|\/)vico_diff_[^/]+/.test(p);
  }

  private normalizeCommandForNonInteractive(commandText: string): {
    command: string;
    note?: string;
  } {
    let command = commandText.trim();
    if (!command) return { command };

    if (!/\bnpx\s+create-next-app\b/i.test(command)) {
      return { command };
    }

    const addedFlags: string[] = [];
    if (!/\s--yes\b/.test(command)) {
      command += " --yes";
      addedFlags.push("--yes");
    }
    if (!/\s--(ts|typescript|js|javascript)\b/.test(command)) {
      command += " --ts";
      addedFlags.push("--ts");
    }
    if (!/\s--eslint\b/.test(command)) {
      command += " --eslint";
      addedFlags.push("--eslint");
    }
    if (!/\s--tailwind\b/.test(command)) {
      command += " --tailwind";
      addedFlags.push("--tailwind");
    }
    if (!/\s--(app|no-app)\b/.test(command)) {
      command += " --app";
      addedFlags.push("--app");
    }
    if (!/\s--use-(npm|pnpm|yarn|bun)\b/.test(command)) {
      command += " --use-npm";
      addedFlags.push("--use-npm");
    }

    const note =
      addedFlags.length > 0
        ? `Normalized interactive scaffold command with flags: ${addedFlags.join(" ")}`
        : undefined;
    return { command, note };
  }

  private isLikelyInteractivePrompt(buffer: string): boolean {
    const text = buffer.toLowerCase();
    return (
      /would you like/.test(text) ||
      /use arrow-keys/.test(text) ||
      /select an option/.test(text) ||
      /press enter to continue/.test(text) ||
      /\?\s*$/.test(text.trim())
    );
  }

  private isPersistentServerCommand(commandText: string): boolean {
    const cmd = commandText.trim().toLowerCase();
    return (
      /^(npm|pnpm|yarn|bun)\s+run\s+(dev|start)\b/.test(cmd) ||
      /^(npm|pnpm|yarn|bun)\s+(dev|start)\b/.test(cmd) ||
      /^(next|vite|nuxt|ng)\s+dev\b/.test(cmd) ||
      /^(flask|uvicorn)\b/.test(cmd) ||
      /^python\s+manage\.py\s+runserver\b/.test(cmd) ||
      /^rails\s+s\b/.test(cmd) ||
      /^php\s+artisan\s+serve\b/.test(cmd)
    );
  }

  private workspaceHasDependencyFile(workspaceFolder: string): boolean {
    const markers = [
      "package.json",
      "requirements.txt",
      "pyproject.toml",
      "go.mod",
      "Cargo.toml",
      "pom.xml",
      "build.gradle",
      "composer.json",
    ];
    return markers.some((file) =>
      fs.existsSync(path.join(workspaceFolder, file)),
    );
  }

  private requiresProjectContext(commandText: string): boolean {
    const cmd = commandText.trim().toLowerCase();
    if (/^(npm|pnpm|yarn|bun)\s+(init|create)\b/.test(cmd)) return false;
    if (/^npx\s+create-[\w-]+(\s|$)/.test(cmd)) return false;
    if (/^npx\s+degit(\s|$)/.test(cmd)) return false;
    return (
      /^(npm|pnpm|yarn|bun)\s+(install|i|run|test|t|exec|add)\b/.test(cmd) ||
      /^(npm|pnpm|yarn|bun)\s+run\s+\w+/.test(cmd)
    );
  }

  private sendLog(message: string) {
    console.log(message);
    if (this._view) {
      this._view.webview.postMessage({
        command: "systemLog",
        message: message,
      });
    }
  }

  private normalizeModel(model: string | undefined): string {
    const clean = String(model || "").trim();
    return clean || SidebarProvider.DEFAULT_MODEL;
  }

  private getMachinePromptUsage(): number {
    const usageKey = `${SidebarProvider.MACHINE_PROMPT_USAGE_KEY_PREFIX}:${vscode.env.machineId}`;
    const raw = this.context.globalState.get<number>(usageKey, 0);
    return Number.isFinite(raw) ? Number(raw) : 0;
  }

  private async setMachinePromptUsage(count: number): Promise<void> {
    const usageKey = `${SidebarProvider.MACHINE_PROMPT_USAGE_KEY_PREFIX}:${vscode.env.machineId}`;
    await this.context.globalState.update(
      usageKey,
      Math.max(0, Math.floor(count)),
    );
  }

  public postMessage(message: any) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    // Initial check: if we reloaded, assume dirty or let frontend check
    // But we can also send current status
    setTimeout(() => {
      webviewView.webview.postMessage({
        command: "workspaceDirty",
        isDirty: this.isWorkspaceDirty,
        workspaceVersion: this.workspaceVersion,
      });
    }, 1000);

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    const selectedText = webviewView.webview.onDidReceiveMessage(
      async (message) => {
        if (message.command === "getSelectedText") {
          console.log("get selected text");
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            const allCode = editor.document.getText();
            const selection = editor.selection;
            const text = editor.document.getText(selection);
            // Kirim ke webview
            webviewView.webview.postMessage({
              command: "selectedTextResponse",
              text,
              allCode,
            });
          } else {
            // Kirim ke webview
            webviewView.webview.postMessage({
              command: "selectedTextResponse",
              text: "",
            });
          }
        } else if (message.command === "applyCodeSelection") {
          try {
            let document;
            let selection;
            let editor = vscode.window.activeTextEditor;

            if (message.filePath) {
              // Jika ada filePath, cari file tersebut di workspace
              const workspaceFolders = vscode.workspace.workspaceFolders;
              if (workspaceFolders) {
                const rootPath = workspaceFolders[0].uri.fsPath;
                // Bersihkan path
                let cleanPath = message.filePath.trim();
                if (cleanPath.startsWith("/") || cleanPath.startsWith("\\")) {
                  cleanPath = cleanPath.substring(1);
                }
                const fullPath = path.join(rootPath, cleanPath);

                if (fs.existsSync(fullPath)) {
                  // Buka dokumen jika file ada
                  document = await vscode.workspace.openTextDocument(fullPath);
                  // Kita tidak punya selection spesifik, jadi anggap seluruh file atau perlu diff seluruh file
                  // Untuk diff view, kita akan replace seluruh konten jika tidak ada selection spesifik?
                  // Tapi user mungkin ingin apply ke bagian tertentu.
                  // Karena ini agent mode, asumsi kita replace/modify sesuai instruksi.
                  // Mari kita gunakan seluruh teks dokumen sebagai originalText.
                } else {
                  vscode.window.showErrorMessage(
                    `File not found: ${message.filePath}`,
                  );
                  return;
                }
              }
            }

            // Fallback ke active editor jika tidak ada filePath atau gagal load
            if (!document && editor) {
              document = editor.document;
              selection = editor.selection;
            }

            if (document) {
              const originalText = document.getText();
              let newText = message.code;

              if (!message.filePath && selection && !selection.isEmpty) {
                // Case: User select text in editor, click apply (Chat Mode)
                const startOffset = document.offsetAt(selection.start);
                const endOffset = document.offsetAt(selection.end);
                newText =
                  originalText.substring(0, startOffset) +
                  message.code +
                  originalText.substring(endOffset);
              }

              // Use DiffManager
              const diffManager = DiffManager.getInstance(this.context);
              const result: any = await diffManager.openDiff(
                document.uri,
                newText,
              );

              if (result && result.success) {
                // Notify webview about the change so it can track it
                const relativePath = vscode.workspace.asRelativePath(
                  document.uri,
                );
                this.postMessage({
                  command: "filesModified",
                  changes: [
                    {
                      filePath: relativePath,
                      originalContent: result.originalContent,
                    },
                  ],
                });
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
        } else if (message.command === "updateFileInfo") {
          this.updateFileInfo(message.filePath, message.selectedLine);
        } else if (message.command === "keepAllModifiedFiles") {
          vscode.commands.executeCommand(
            "vibe-coding.keepAllModifiedFiles",
            message,
          );
        }
      },
    );

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      async (message) => {
        const command = message.type || message.command;
        switch (command) {
          case "saveHistory":
            this.context.globalState.update("chatHistory", message.history);
            return;
          case "saveHistoryItem":
            let currentHistory: any[] = this.context.globalState.get(
              "chatHistory",
              [],
            );
            const newItem = message.item;
            const existingIndex = currentHistory.findIndex(
              (h) => h.id === newItem.id,
            );
            if (existingIndex >= 0) {
              currentHistory[existingIndex] = newItem;
            } else {
              currentHistory.unshift(newItem);
            }
            // Limit history size
            if (currentHistory.length > 50) {
              currentHistory = currentHistory.slice(0, 50);
            }
            this.context.globalState.update("chatHistory", currentHistory);
            return;
          case "currentSessionId":
            this.context.globalState.update("currentSessionId", message.sessionId);
            return;
          case "deleteHistoryItem":
            let historyToDelete: any[] = this.context.globalState.get(
              "chatHistory",
              [],
            );
            historyToDelete = historyToDelete.filter(
              (h) => h.id !== message.id,
            );
            this.context.globalState.update("chatHistory", historyToDelete);
            return;
          case "getHistory":
            const history = this.context.globalState.get("chatHistory", []);
            webviewView.webview.postMessage({
              command: "historyLoad",
              history,
            });
            return;
          case "clearHistory":
            this.context.globalState.update("chatHistory", []);
            webviewView.webview.postMessage({
              command: "historyLoad",
              history: [],
            });
            return;
          case "saveToken":
            // Simpan token di globalState
            this.context.globalState.update("token", message.token);
            return;
          case "getAiSettings": {
            const selectedModel = this.normalizeModel(
              this.context.globalState.get<string>(
                SidebarProvider.MODEL_SETTING_KEY,
                SidebarProvider.DEFAULT_MODEL,
              ),
            );
            const userApiKey =
              (await this.context.secrets.get(
                SidebarProvider.USER_API_KEY_SECRET,
              )) || "";
            const usage = this.getMachinePromptUsage();
            const remaining = Math.max(
              0,
              SidebarProvider.FREE_PROMPT_LIMIT - usage,
            );
            webviewView.webview.postMessage({
              command: "aiSettings",
              selectedModel,
              hasUserApiKey: userApiKey.trim().length > 0,
              freePromptLimit: SidebarProvider.FREE_PROMPT_LIMIT,
              machinePromptUsed: usage,
              machinePromptRemaining: remaining,
            });
            return;
          }
          case "saveAiSettings": {
            const selectedModel = this.normalizeModel(message.model);
            await this.context.globalState.update(
              SidebarProvider.MODEL_SETTING_KEY,
              selectedModel,
            );
            const keepExistingApiKey = !!message.keepExistingApiKey;
            const userApiKey = String(message.userApiKey || "").trim();
            if (userApiKey) {
              await this.context.secrets.store(
                SidebarProvider.USER_API_KEY_SECRET,
                userApiKey,
              );
            } else if (!keepExistingApiKey) {
              await this.context.secrets.delete(
                SidebarProvider.USER_API_KEY_SECRET,
              );
            }
            const savedApiKey =
              (await this.context.secrets.get(
                SidebarProvider.USER_API_KEY_SECRET,
              )) || "";
            const usage = this.getMachinePromptUsage();
            webviewView.webview.postMessage({
              command: "aiSettingsSaved",
              selectedModel,
              hasUserApiKey: savedApiKey.trim().length > 0,
              freePromptLimit: SidebarProvider.FREE_PROMPT_LIMIT,
              machinePromptUsed: usage,
              machinePromptRemaining: Math.max(
                0,
                SidebarProvider.FREE_PROMPT_LIMIT - usage,
              ),
            });
            return;
          }
          case "consumePromptQuota": {
            const requestId = message.requestId || Date.now().toString();
            const mode = String(message.mode || "chat").toLowerCase();
            const selectedModel = this.normalizeModel(
              message.model ||
                this.context.globalState.get<string>(
                  SidebarProvider.MODEL_SETTING_KEY,
                  SidebarProvider.DEFAULT_MODEL,
                ),
            );
            const userApiKey =
              (await this.context.secrets.get(
                SidebarProvider.USER_API_KEY_SECRET,
              )) || "";
            const hasUserApiKey = userApiKey.trim().length > 0;

            let usage = this.getMachinePromptUsage();
            let allowed = true;
            let reason = "";

            const isCountedMode = mode === "agent" || mode === "chat";
            if (isCountedMode && !hasUserApiKey) {
              if (!SidebarProvider.FREE_MODELS.has(selectedModel)) {
                allowed = false;
                reason = `Model ${selectedModel} is not included in free quota. Free quota only supports gpt-5.1-codex-mini and gpt-4o-mini. Please set your own OpenAI API key.`;
              } else if (usage >= SidebarProvider.FREE_PROMPT_LIMIT) {
                allowed = false;
                reason =
                  "Free quota reached (20 prompts per machine). Please set your own OpenAI API key.";
              } else {
                usage += 1;
                await this.setMachinePromptUsage(usage);
              }
            }

            const remaining = Math.max(
              0,
              SidebarProvider.FREE_PROMPT_LIMIT - usage,
            );
            webviewView.webview.postMessage({
              command: "promptQuotaResult",
              requestId,
              allowed,
              reason,
              selectedModel,
              freePromptLimit: SidebarProvider.FREE_PROMPT_LIMIT,
              machinePromptUsed: usage,
              machinePromptRemaining: remaining,
              hasUserApiKey,
              userApiKey: hasUserApiKey ? userApiKey : "",
              machineId: vscode.env.machineId,
            });
            return;
          }
          case "validateToken":
            // Simpan token di globalState
            let workspacePath = "";
            if (vscode.workspace.workspaceFolders) {
              workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            } else {
              let randomNum = Math.floor(Math.random() * 100000);
              workspacePath = randomNum.toString();
            }
            const uniqueInput = `${message.userId}:${workspacePath}`; // Gabungkan userId dengan workspacePath

            console.log("workspacePath: ", uniqueInput);
            const token = crypto
              .createHash("md5")
              .update(uniqueInput)
              .digest("hex");
            if (message.token === token) {
              console.log("Token is valid");
              webviewView.webview.postMessage({
                command: "tokenValid",
                userId: message.userId,
                token,
              });
            } else {
              console.log("Token is invalid");
              webviewView.webview.postMessage({ command: "tokenInvalid" });
            }
            this.context.globalState.update("token", token);
            return;
          case "writeFile":
            this.context.globalState.update(
              "writeContent",
              message.assistantMessage,
            );
            await vscode.commands.executeCommand("vibe-coding.writeFile");
            webviewView.webview.postMessage({ command: "writeFileFinished" });
            return;
          case "findFiles":
            try {
              console.log("Searching for files in the workspace...");
              const files = await this.getAllWorkspaceFiles();
              let workspacePath = "";
              if (vscode.workspace.workspaceFolders) {
                workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
              } else {
                let randomNum = Math.floor(Math.random() * 100000);
                workspacePath = randomNum.toString();
              }
              const uniqueInput = `${message.email}:${workspacePath}`; // Gabungkan userId dengan workspacePath

              console.log("workspacePath: ", uniqueInput);
              console.log("files: ", files);
              const token = crypto
                .createHash("md5")
                .update(uniqueInput)
                .digest("hex");
              console.log("token: ", token);
              this.context.globalState.update("token", token);
              webviewView.webview.postMessage({
                command: "filesFound",
                files,
                token,
              });
            } catch (error: any) {
              console.error("Error finding files:", error);
              webviewView.webview.postMessage({
                command: "error",
                error: error?.message,
              });
            }
            return;
          case "revertChanges":
            vscode.commands.executeCommand("vibe-coding.revertChanges", {
              changes: message.changes,
            });
            return;
          case "copyToClipboard":
            vscode.env.clipboard.writeText(message.text);
            vscode.window.showInformationMessage("Copied to clipboard!");
            return;
          case "updateWorkspaces":
            if (message.silent) {
              const files = await this.getAllWorkspaceFiles();
              this.isWorkspaceDirty = false; // Reset dirty flag after update
              if (this._view)
                this._view.webview.postMessage({
                  command: "workspaceDirty",
                  isDirty: false,
                  workspaceVersion: this.workspaceVersion,
                });

              webviewView.webview.postMessage({
                command: "workspaceCode",
                files,
              });
              return;
            }
            try {
              // Tampilkan prompt kepada pengguna
              const userResponse = await vscode.window.showInformationMessage(
                "This action will train the AI with a sampled subset of the code in your workspace. This process helps the AI understand the context of your code, including its structure and logic. Do you want to proceed? Note: This may include sensitive or private code.",
                { modal: true }, // Modal untuk memastikan pengguna memberikan respons
                "Teach AI Current Code", // Tombol konfirmasi
              );

              if (userResponse === "Teach AI Current Code") {
                // Jika pengguna memilih untuk melanjutkan
                const files = await this.getAllWorkspaceFiles();
                // console.log("files: ", files);
                webviewView.webview.postMessage({
                  command: "workspaceCode",
                  files,
                });
              } else {
                // Jika pengguna membatalkan
                console.log("User canceled the AI training.");
                webviewView.webview.postMessage({
                  command: "workspaceCodeCancel",
                });
              }
            } catch (error: any) {
              console.error("Error getting workspace code:", error);
              webviewView.webview.postMessage({
                command: "error",
                error: error?.message,
              });
            }
            return;
          case "readFile":
            try {
              const workspaceFolders = vscode.workspace.workspaceFolders;
              if (!workspaceFolders) {
                throw new Error("No workspace open");
              }
              const rootPath = workspaceFolders[0].uri.fsPath;
              // Clean path
              let cleanPath = message.filePath.trim();
              cleanPath = cleanPath.replace(/^\.\//, "");
              if (cleanPath.startsWith("/") || cleanPath.startsWith("\\")) {
                cleanPath = cleanPath.substring(1);
              }
              const fullPath = path.join(rootPath, cleanPath);

              if (fs.existsSync(fullPath)) {
                const cached = this.getCachedReadFile(fullPath);
                const content = cached ?? fs.readFileSync(fullPath, "utf8");
                if (cached == null) {
                  this.setCachedReadFile(fullPath, content);
                }
                webviewView.webview.postMessage({
                  command: "readFileResult",
                  content: content,
                  filePath: message.filePath,
                });
              } else {
                // Fallback: resolve bare filename (e.g., "VideoPlayer.tsx")
                const hasPathSeparator =
                  cleanPath.includes("/") || cleanPath.includes("\\");
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
                      .map((u) => vscode.workspace.asRelativePath(u))
                      .sort((a, b) => a.length - b.length);
                    const resolvedRelative = sorted[0];
                    const resolvedFull = path.join(rootPath, resolvedRelative);
                    if (fs.existsSync(resolvedFull)) {
                      const cached = this.getCachedReadFile(resolvedFull);
                      const content =
                        cached ?? fs.readFileSync(resolvedFull, "utf8");
                      if (cached == null) {
                        this.setCachedReadFile(resolvedFull, content);
                      }
                      this.sendLog(
                        `[ReadFile] Resolved "${message.filePath}" -> "${resolvedRelative}"`,
                      );
                      webviewView.webview.postMessage({
                        command: "readFileResult",
                        content,
                        filePath: message.filePath,
                        resolvedPath: resolvedRelative,
                      });
                      return;
                    }
                  }
                }
                webviewView.webview.postMessage({
                  command: "readFileResult",
                  error: `File not found: ${message.filePath}`,
                  filePath: message.filePath,
                });
              }
            } catch (error: any) {
              webviewView.webview.postMessage({
                command: "readFileResult",
                error: error.message,
                filePath: message.filePath,
              });
            }
            return;
          case "search":
            if (this.checkDuplicateAction("search", message.query)) {
              webviewView.webview.postMessage({
                command: "searchResult",
                results:
                  "⚠️ You recently performed this search. Please use the previous results or try a different query to avoid looping.",
              });
              return;
            }
            try {
              if (this._abortController) {
                this._abortController.abort();
              }
              this._abortController = new AbortController();
              const signal = this._abortController.signal;

              const workspaceFolders = vscode.workspace.workspaceFolders;
              if (!workspaceFolders) {
                throw new Error("No workspace open");
              }

              const query = message.query;
              this.sendLog(`[Search] Query received: "${query}"`);
              if (!query || query.length <= 2) {
                webviewView.webview.postMessage({
                  command: "searchResult",
                  results: "Query too short for content search.",
                });
                return;
              }

              const results: string[] = [];

              const excludePattern =
                "**/{node_modules,.git,dist,build,out,coverage,.vscode,.idea,tmp,temp,venv,__pycache__,.vico}/**";

              const codeFilePattern =
                "**/*.{ts,js,tsx,jsx,json,html,css,scss,md,py,java,c,cpp,h,go,rs,php,rb,sh,yaml,yml,xml,sql,graphql,prisma,vue,svelte,astro}";

              this.sendLog(
                `[Search] Finding files... Pattern: ${codeFilePattern}`,
              );

              // Find matching files first
              const matchingFiles = await vscode.workspace.findFiles(
                codeFilePattern,
                excludePattern,
                1000,
              );

              this.sendLog(
                `[Search] Found ${matchingFiles.length} files to scan.`,
              );

              // Search through file contents
              let scannedCount = 0;
              for (const file of matchingFiles) {
                if (signal.aborted || results.length >= 300) {
                  this.sendLog(`[Search] Stopped. Aborted or limit reached.`);
                  break;
                }

                scannedCount++;
                if (scannedCount % 50 === 0) {
                  this.sendLog(
                    `[Search] Scanned ${scannedCount}/${matchingFiles.length} files...`,
                  );
                }

                try {
                  const document =
                    await vscode.workspace.openTextDocument(file);
                  const text = document.getText();
                  const lines = text.split("\n");
                  const regex = new RegExp(query, "i");

                  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                    if (signal.aborted || results.length >= 300) {
                      break;
                    }

                    const line = lines[lineIdx];
                    if (regex.test(line)) {
                      const relativePath =
                        vscode.workspace.asRelativePath(file);
                      const lineNum = lineIdx + 1;
                      const preview = line.trim().substring(0, 200);
                      const resultStr = `${relativePath}:${lineNum}: ${preview}`;

                      if (!results.includes(resultStr)) {
                        results.push(resultStr);
                      }
                    }
                  }
                } catch (e) {
                  // Skip files that can't be read
                  continue;
                }
              }

              this.sendLog(
                `[Search] Completed. Found ${results.length} matches.`,
              );

              const output =
                results.length > 0 ? results.join("\n") : "No matches found.";
              const filteredOutput = output
                .split("\n")
                .filter((line) => !this.isTransientVicoArtifactPath(line))
                .join("\n");

              webviewView.webview.postMessage({
                command: "searchResult",
                results: filteredOutput || "No matches found.",
              });
            } catch (error: any) {
              this.sendLog(`[Search] Error: ${error.message}`);
              webviewView.webview.postMessage({
                command: "searchResult",
                error: error.message,
              });
            }
            return;
          case "listFiles":
            try {
              const workspaceFolders = vscode.workspace.workspaceFolders;
              if (!workspaceFolders) {
                throw new Error("No workspace open");
              }
              // Standard exclude pattern to avoid clutter
              const excludePattern =
                "**/{node_modules,.git,dist,build,out,coverage,.vscode,.idea,tmp,temp,venv,__pycache__,.vico}/**";
              let pattern = message.pattern || "**/*";

              this.sendLog(`[ListFiles] Request pattern: "${pattern}"`);

              // Smart pattern: if it looks like a simple filename search (no path separators), make it recursive
              if (
                !pattern.includes("/") &&
                !pattern.includes("\\") &&
                !pattern.startsWith("**")
              ) {
                pattern = `**/${pattern}`;
              }

              const cached = this.getCachedListFiles(pattern);
              if (cached) {
                this.sendLog(
                  `[ListFiles] Cache hit for pattern "${pattern}" (${cached.length} files).`,
                );
                webviewView.webview.postMessage({
                  command: "listFilesResult",
                  files: cached,
                });
                return;
              }

              if (this.checkDuplicateAction("listFiles", pattern)) {
                webviewView.webview.postMessage({
                  command: "listFilesResult",
                  error:
                    "You recently listed these files. Please use the previous results to avoid looping.",
                });
                return;
              }

              this.sendLog(`[ListFiles] Searching with pattern: "${pattern}"`);

              // Use CancellationTokenSource for timeout (15s)
              const cts = new vscode.CancellationTokenSource();
              const timeout = setTimeout(() => {
                cts.cancel();
              }, 15000);

              const files = await vscode.workspace.findFiles(
                pattern,
                excludePattern,
                5000, // Limit to 5000 files
                cts.token,
              );
              clearTimeout(timeout);
              cts.dispose();

              this.sendLog(`[ListFiles] Found ${files.length} files.`);

              const filePaths = files.map((file) =>
                vscode.workspace.asRelativePath(file),
              );
              const filteredFilePaths = filePaths.filter(
                (p) => !this.isTransientVicoArtifactPath(p),
              );
              filteredFilePaths.sort();
              this.setCachedListFiles(pattern, filteredFilePaths);

              webviewView.webview.postMessage({
                command: "listFilesResult",
                files: filteredFilePaths,
              });
            } catch (error: any) {
              // Handle cancellation specifically?
              if (error.name === "Canceled" || error.message === "Canceled") {
                this.sendLog(`[ListFiles] Cancelled (Timeout).`);
                webviewView.webview.postMessage({
                  command: "listFilesResult",
                  error:
                    "Search timed out (15s limit). Please refine your search.",
                });
              } else {
                this.sendLog(`[ListFiles] Error: ${error.message}`);
                webviewView.webview.postMessage({
                  command: "listFilesResult",
                  error: error.message,
                });
              }
            }
            return;
          case "abort":
          case "stopCommand":
            // Abort any running search
            if (this._abortController) {
              this._abortController.abort();
              this._abortController = null;
              this.sendLog("[System] Search aborted.");
            }

            try {
              const executions = vscode.tasks.taskExecutions;
              let stoppedCount = 0;
              for (const execution of executions) {
                if (execution.task.source === "vico-agent") {
                  execution.terminate();
                  stoppedCount++;
                }
              }

              // Also stop child processes
              for (const child of this.childProcesses) {
                try {
                  child.kill();
                  stoppedCount++;
                } catch (e) {
                  // ignore
                }
              }
              this.childProcesses = [];
              this.activeCommandProcess = null;
              this.activeCommandBuffer = "";

              if (stoppedCount > 0) {
                this.sendLog(`[System] Stopped ${stoppedCount} running tasks.`);
              }

              webviewView.webview.postMessage({
                command: "commandStopped",
                count: stoppedCount,
              });
            } catch (e: any) {
              console.error("Error stopping command:", e);
            }
            return;
          case "commandInput":
            try {
              const rawInput =
                typeof message.input === "string" ? message.input : "";
              const input = rawInput.endsWith("\n")
                ? rawInput
                : `${rawInput}\n`;
              if (
                this.activeCommandProcess &&
                !this.activeCommandProcess.killed &&
                this.activeCommandProcess.stdin
              ) {
                this.activeCommandProcess.stdin.write(input);
                webviewView.webview.postMessage({
                  command: "commandOutput",
                  output: `\n[Sent Input] ${rawInput}\n`,
                });
              } else {
                webviewView.webview.postMessage({
                  command: "commandOutput",
                  output:
                    "\n[Input ignored] No active interactive command process.\n",
                });
              }
            } catch (err: any) {
              webviewView.webview.postMessage({
                command: "commandOutput",
                output: `\n[Input error] ${err?.message || String(err)}\n`,
              });
            }
            return;
          case "executeCommand":
            console.log(
              "--> [SidebarProvider] executeCommand received:",
              message.command,
            );

            // OPTIMIZATION: Handle 'ls -R' specifically to avoid token limits
            // We inject ignore patterns for common heavy folders
            if (/\bls\s+-R\b/.test(message.command)) {
              const excludes = [
                "node_modules",
                ".git",
                ".next",
                "out",
                "dist",
                "build",
                ".vscode",
                "coverage",
                "__pycache__",
                ".vico",
                "android",
                "ios",
                "target",
                "vendor",
                "bin",
                "obj",
              ];
              const ignoreFlags = excludes
                .map((dir) => `--ignore=${dir}`)
                .join(" ");
              message.command = `${message.command} ${ignoreFlags}`;
              this.sendLog(
                `[System] Optimized 'ls -R' with exclusions: ${ignoreFlags}`,
              );
            }

            if (this.checkDuplicateAction("executeCommand", message.command)) {
              webviewView.webview.postMessage({
                command: "commandFinished",
                exitCode: 2,
                output:
                  "⚠️ Duplicate command blocked to prevent looping. Analyze previous output, apply a fix, then run a different command.",
              });
              return;
            }

            const gitBashPath = this.getGitBashPath();
            if (gitBashPath) {
              console.log("Using Git Bash:", gitBashPath);
            }

            // Create the task
            // Use a custom problem matcher or shell execution to capture output better?
            // Unfortunately, VS Code Task API doesn't easily return stdout.
            // WORKAROUND: Use child_process for short commands like 'ls' or 'mkdir'
            // to ensure we capture output for the agent.

            const commandTextRaw = (message.command || "").trim();
            const normalized =
              this.normalizeCommandForNonInteractive(commandTextRaw);
            const commandText = normalized.command;
            if (normalized.note) {
              this.sendLog(`[System] ${normalized.note}`);
              webviewView.webview.postMessage({
                command: "commandOutput",
                output: `\n[Debug] ${normalized.note}\n`,
              });
            }
            const workspaceFolder = vscode.workspace.workspaceFolders
              ? vscode.workspace.workspaceFolders[0].uri.fsPath
              : undefined;
            webviewView.webview.postMessage({
              command: "commandOutput",
              output: `\n[Debug] Dispatch command: ${commandText}\n`,
            });
            if (this.isPersistentServerCommand(commandText)) {
              const msg =
                "Blocked: persistent server command is not allowed for agent verification. Use build/test/lint command instead (e.g., npm run build, npm test, tsc --noEmit).";
              webviewView.webview.postMessage({
                command: "commandOutput",
                output: `\n[Debug] Guard blocked (server command): ${commandText}\n`,
              });
              webviewView.webview.postMessage({
                command: "commandFinished",
                exitCode: 2,
                output: msg,
              });
              return;
            }
            if (
              workspaceFolder &&
              this.requiresProjectContext(commandText) &&
              !this.workspaceHasDependencyFile(workspaceFolder)
            ) {
              const msg =
                "Blocked: workspace has no dependency file yet. Scaffold/init project first (example: npx create-next-app . --yes --ts --eslint --tailwind --app --use-npm).";
              webviewView.webview.postMessage({
                command: "commandOutput",
                output:
                  `\n[Debug] Guard blocked (missing dependency file): ${commandText}\n` +
                  `[Debug] Hint: run scaffold command first.\n`,
              });
              webviewView.webview.postMessage({
                command: "commandFinished",
                exitCode: 2,
                output: msg,
              });
              return;
            }
            if (
              workspaceFolder &&
              /\bnpx\s+create-next-app\b/i.test(commandText) &&
              this.workspaceHasDependencyFile(workspaceFolder)
            ) {
              const msg =
                "Blocked: workspace already has dependency file. Do not scaffold again; continue with implementation/build/test.";
              webviewView.webview.postMessage({
                command: "commandOutput",
                output:
                  `\n[Debug] Guard blocked (already scaffolded): ${commandText}\n` +
                  `[Debug] Hint: skip create-next-app and continue feature implementation.\n`,
              });
              webviewView.webview.postMessage({
                command: "commandFinished",
                exitCode: 3,
                output: msg,
              });
              return;
            }
            const isShortCommand =
              /^(ls|dir|mkdir|cat|type|echo|pwd|find|grep|rm|cp|mv|tree|head|tail)/i.test(
                commandText,
              );
            const isBuildOrTestCommand =
              /^(npm|pnpm|yarn|bun|npx|node|python|pip|pytest|go|cargo|dotnet|mvn|gradle|java|javac|tsc|vite|next|nuxt|ng)\b/i.test(
                commandText,
              );
            const shouldCaptureOutput = isShortCommand || isBuildOrTestCommand;

            if (shouldCaptureOutput) {
              if (workspaceFolder) {
                let childProcess: cp.ChildProcess;
                let combinedOutput = "";
                let finished = false;

                const finishCommand = (exitCode: number, extraOutput = "") => {
                  if (finished) return;
                  finished = true;
                  if (extraOutput) {
                    combinedOutput += extraOutput;
                  }
                  onExit();
                  webviewView.webview.postMessage({
                    command: "commandFinished",
                    exitCode,
                    output: combinedOutput,
                  });
                };

                const streamChunk = (chunk: any) => {
                  const text = chunk ? chunk.toString() : "";
                  if (!text) return;
                  combinedOutput += text;
                  this.activeCommandBuffer = (
                    this.activeCommandBuffer + text
                  ).slice(-4000);
                  const now = Date.now();
                  if (
                    this.isLikelyInteractivePrompt(this.activeCommandBuffer) &&
                    now - this.inputPromptCooldownAt > 3000
                  ) {
                    this.inputPromptCooldownAt = now;
                    webviewView.webview.postMessage({
                      command: "commandNeedsInput",
                      prompt: this.activeCommandBuffer.slice(-1000),
                    });
                  }
                  webviewView.webview.postMessage({
                    command: "commandOutput",
                    output: text,
                  });
                };

                const onExit = () => {
                  if (childProcess) {
                    this.childProcesses = this.childProcesses.filter(
                      (c) => c !== childProcess,
                    );
                    if (this.activeCommandProcess === childProcess) {
                      this.activeCommandProcess = null;
                      this.activeCommandBuffer = "";
                    }
                    console.log(
                      `[SidebarProvider] Child process exited. Total: ${this.childProcesses.length}`,
                    );
                  }
                };

                if (gitBashPath && os.platform() === "win32") {
                  const cmd = commandText.replace(/"/g, '\\"');
                  childProcess = cp.spawn(gitBashPath, ["-c", cmd], {
                    cwd: workspaceFolder,
                  });
                } else {
                  childProcess = cp.spawn(commandText, {
                    cwd: workspaceFolder,
                    shell: true,
                  });
                }

                if (childProcess) {
                  this.activeCommandProcess = childProcess;
                  this.activeCommandBuffer = "";
                  webviewView.webview.postMessage({
                    command: "commandOutput",
                    output: `[Debug] Process started (pid=${childProcess.pid || "n/a"})\n`,
                  });
                  childProcess.stdout?.on("data", streamChunk);
                  childProcess.stderr?.on("data", streamChunk);
                  childProcess.on("error", (err: any) => {
                    finishCommand(-1, err?.message ? `\n${err.message}\n` : "");
                  });
                  childProcess.on("close", (code: number | null) => {
                    finishCommand(typeof code === "number" ? code : 1);
                  });
                  this.childProcesses.push(childProcess);
                  console.log(
                    `[SidebarProvider] Started child process. Total: ${this.childProcesses.length}`,
                  );
                }
                return;
              }
            }

            let shellExecution;
            if (gitBashPath) {
              shellExecution = new vscode.ShellExecution(message.command, {
                executable: gitBashPath,
                shellArgs: ["-c"],
              });
            } else {
              shellExecution = new vscode.ShellExecution(message.command);
            }

            const task = new vscode.Task(
              { type: "shell", task: "Vico Command" },
              vscode.TaskScope.Workspace,
              "Vico Agent Command",
              "vico-agent",
              shellExecution,
            );

            // Configure presentation to ensure it's visible
            task.presentationOptions = {
              reveal: vscode.TaskRevealKind.Always,
              echo: true,
              focus: true,
              panel: vscode.TaskPanelKind.Shared,
              showReuseMessage: true,
              clear: false,
            };

            try {
              console.log(
                "--> [SidebarProvider] Attempting to execute task...",
              );
              const execution = await vscode.tasks.executeTask(task);
              console.log(
                "--> [SidebarProvider] Task execution started:",
                execution.task.name,
              );

              // Listen for task end
              const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
                if (e.execution === execution) {
                  console.log(
                    "--> [SidebarProvider] Task process ended. Exit code:",
                    e.exitCode,
                  );
                  disposable.dispose();
                  webviewView.webview.postMessage({
                    command: "commandFinished",
                    exitCode: e.exitCode,
                  });
                }
              });
            } catch (err: any) {
              console.error(
                "--> [SidebarProvider] Task execution FAILED:",
                err,
              );
              webviewView.webview.postMessage({
                command: "commandFinished",
                exitCode: -1,
                error: err.message,
              });
            }
            return;
        }
      },
      undefined,
      this.context.subscriptions,
    );
  }

  private maxTokens = 10000;
  private targetSize = 40000; // sekitar 10k token (1 token ≈ 4 karakter)
  private maxFilesPerFolder = 2;

  async getAllWorkspaceFiles(): Promise<string> {
    try {
      const files = await vscode.workspace.findFiles(
        "**/*",
        "{**/node_modules/**,**/dist/**,**/build/**,**/out/**,**/.git/**,**/.svn/**,**/.hg/**,**/.next/**,**/.nuxt/**,**/.expo/**,**/vendor/**,**/__pycache__/**,**/.pytest_cache/**,**/venv/**,**/.venv/**,**/.idea/**,**/.vscode/**,**/.vs/**,**/coverage/**,**/bin/**,**/obj/**,**/target/**,**/Pods/**,**/env/**,**/.env/**,**/tmp/**,**/temp/**,**/.vico/**,**/.vico,**/*.log,**/*.lock,**/*.zip,**/*.png,**/*.jpg,**/*.jpeg,**/*.gif,**/*.exe,**/*.dll,**/*.bin,**/*.class,**/*.so,**/*.o,**/*.a}",
      );
      const filteredFiles = files.filter(
        (f) =>
          !this.isTransientVicoArtifactPath(vscode.workspace.asRelativePath(f)),
      );

      // Generate a lightweight file tree/list so the agent knows the structure
      // even if file contents are truncated.
      const filePaths = filteredFiles.map((f) =>
        vscode.workspace.asRelativePath(f),
      );
      // Sort for consistent view
      filePaths.sort();

      const structureHeader = "// ===== PROJECT STRUCTURE (Tree View) =====\n";
      // Limit to first 500 files to save tokens, but gives good overview
      const structureContent = filePaths
        .slice(0, 500)
        .map((p) => `// ${p}`)
        .join("\n");
      const structureSection = structureHeader + structureContent + "\n\n";

      const folderBuckets: Record<
        string,
        { path: string; code: string; priority: boolean; config: boolean }[]
      > = {};

      for (const file of filteredFiles) {
        if (!this.isTextFile(file.fsPath)) continue;

        const document = await vscode.workspace.openTextDocument(file);
        const raw = document.getText();
        const priority = this.isPriorityFile(file.fsPath);
        const config = this.isConfigFile(file.fsPath);
        const isMarkdown = file.fsPath.toLowerCase().endsWith(".md");
        const compressed = isMarkdown
          ? raw.trim() // Keep markdown headers and structure intact
          : priority || config
            ? this.stripComments(raw)
            : this.compressCodeSkeleton(raw);

        if (compressed.length === 0) continue;

        const folderName = path.dirname(file.fsPath);
        if (!folderBuckets[folderName]) folderBuckets[folderName] = [];
        folderBuckets[folderName].push({
          path: file.fsPath,
          code: compressed,
          priority,
          config,
        });
      }

      const selectedFiles: {
        path: string;
        code: string;
        priority: boolean;
        config: boolean;
      }[] = [];
      for (const folder of Object.keys(folderBuckets)) {
        const priorityFiles = folderBuckets[folder].filter((f) => f.priority);
        const normalFiles = folderBuckets[folder].filter(
          (f) => !f.priority && !f.config,
        );
        const configFiles = folderBuckets[folder].filter((f) => f.config);

        // urutkan berdasarkan nama file (tidak random)
        priorityFiles.sort((a, b) => a.path.localeCompare(b.path));
        normalFiles.sort((a, b) => a.path.localeCompare(b.path));
        configFiles.sort((a, b) => a.path.localeCompare(b.path));

        // ambil max 3 file prioritas dulu
        priorityFiles
          .slice(0, this.maxFilesPerFolder)
          .forEach((f) => selectedFiles.push(f));

        const remainingSlots =
          this.maxFilesPerFolder -
          Math.min(priorityFiles.length, this.maxFilesPerFolder);
        if (remainingSlots > 0) {
          normalFiles
            .slice(0, remainingSlots)
            .forEach((f) => selectedFiles.push(f));
        }

        // Jika slot masih kosong, baru masukkan config
        const finalSlots =
          this.maxFilesPerFolder -
          selectedFiles.filter((f) => path.dirname(f.path) === folder).length;
        if (finalSlots > 0) {
          configFiles
            .slice(0, finalSlots)
            .forEach((f) => selectedFiles.push(f));
        }
      }

      // Group output berdasarkan folder
      const grouped: Record<
        string,
        { path: string; code: string; priority: boolean; config: boolean }[]
      > = {};
      for (const f of selectedFiles) {
        const folderKey = f.path.includes("/src/")
          ? "src/" + f.path.split("/src/")[1].split("/")[0]
          : "(root)";
        if (!grouped[folderKey]) grouped[folderKey] = [];
        grouped[folderKey].push(f);
      }

      // Gabungkan hasil dengan batas ukuran
      let allCode = structureSection; // Start with the structure!
      let totalSize = allCode.length;
      console.log("=== FILES SELECTED TO SEND ===");

      for (const folder of Object.keys(grouped)) {
        const folderHeader = `\n\n// ===== Folder: ${folder} =====\n`;
        if (totalSize + folderHeader.length <= this.targetSize) {
          allCode += folderHeader;
          totalSize += folderHeader.length;
        } else {
          console.log(`- SKIPPED FOLDER (limit) ${folder}`);
          continue;
        }

        for (const f of grouped[folder]) {
          const snippet = `// File: ${f.path}\n${f.code}\n\n`;
          if (totalSize + snippet.length <= this.targetSize) {
            allCode += snippet;
            totalSize += snippet.length;
            console.log(
              `+ ${f.path} (${f.priority ? "PRIORITY" : f.config ? "CONFIG" : "normal"})`,
            );
          } else {
            console.log(`- SKIPPED (limit) ${f.path}`);
          }
        }
      }

      // Add package.json dependencies to help AI understand the tech stack
      const packageJsonFiles = filteredFiles.filter((f) =>
        f.fsPath.endsWith("package.json"),
      );
      for (const pkgFile of packageJsonFiles) {
        try {
          const doc = await vscode.workspace.openTextDocument(pkgFile);
          const pkgContent = JSON.parse(doc.getText());
          const deps = {
            ...pkgContent.dependencies,
            ...pkgContent.devDependencies,
          };
          const depsString = `\n\n// ===== Dependencies (${path.basename(path.dirname(pkgFile.fsPath))}) =====\n// ${JSON.stringify(deps, null, 2)}\n`;

          if (totalSize + depsString.length <= this.targetSize) {
            allCode += depsString;
            totalSize += depsString.length;
            console.log(`+ Dependencies for ${pkgFile.fsPath}`);
          }
        } catch (e) {
          console.error(`Failed to read package.json: ${pkgFile.fsPath}`);
        }
      }

      console.log("=== END OF FILE LIST ===");
      return allCode;
    } catch (err) {
      console.error("Error reading workspace files:", err);
      return "";
    }
  }

  // --- Hapus komentar, tapi biarkan kode utuh ---
  private stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/^\s*#.*$/gm, "")
      .replace(/^\s*$/gm, "")
      .trim();
  }

  // --- Skeleton code untuk semua bahasa ---
  private compressCodeSkeleton(source: string): string {
    return (
      source
        // Remove comments (C-style, Python, Shell)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/^\s*#.*$/gm, "")

        // IMPORTANT: Keep imports to understand dependencies

        // JavaScript/TypeScript/PHP/Go Functions
        .replace(/(function\s+\w+\s*\(.*?\))\s*\{[\s\S]*?\}/g, "$1 { ... }")
        .replace(
          /(const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{[\s\S]*?\}/g,
          "$1 $2 = (...): ... => { ... };",
        )
        .replace(
          /(export\s+function\s+\w+)\s*\([^)]*\)\s*:\s*JSX\.Element\s*\{[\s\S]*?\}/g,
          "$1(...): JSX.Element { ... }",
        )

        // Python Functions & Classes
        .replace(
          /(def\s+\w+\s*\(.*?\)\s*:)\s*(?:(?:\r\n|\r|\n)(?:\s+.*)?)+/g,
          "$1 ...\n",
        )
        .replace(
          /(class\s+\w+(?:\(.*\))?\s*:)\s*(?:(?:\r\n|\r|\n)(?:\s+.*)?)+/g,
          "$1 ...\n",
        )

        // Java/C#/C++ Methods (approximation)
        .replace(
          /(public|private|protected)\s+(?:static\s+)?(?:[\w<>,\[\]]+\s+)(\w+)\s*\(.*?\)\s*\{[\s\S]*?\}/g,
          "$1 ... $2(...) { ... }",
        )

        // Go Structs & Interfaces
        .replace(
          /(type\s+\w+\s+(?:struct|interface))\s*\{[\s\S]*?\}/g,
          "$1 { ... }",
        )

        // Classes (Generic)
        .replace(/(class\s+\w+)(<.*?>)?\s*\{[\s\S]*?\}/g, "$1$2 { ... }")

        // Types & Interfaces (TS, Java, C#, Go)
        .replace(/(type\s+\w+\s*=\s*)\{[\s\S]*?\}/g, "$1{ /* keys */ }")
        .replace(/(interface\s+\w+\s*)\{[\s\S]*?\}/g, "$1{ /* keys */ }")
        .replace(/(enum\s+\w+\s*)\{[\s\S]*?\}/g, "$1{ /* keys */ }")

        // Compress Schemas (Zod, etc)
        .replace(/(z\.ZodObject<.*?>\s*=\s*)\{[\s\S]*?\}/g, "$1...;")
        .replace(
          /(const\s+\w+Schema\s*=\s*\w+\.object\(.*)\)\s*;/g,
          "$1 ... });",
        )

        // Compress Routes (Express/others)
        .replace(
          /(app\.(get|post|put|delete|patch)\(.*?,\s*)(\(.*?\)\s*=>\s*)?\{[\s\S]*?\}/g,
          "$1$3{ ... }",
        )

        .replace(/^\s*$/gm, "")
        .trim()
    );
  }

  // --- Deteksi file teks ---
  private isTextFile(filePath: string): boolean {
    const exts = [
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".vue",
      ".svelte",
      ".astro",
      ".php",
      ".py",
      ".rb",
      ".go",
      ".rs",
      ".java",
      ".c",
      ".cpp",
      ".cs",
      ".scala",
      ".kt",
      ".html",
      ".css",
      ".scss",
      ".json",
      ".md",
      ".txt",
      ".xml",
      ".yml",
      ".yaml",
      ".ini",
      ".env",
      ".ejs",
      ".hbs",
      ".pug",
      ".njk",
    ];
    const ext = path.extname(filePath).toLowerCase();
    return exts.includes(ext);
  }

  // --- Deteksi file prioritas ---
  private isPriorityFile(filePath: string): boolean {
    return /(model|schema|entity|types?|interfaces?|dto|config|api|routes?|validation|controller|service|store|hook|utils|lib|context|provider|component)/i.test(
      filePath,
    );
  }

  // --- Deteksi file config ---
  private isConfigFile(filePath: string): boolean {
    const configPatterns = [
      "eslint.config",
      "tsconfig",
      "vite.config",
      "webpack.config",
      "postcss.config",
      "tailwind.config",
      "package.json",
      "next.config",
      "nuxt.config",
      ".env.example",
      "docker-compose",
      "Dockerfile",
      "requirements.txt",
      "pyproject.toml",
      "setup.py",
      "go.mod",
      "go.sum",
      "Cargo.toml",
      "Cargo.lock",
      "composer.json",
      "composer.lock",
      "Gemfile",
      "Gemfile.lock",
      "pom.xml",
      "build.gradle",
      "settings.gradle",
      "Makefile",
    ];
    return configPatterns.some((p) => filePath.includes(p));
  }

  private updateFileInfo(filePath: string, selectedLine: number) {
    if (this._view) {
      this._view.webview.postMessage({
        command: "updateFileInfo",
        filePath: filePath,
        selectedLine: selectedLine,
      });
    }
  }

  private _cachedHtml?: string;

  private getHtmlForWebview(webview: vscode.Webview): string {
    if (this._cachedHtml) {
      return this._cachedHtml;
    }
    const htmlPath = path.join(
      this._extensionUri.fsPath,
      "media",
      "webview.html",
    );
    let htmlContent = fs.readFileSync(htmlPath, "utf8");
    const logoPath = webview.asWebviewUri(
      vscode.Uri.file(
        path.join(this._extensionUri.fsPath, "media", "logo.png"),
      ),
    );
    const stylesPath = webview.asWebviewUri(
      vscode.Uri.file(
        path.join(this._extensionUri.fsPath, "media", "styles.css"),
      ),
    );
    const prismPath = webview.asWebviewUri(
      vscode.Uri.file(
        path.join(this._extensionUri.fsPath, "media", "prism.css"),
      ),
    );
    const prismJSPath = webview.asWebviewUri(
      vscode.Uri.file(
        path.join(this._extensionUri.fsPath, "media", "prism.js"),
      ),
    );
    const chara = webview.asWebviewUri(
      vscode.Uri.file(
        path.join(this._extensionUri.fsPath, "media", "Syana Isniya.vrm"),
      ),
    );
    const audio = webview.asWebviewUri(
      vscode.Uri.file(
        path.join(this._extensionUri.fsPath, "media", "welcome.mp3"),
      ),
    );
    const vrm = webview.asWebviewUri(
      vscode.Uri.file(
        path.join(
          this._extensionUri.fsPath,
          "node_modules/@pixiv/three-vrm/lib/",
          "three-vrm.module.js",
        ),
      ),
    );
    const background = webview.asWebviewUri(
      vscode.Uri.file(
        path.join(this._extensionUri.fsPath, "media", "celestia-bg.jpg"),
      ),
    );

    // Replace placeholder with actual logo path htmlContent = htmlContent.replace('%LOGO_PATH%', logoPath.toString());
    htmlContent = htmlContent.replace("%LOGO_PATH%", logoPath.toString());
    htmlContent = htmlContent.replace("%LOGO_NAV_PATH%", logoPath.toString());
    htmlContent = htmlContent.replace("%STYLES_PATH%", stylesPath.toString());
    htmlContent = htmlContent.replace("%PRISM_PATH%", prismPath.toString());
    htmlContent = htmlContent.replace("%PRISMJS_PATH%", prismJSPath.toString());
    console.log(chara.toString());
    htmlContent = htmlContent.replace("%CHARA%", chara.toString());
    htmlContent = htmlContent.replace("%VRM%", vrm.toString());
    htmlContent = htmlContent.replace("%AUDIO%", audio.toString());
    htmlContent = htmlContent.replace("%BACKGROUND%", background.toString());

    this._cachedHtml = htmlContent;
    return htmlContent;
  }
}
