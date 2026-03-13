import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import * as cp from "child_process";
import { DiffManager } from "./DiffManager";
import { cleanSearchReplaceText } from "./utils";

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
  private ollamaAbortControllers: Map<string, AbortController> = new Map();
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
  private static readonly MODEL_PROVIDER_KEY = "vico.selectedProvider";
  private static readonly LIST_FILES_CACHE_TTL_MS = 30000;
  private static readonly READ_FILE_CACHE_TTL_MS = 15000;
  private static readonly READ_FILE_CACHE_MAX_ITEMS = 300;
  private static readonly MACHINE_PROMPT_USAGE_KEY_PREFIX =
    "vico.machinePromptUsage";
  private static readonly API_BASE_URL = "http://localhost:13100/api";

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
    } catch (_e) { }
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
    if (!/\s--app\b/.test(command) && !/\s--no-app\b/.test(command)) {
      command += " --app";
      addedFlags.push("--app");
    }
    if (!/\s--src-dir\b/.test(command)) {
      command += " --src-dir";
      addedFlags.push("--src-dir");
    }
    if (!/\s--import-alias\b/.test(command)) {
      command += ' --import-alias "@/*"';
      addedFlags.push('--import-alias "@/*"');
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

  private async fetchPrompt(name: string): Promise<string> {
    try {
      const response = await fetch(`${SidebarProvider.API_BASE_URL}/prompts/${name}`);
      if (!response.ok) {
        if (response.status === 404) {
          console.warn(`Prompt ${name} not found in backend, using default or empty.`);
          return "";
        }
        throw new Error(`Failed to fetch prompt ${name}: ${response.statusText}`);
      }
      const data: any = await response.json();
      return data.content || "";
    } catch (error) {
      console.error(`Error fetching prompt ${name}:`, error);
      // Return empty string instead of throwing to avoid breaking the flow
      // especially for modes like "analyze" that might not exist in backend yet
      return "";
    }
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
            // Send to webview
            webviewView.webview.postMessage({
              command: "selectedTextResponse",
              text,
              allCode,
            });
          } else {
            // Send to webview
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
              // If filePath exists, look for it in workspace
              const workspaceFolders = vscode.workspace.workspaceFolders;
              if (workspaceFolders) {
                const rootPath = workspaceFolders[0].uri.fsPath;
                // Clean path
                let cleanPath = message.filePath.trim().replace(/\\/g, "/");
                if (cleanPath.startsWith("/")) {
                  cleanPath = cleanPath.substring(1);
                }

                // Path validation logic
                const analysis = await this.analyzeFramework(rootPath);
                if (analysis.pageBasePath && !cleanPath.startsWith(analysis.pageBasePath)) {
                  // Only warn for page-related files (page.tsx, layout.tsx, etc.)
                  const isPageFile = cleanPath.includes("page.tsx") || cleanPath.includes("layout.tsx") || cleanPath.includes("route.ts") || cleanPath.includes("page.jsx") || cleanPath.includes("layout.jsx");
                  const isWrongPagesDir = cleanPath.startsWith("pages/") || cleanPath.startsWith("src/pages/");

                  if (isPageFile && isWrongPagesDir) {
                    const action = await vscode.window.showWarningMessage(
                      `Warning: Agent is trying to write to '${cleanPath}', but the project uses '${analysis.pageBasePath}'. This might create duplicate pages. Proceed?`,
                      "Proceed",
                      "Cancel"
                    );
                    if (action !== "Proceed") return;
                  }
                }

                const fullPath = path.join(rootPath, cleanPath);

                if (fs.existsSync(fullPath)) {
                  // Open document if file exists
                  document = await vscode.workspace.openTextDocument(fullPath);
                } else {
                  vscode.window.showErrorMessage(
                    `File not found: ${message.filePath}`,
                  );
                  return;
                }
              }
            }

            // Fallback to active editor if no filePath or failed to load
            if (!document && editor) {
              document = editor.document;
              selection = editor.selection;
            }

            if (document) {
              const originalText = document.getText();
              let newText = cleanSearchReplaceText(message.code, true);

              if (!message.filePath && selection && !selection.isEmpty) {
                // Case: User select text in editor, click apply (Chat Mode)
                const startOffset = document.offsetAt(selection.start);
                const endOffset = document.offsetAt(selection.end);
                newText =
                  originalText.substring(0, startOffset) +
                  newText +
                  originalText.substring(endOffset);
              } else if (!message.filePath && (!selection || selection.isEmpty)) {
                // Case: No selection, AI might have sent a snippet or full file
                // If the new text is much smaller than original and doesn't look like a full file,
                // it's likely a snippet that the user is trying to apply to the whole file.
                const isSnippetLikely =
                  originalText.length > 1000 &&
                  newText.length < originalText.length * 0.5 &&
                  !newText.includes("import ") &&
                  !newText.includes("export ");

                if (isSnippetLikely) {
                  const action = await vscode.window.showWarningMessage(
                    "The code you are applying looks like a partial snippet but no text is selected. Overwrite the entire file anyway?",
                    "Overwrite",
                    "Cancel"
                  );
                  if (action !== "Overwrite") {
                    return;
                  }
                }
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
          case "abort": {
            const { uniqueId } = message;
            if (uniqueId) {
              const controller = this.ollamaAbortControllers.get(uniqueId);
              if (controller) {
                controller.abort();
                this.ollamaAbortControllers.delete(uniqueId);
                this.sendLog(`[Ollama Agent] Aborted task ${uniqueId}`);
              }
            }
            if (this._abortController) {
              this._abortController.abort();
              this._abortController = null;
            }
            this.childProcesses.forEach((cp) => {
              try {
                cp.kill();
              } catch (e) { }
            });
            this.childProcesses = [];
            return;
          }
          case "ollamaAgent": {
            const { mode, data, uniqueId } = message;
            const ollamaModel = data.model.replace("ollama:", "");
            const customUrl = this.context.globalState.get<string>("vico.customApiUrl");
            const ollamaUrl = (customUrl && customUrl.trim()) || "http://localhost:11434/v1/chat/completions";
            const controller = new AbortController();
            if (uniqueId) {
              this.ollamaAbortControllers.set(uniqueId, controller);
            }

            try {
              // 0. Load / Save Agent State (Redis-like behavior in Extension)
              const sessionId = data.sessionId || this.context.globalState.get<string>("currentSessionId");
              let agentState: any = null;
              if (sessionId) {
                const stateKey = `agentState_${sessionId}`;
                agentState = this.context.globalState.get(stateKey);
                // Merge with incoming state if needed
                if (data.state) {
                  agentState = { ...agentState, ...data.state };
                  await this.context.globalState.update(stateKey, agentState);
                }
              }

              // 1. Load Context & Prompts
              const workspaceFolders = vscode.workspace.workspaceFolders;
              const rootPath = workspaceFolders ? workspaceFolders[0].uri.fsPath : "";
              const analysis = await this.analyzeFramework(rootPath);
              const frameworkInfo = `${analysis.framework} | ${analysis.structure}`;
              const workspaceContext = await this.getAllWorkspaceFiles();

              const isNewProject = rootPath ? !this.workspaceHasDependencyFile(rootPath) : true;
              const isEmptyWorkspace = workspaceContext.includes("(The project is currently empty. No files found.)");

              if (isNewProject || isEmptyWorkspace) {
                // Clear or ignore previous session state if project is empty to avoid confusion
                agentState = null;
                if (data.state) data.state = null;
                if (data.history) data.history = [];
                this.sendLog(`[Ollama Agent] Empty or uninitialized project detected. Starting with fresh context.`);
              }

              const promptPromises = [
                this.fetchPrompt("base"),
                this.fetchPrompt("agent"),
                this.fetchPrompt(mode),
              ];

              if (isNewProject) {
                promptPromises.push(this.fetchPrompt("new-project"));
              }

              const [basePrompt, agentPrompt, modePrompt, newProjectPrompt] = await Promise.all(promptPromises);

              // 2. Build Context
              const verificationMode = this.normalizeVerificationMode(data.verification_mode);
              const verificationModeDirective = this.buildVerificationModeDirective(verificationMode);
              const guardrailsContext = this.buildGuardrailsContext(data.guardrails);
              const historyContext = this.buildHistoryContext(data.history || []);
              const compactContext = this.compressContext(data.context || "");
              const stateContext = this.buildAgentStateContext(agentState || data.state);
              const loopBreakerContext = this.buildLoopBreakerContext(agentState || data.state, data.step?.description);

              const BANNED_FORMATS = `
- NEVER output text like "Open Diff:", "Applying change", "Content:", or any other conversational status.
- NEVER output markdown code fences (\`\`\` or \`\`\`javascript).
- NEVER output "content: FILE_CONTENT" or "FULL_CONTENT_HERE".
- ONLY use the following tags: [writeFile], [file], [diff], [command], [readFile], [searchFiles], [REPLAN].
`;

              // 3. Prepare Messages (Multi-system messages like in agent.js)
              const messages: any[] = [];

              // Base, Agent, and Mode prompts
              if (basePrompt) messages.push({ role: "system", content: basePrompt });
              if (agentPrompt) messages.push({ role: "system", content: agentPrompt });
              if (modePrompt) messages.push({ role: "system", content: modePrompt });
              if (newProjectPrompt) messages.push({ role: "system", content: newProjectPrompt });

              // Critical instructions at the end of system messages
              messages.push({ role: "system", content: `CRITICAL OUTPUT RULES:\n${BANNED_FORMATS}` });

              if (verificationModeDirective) {
                messages.push({ role: "system", content: verificationModeDirective });
              }
              if (guardrailsContext) {
                messages.push({ role: "system", content: guardrailsContext });
              }
              if (stateContext) {
                messages.push({ role: "system", content: stateContext });
              }
              if (loopBreakerContext) {
                messages.push({ role: "system", content: loopBreakerContext });
              }

              // Tech stack handling
              const currentTechStack = {
                ...(data.tech_stack || {}),
                framework: analysis.framework,
                pageBasePath: analysis.pageBasePath,
                structure: analysis.structure
              };

              messages.push({
                role: "system",
                content: `KNOWN TECH STACK (DO NOT RE-ANALYZE UNLESS CHANGED):\n${JSON.stringify(currentTechStack)}`
              });

              if (mode === "execute") {
                const execDirectives = this.buildExecutionDirectives(
                  data.step,
                  data.context || compactContext,
                );
                if (execDirectives) {
                  // Push as system message to ensure visibility for Ollama
                  messages.push({ role: "system", content: execDirectives });
                }
              }

              if (isNewProject || isEmptyWorkspace) {
                messages.push({
                  role: "system",
                  content: `CRITICAL: THE PROJECT IS EMPTY. NO FILES FOUND.
- You MUST start by generating a plan that begins with a scaffold command (e.g., npx create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm).
- Do NOT suggest manual file creation until after the scaffold step is planned.
- DONT TRY TO READ ANY FILES. THE WORKSPACE IS EMPTY.
- IF YOU TRY TO READ FILES (readFile), THE TASK WILL FAIL. THERE ARE NO FILES TO READ.`
                });
              } else {
                const structurePrompt = analysis.pageBasePath
                  ? `- NEXT.JS DETECTED: You MUST use '${analysis.pageBasePath}' for all new pages (e.g., '${analysis.pageBasePath}dashboard/page.tsx').`
                  : "";

                messages.push({
                  role: "system",
                  content: `PROJECT CONTEXT ANALYSIS:
- FRAMEWORK: ${frameworkInfo}
- MANDATORY PAGE PATH: ${analysis.pageBasePath || "Not detected (Follow existing patterns)"}
${structurePrompt}
- CRITICAL: Before creating ANY new file, look at the 'WORKSPACE CONTEXT' (Tree View) below.
- MATCH THE PATTERN: If existing pages are in 'src/app/login/page.tsx', then a new 'register' page MUST be 'src/app/register/page.tsx'.
- NO MIXING: Do NOT mix App Router and Pages Router.
- DIRECTORY CONSISTENCY: If 'src/' exists, all new code MUST go inside 'src/'.
- DUPLICATE PREVENTION: NEVER create folders like 'dashboard/' at root if '${analysis.pageBasePath || "src/app/"}' is the project pattern.`
                });
              }

              if (workspaceContext) {
                messages.push({ role: "system", content: `WORKSPACE CONTEXT:\n${workspaceContext}` });
              }
              if (compactContext) {
                messages.push({ role: "system", content: `ROLLING CONTEXT:\n${compactContext}` });
              }

              // 4. Handle Attachments (Pre-analysis)
              let attachmentSummary = "";
              if (data.attachments && data.attachments.length > 0) {
                this.sendLog(`[Ollama Agent] Analyzing ${data.attachments.length} attachments...`);
                for (const att of data.attachments) {
                  const content = att.content || att.contentDataUrl || "";
                  if (content && (att.type?.startsWith("text/") || att.name?.match(/\.(ts|js|tsx|jsx|json|html|css|md|py|txt)$/i))) {
                    let text = content;
                    if (content.startsWith("data:")) {
                      const m = /^data:(.*?);base64,(.*)$/.exec(content);
                      if (m) text = Buffer.from(m[2], "base64").toString("utf8");
                    }
                    attachmentSummary += `\n\nFILE ATTACHMENT: ${att.name}\nCONTENT:\n${text}\n`;
                  } else {
                    attachmentSummary += `\n\nATTACHMENT: ${att.name} (Non-text or image, skipping deep analysis for Ollama for now)`;
                  }
                }
              }

              // 5. Prepare User Content
              let userContent = "";
              if (mode === "plan") {
                const planDirectives = (isNewProject || isEmptyWorkspace)
                  ? `- CRITICAL: THE PROJECT IS EMPTY. Your plan MUST start with a 'terminal_command' to scaffold the project (e.g., npx create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm).
- Do NOT include any 'file_read' steps in your plan for an empty project. There are no files to read yet.
- DONT TRY TO READ ANY FILES. THE WORKSPACE IS EMPTY.
- IF YOU TRY TO READ FILES (file_read), THE PLAN WILL BE REJECTED.
- After scaffolding, your plan should proceed with 'file_write' steps to implement the requested features.
- Output MUST be a valid JSON plan object with "tech_stack", "risk_level", and "plan" (array of steps) keys.`
                  : `- CRITICAL: Check the 'CODEBASE_ANALYSIS' in ROLLING CONTEXT if available. If it mentions existing files that are relevant, you MUST use them.
- MANDATORY PAGE PATH: Use '${analysis.pageBasePath || "src/app/"}' for ALL new pages. If '${analysis.pageBasePath}' exists, NEVER use 'pages/'.
- CHECK WORKSPACE FIRST: Look at the 'WORKSPACE CONTEXT' file list. If a file or component relevant to the request ALREADY EXISTS (even if the name is not exact), your plan MUST 'file_read' it first. Do NOT propose creating a new file if it already exists.
- REUSE EXISTING LOGIC: If a file like 'SidebarProvider.ts' exists and the user asks for something related to sidebar logic, DO NOT create 'NewSidebarLogic.ts'. Instead, modify the existing one.
- NEXT.JS CLIENT COMPONENTS: If the task involves Next.js and uses React hooks (useState, useEffect, etc.) or event handlers, remind the 'execute' mode to include '"use client";' (without any extra comments like "(Top of the file)").
- ANALYSIS FIRST: For any request involving existing code, the FIRST step(s) MUST be 'file_read' to understand the current implementation. Do NOT skip reading files before writing.
- Do NOT just say "I will fix it". Generate the actual plan with concrete file paths and actions.
- For implementation tasks, you MUST include 'file_write' step(s) AFTER 'file_read' steps.
- Output MUST be a valid JSON plan object with "tech_stack", "risk_level", and "plan" (array of steps) keys.`;

                userContent = `
CONTEXT FROM PREVIOUS CONVERSATION:
${historyContext || "None"}

ROLLING CONTEXT:
${compactContext || "None"}

CURRENT REQUEST:
${data.message}

INSTRUCTION: Create a step-by-step plan for the CURRENT REQUEST.
${planDirectives}
- Example JSON output (if a relevant file 'src/components/SocialButton.tsx' already exists in WORKSPACE CONTEXT):
{
  "tech_stack": { "language": "TypeScript", "framework": "Next.js" },
  "risk_level": "L2",
  "plan": [
    { "step": 1, "type": "file_read", "description": "Read src/components/SocialButton.tsx as it already exists" },
    { "step": 2, "type": "file_write", "description": "Modify src/components/SocialButton.tsx to add features" },
    { "step": 3, "type": "complete", "description": "Task finished" }
  ]
}
- Do NOT include markdown code fences ( \`\`\`json / \`\`\` ) in your response. Just the JSON object.
- Include "risk_level" (L1-L5) and "tech_stack" (language, framework) in the plan.
- JSON ONLY: Your entire response MUST be the JSON object. Do NOT include any introductory or concluding text. Do NOT include markdown code fences ( \`\`\`json ... \`\`\` ).
- STICK TO FORMAT: The response must start with '{' and end with '}'. No other text allowed.
- NO PREAMBLE: Do not say "Here is your plan" or "I have created a plan". Just output the JSON.
- NO MARKDOWN: NEVER use \`\`\`json or \`\`\` around the JSON.
`;
              } else if (mode === "analyze") {
                userContent = `
USER REQUEST:
${data.message}

WORKSPACE CONTEXT:
${workspaceContext || "No files in workspace."}

INSTRUCTION: 
1. ANALYZE BEFORE PLANNING: Your task is to find ANY existing files that might be related to the USER REQUEST.
2. LOOK FOR SIMILAR NAMES: If the user asks for "login", look for "auth", "session", "user", "LoginView", etc.
3. PREVENT DUPLICATES: If you find a file that does 80% of what's requested, identify it so we can modify it instead of creating a new one.
4. DETECT RELEVANT FILES: Identify files in the WORKSPACE CONTEXT (Tree View) that are relevant.
5. REQUEST CONTENT: If you see a file that seems relevant but you don't have its content in WORKSPACE CONTEXT, output: [readFile][file path="path/to/file"][/readFile]
6. FINAL SUMMARY: If you have enough info, provide a detailed summary of existing files that MUST be reused.

- Your goal is to prevent the agent from creating duplicate files.
- If you need to see the content of a file to be sure, output exactly: [readFile][file path="path/to/file"][/readFile]
- You can output multiple [readFile] tags if needed.
- If you already see the code skeleton in WORKSPACE CONTEXT and it's enough, summarize your findings.
`;
              } else if (mode === "execute") {
                const isTerminalStep = data.step?.type === 'terminal_command';
                userContent = `Execute Step ${data.step?.step}: ${data.step?.description}

Context from previous steps:
${compactContext || "None"}

${isTerminalStep ? `COMMAND TO RUN: ${data.step?.command || 'None'}` : ''}

INSTRUCTION: 
${isTerminalStep ? `- This is a TERMINAL COMMAND step. You MUST output exactly: [command]${data.step?.command}[/command].
- Do NOT output [writeFile] or any file content until this command is executed.
- Do NOT output markdown code fences.` : `- Use ONLY the following formats for file operations. Any other format (like "Open Diff:", "Applying change", etc.) is INVALID.
- For NEW FILES or FULL OVERWRITES, use:
[writeFile]
[file name="path/to/file"]
FILE_CONTENT
[/file]
[/writeFile]

- For MODIFYING EXISTING FILES, you MUST use diff format with SEARCH/REPLACE blocks. 
- CRITICAL: Do NOT put full file content inside [diff] tags.
[writeFile]
[diff name="path/to/file"]
<<<<<<< SEARCH
EXACT_OLD_CODE_TO_REPLACE (must be unique and include indentation)
=======
NEW_CODE_TO_INSERT
>>>>>>> REPLACE
[/diff]
[/writeFile]

- Important: 
  - The SEARCH block must match the existing code EXACTLY (indentation, newlines).
  - Use [file] ONLY for completely new files or if you are intentionally overwriting the ENTIRE file.
  - If you use [diff], you MUST provide at least one SEARCH/REPLACE block.
  - Do NOT use markdown code fences.
  - Do NOT include any conversational text like "Here is the code" or "I have modified the file".`}
- NEXT.JS CLIENT COMPONENTS: If you are writing a Next.js component that uses hooks (useState, useEffect, etc.), interactive elements (onClick, etc.), or browser APIs, you MUST include '"use client";' as the very first line. Do NOT add descriptive comments like "(Top of the file)".
- MANDATORY PAGE PATH: Use '${analysis.pageBasePath || "src/app/"}' for ALL new pages. If '${analysis.pageBasePath}' exists, NEVER use 'pages/'.
- CLEAN CODE ONLY: NEVER include placement markers like "(Top of the file)", "(End of file)", or any metadata comments. Only valid, executable code.
`;
                const isDirectChat = data.step && (data.step.type === "chat" || /Direct response/i.test(data.step.description || ""));
                if (isDirectChat) {
                  let extracted = "";
                  try {
                    const m = /Direct response:\s*"([\s\S]*)"/i.exec(data.step.description || "");
                    extracted = (m && m[1]) || "";
                  } catch (e) { }
                  userContent = extracted || data.step.description || "Respond to user request";
                }
              } else if (mode === "think") {
                userContent = `Current Step to execute: ${JSON.stringify(data.step)}\n\nContext:\n${data.context}\n\nINSTRUCTION: Decide if you need to read more files or search for something before executing the step. If you have enough info, just say you're ready. Use [readFile] or [searchFiles] if needed.
- If you need to read a file, output exactly: [readFile][file path="path/to/file"][/readFile]
- If you need to search, output exactly: [searchFiles]query[/searchFiles]
- If you are ready, output exactly: I am ready to execute the step.
`;
              } else {
                userContent = data.context
                  ? `${data.context}\n\nUser Request: ${data.message}`
                  : data.message;
              }

              if (attachmentSummary) {
                userContent = `ATTACHMENTS ANALYSIS:${attachmentSummary}\n\n${userContent}`;
              }

              messages.push({ role: "user", content: userContent });

              // 5. Call Ollama
              const response = await fetch(ollamaUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: ollamaModel,
                  messages: messages,
                  stream: mode !== "plan",
                }),
                signal: controller.signal,
              });

              if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Ollama error: ${errText}`);
              }

              if (mode === "plan") {
                const result: any = await response.json();
                let content = result.choices?.[0]?.message?.content || "";

                // Normalize plan object like in agent.js
                try {
                  const jsonString = this.extractFirstJsonObject(content);
                  const planObj = JSON.parse(jsonString);
                  const normalized = this.normalizePlanObject(
                    planObj,
                    data.message,
                  );
                  content = JSON.stringify(normalized, null, 2);
                } catch (e) {
                  console.error("Failed to normalize Ollama plan:", e);
                }

                // Normalize [writeFileVico] to [writeFile] for consistent processing
                const normalizedContent = content.replace(
                  /\[(\/?)writeFileVico\s*\]/gi,
                  "[$1writeFile]",
                );

                webviewView.webview.postMessage({
                  command: "ollamaAgentResponse",
                  mode,
                  content: normalizedContent,
                  uniqueId,
                });
                if (uniqueId) {
                  this.ollamaAbortControllers.delete(uniqueId);
                }
              } else {
                // Streaming for execute/think
                const reader = response.body?.getReader();
                const decoder = new TextDecoder();
                let assistantMessage = "";

                if (reader) {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split("\n");
                    for (const line of lines) {
                      if (line.startsWith("data: ")) {
                        const jsonStr = line.substring(6);
                        if (jsonStr === "[DONE]") continue;
                        try {
                          const json = JSON.parse(jsonStr);
                          const content = json.choices?.[0]?.delta?.content || "";
                          if (content) {
                            assistantMessage += content;
                            webviewView.webview.postMessage({
                              command: "ollamaAgentStream",
                              mode,
                              content,
                              uniqueId,
                            });
                          }
                        } catch (e) { }
                      }
                    }
                  }
                }
                // Normalize [writeFileVico] to [writeFile] for consistent processing
                let normalizedAssistantMessage = assistantMessage.replace(
                  /\[(\/?)writeFileVico\s*\]/gi,
                  "[$1writeFile]",
                );

                // Clean up hallucinated placement comments from local models
                normalizedAssistantMessage = normalizedAssistantMessage.replace(
                  /\((Top|End|Bottom|Beginning)\s+of\s+the\s+file\)/gi,
                  "",
                ).replace(
                  /\(at\s+the\s+(Top|End|Bottom|Beginning)\s+of\s+the\s+file\)/gi,
                  "",
                ).replace(
                  /\/\/\s+(Top|End|Bottom|Beginning)\s+of\s+the\s+file/gi,
                  "",
                );

                webviewView.webview.postMessage({
                  command: "ollamaAgentResponse",
                  mode,
                  content: normalizedAssistantMessage,
                  uniqueId,
                });
                if (uniqueId) {
                  this.ollamaAbortControllers.delete(uniqueId);
                }
              }
            } catch (error: any) {
              if (uniqueId) {
                this.ollamaAbortControllers.delete(uniqueId);
              }
              if (error.name === "AbortError") {
                this.sendLog(`[Ollama Agent] Request aborted: ${uniqueId}`);
                return;
              }
              webviewView.webview.postMessage({
                command: "ollamaAgentResponse",
                mode,
                error: error.message,
                uniqueId,
              });
            }
            return;
          }
          case "ollamaChat": {
            const { data, uniqueId } = message;
            const ollamaModel = data.model.replace("ollama:", "");
            const customUrl = this.context.globalState.get<string>("vico.customApiUrl");
            const ollamaUrl = (customUrl && customUrl.trim()) || "http://localhost:11434/v1/chat/completions";
            const controller = new AbortController();
            if (uniqueId) {
              this.ollamaAbortControllers.set(uniqueId, controller);
            }

            try {
              // 1. Load Prompts
              const [basePrompt, chatPrompt] = await Promise.all([
                this.fetchPrompt("base"),
                this.fetchPrompt("chat"),
              ]);

              // 2. Get Workspace Context (sampled string)
              const workspaceContext = await this.getAllWorkspaceFiles();

              // 3. Handle Attachments
              let attachmentSummary = "";
              if (data.attachments && data.attachments.length > 0) {
                this.sendLog(`[Ollama Chat] Analyzing ${data.attachments.length} attachments...`);
                for (const att of data.attachments) {
                  const content = att.content || att.contentDataUrl || "";
                  if (content && (att.type?.startsWith("text/") || att.name?.match(/\.(ts|js|tsx|jsx|json|html|css|md|py|txt)$/i))) {
                    let text = content;
                    if (content.startsWith("data:")) {
                      const m = /^data:(.*?);base64,(.*)$/.exec(content);
                      if (m) text = Buffer.from(m[2], "base64").toString("utf8");
                    }
                    attachmentSummary += `\n\nFILE ATTACHMENT: ${att.name}\nCONTENT:\n${text}\n`;
                  } else {
                    attachmentSummary += `\n\nATTACHMENT: ${att.name} (Non-text or image, skipping deep analysis for Ollama for now)`;
                  }
                }
              }

              // 4. Prepare Messages (Multi-system messages)
              const messages: any[] = [];
              if (basePrompt) messages.push({ role: "system", content: basePrompt });
              if (chatPrompt) messages.push({ role: "system", content: chatPrompt });

              if (workspaceContext) {
                messages.push({ role: "system", content: `WORKSPACE CONTEXT:\n${workspaceContext}` });
              }

              // Map history to OpenAI format and ensure they are valid
              const historyMessages = (data.history || []).map((m: any) => ({
                role: m.role === "assistant" ? "assistant" : "user",
                content: m.content,
              }));

              let userContent = data.message;
              if (attachmentSummary) {
                userContent = `ATTACHMENTS ANALYSIS:${attachmentSummary}\n\n${userContent}`;
              }

              messages.push(...historyMessages);
              messages.push({ role: "user", content: userContent });

              // 5. Call Ollama
              const response = await fetch(ollamaUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: ollamaModel,
                  messages: messages,
                  stream: true,
                }),
                signal: controller.signal,
              });

              if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Ollama error: ${errText}`);
              }

              // 4. Stream response to webview
              const reader = response.body?.getReader();
              const decoder = new TextDecoder();
              let assistantMessage = "";

              if (reader) {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  const chunk = decoder.decode(value, { stream: true });

                  // Ollama returns SSE format: data: {...}\n\n
                  const lines = chunk.split("\n");
                  for (const line of lines) {
                    if (line.startsWith("data: ")) {
                      const jsonStr = line.substring(6);
                      if (jsonStr === "[DONE]") continue;
                      try {
                        const json = JSON.parse(jsonStr);
                        const content = json.choices?.[0]?.delta?.content || "";
                        if (content) {
                          assistantMessage += content;
                          webviewView.webview.postMessage({
                            command: "ollamaChunk",
                            uniqueId: uniqueId,
                            content: assistantMessage
                          });
                        }
                      } catch (e) {
                        // ignore malformed json
                      }
                    }
                  }
                }
              }

              // Normalize [writeFileVico] to [writeFile] for consistent processing
              const normalizedAssistantMessage = assistantMessage.replace(
                /\[(\/?)writeFileVico\s*\]/gi,
                "[$1writeFile]",
              );

              webviewView.webview.postMessage({
                command: "ollamaFinished",
                uniqueId: uniqueId,
                content: normalizedAssistantMessage,
              });
              if (uniqueId) {
                this.ollamaAbortControllers.delete(uniqueId);
              }

            } catch (error: any) {
              if (uniqueId) {
                this.ollamaAbortControllers.delete(uniqueId);
              }
              if (error.name === "AbortError") {
                this.sendLog(`[Ollama Chat] Request aborted: ${uniqueId}`);
                return;
              }
              console.error("Ollama Chat Error:", error);
              webviewView.webview.postMessage({
                command: "error",
                error: error.message
              });
            }
            return;
          }
          case "clearHistory":
            this.context.globalState.update("chatHistory", []);
            webviewView.webview.postMessage({
              command: "historyLoad",
              history: [],
            });
            return;
          case "clearCodingHistory":
            this.listFilesCache.clear();
            this.readFileCache.clear();
            this.workspaceVersion++;
            vscode.commands.executeCommand("vibe-coding.clearCodingHistory");
            return;
          case "saveToken":
            // Save token to globalState
            this.context.globalState.update("token", message.token);
            return;
          case "getAiSettings": {
            const selectedModel = this.normalizeModel(
              this.context.globalState.get<string>(
                SidebarProvider.MODEL_SETTING_KEY,
                SidebarProvider.DEFAULT_MODEL,
              ),
            );
            const selectedProvider = this.context.globalState.get<string>(
              SidebarProvider.MODEL_PROVIDER_KEY,
              "openai",
            );
            const userApiKey =
              (await this.context.secrets.get(
                SidebarProvider.USER_API_KEY_SECRET,
              )) || "";
            const customApiUrl = this.context.globalState.get<string>("vico.customApiUrl") || "";
            const usage = this.getMachinePromptUsage();
            const remaining = Math.max(
              0,
              SidebarProvider.FREE_PROMPT_LIMIT - usage,
            );
            webviewView.webview.postMessage({
              command: "aiSettings",
              selectedModel,
              selectedProvider,
              customApiUrl,
              hasUserApiKey: userApiKey.trim().length > 0,
              freePromptLimit: SidebarProvider.FREE_PROMPT_LIMIT,
              machinePromptUsed: usage,
              machinePromptRemaining: remaining,
            });
            return;
          }
          case "saveAiSettings": {
            const selectedModel = this.normalizeModel(message.model);
            const selectedProvider = message.provider || "openai";
            const customApiUrl = message.customApiUrl || "";

            await this.context.globalState.update(
              SidebarProvider.MODEL_SETTING_KEY,
              selectedModel,
            );
            await this.context.globalState.update(
              SidebarProvider.MODEL_PROVIDER_KEY,
              selectedProvider,
            );
            await this.context.globalState.update(
              "vico.customApiUrl",
              customApiUrl,
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
              selectedProvider,
              customApiUrl,
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
            const isOllama = selectedModel.startsWith("ollama:");

            if (isCountedMode && !hasUserApiKey && !isOllama) {
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
            const customApiUrl = this.context.globalState.get<string>("vico.customApiUrl") || "";
            webviewView.webview.postMessage({
              command: "promptQuotaResult",
              requestId,
              allowed,
              reason,
              selectedModel,
              customApiUrl,
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
            // Save token to globalState
            let workspacePath = "";
            if (vscode.workspace.workspaceFolders) {
              workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            } else {
              let randomNum = Math.floor(Math.random() * 100000);
              workspacePath = randomNum.toString();
            }
            const uniqueInput = `${message.userId}:${workspacePath}`; // Combine userId with workspacePath

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
              const uniqueInput = `${message.email}:${workspacePath}`; // Combine userId with workspacePath

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
              // Show prompt to user
              const userResponse = await vscode.window.showInformationMessage(
                "This action will train the AI with a sampled subset of the code in your workspace. This process helps the AI understand the context of your code, including its structure and logic. Do you want to proceed? Note: This may include sensitive or private code.",
                { modal: true }, // Modal to ensure user provides response
                "Teach AI Current Code", // Confirmation button
              );

              if (userResponse === "Teach AI Current Code") {
                // If user chooses to continue
                const files = await this.getAllWorkspaceFiles();
                // console.log("files: ", files);
                webviewView.webview.postMessage({
                  command: "workspaceCode",
                  files,
                });
              } else {
                // If user cancels
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

  private maxTokens = 8000;
  private targetSize = 30000; // approximately 7.5k tokens (1 token ≈ 4 characters)
  private maxFilesPerFolder = 2;

  private normalizeStepType(rawType: any): string {
    const t = String(rawType || "")
      .trim()
      .toLowerCase();
    if (t === "terminal_command" || t === "terminal") return "terminal_command";
    if (t === "command" || t === "run_command") return "terminal_command";
    if (t === "file_write" || t === "write" || t === "diff") return "file_write";
    if (t === "file_read" || t === "read") return "file_read";
    if (t === "complete" || t === "done") return "complete";
    return "file_write";
  }

  private normalizePlanObject(planObj: any, briefRequest = "task"): any {
    const normalized =
      planObj && typeof planObj === "object" ? { ...planObj } : {};
    const rawPlan = Array.isArray(normalized.plan)
      ? normalized.plan
      : Array.isArray(normalized.steps)
        ? normalized.steps
        : Array.isArray(normalized.actions)
          ? normalized.actions
          : [];
    const plan = rawPlan
      .map((s: any, idx: number) => {
        const type = this.normalizeStepType(s?.type);
        const description = String(s?.description || "").trim();
        const command = typeof s?.command === "string" ? s.command.trim() : "";
        const step = Number.isFinite(Number(s?.step)) ? Number(s.step) : idx + 1;
        return {
          step,
          type,
          description:
            description ||
            (type === "terminal_command"
              ? `Run verification command for "${briefRequest}".`
              : type === "complete"
                ? `Mark "${briefRequest}" complete.`
                : `Implement "${briefRequest}" in project files.`),
          ...(type === "terminal_command" && command ? { command } : {}),
        };
      })
      .filter((s: any) => s.description.length > 0);

    plan.sort((a: any, b: any) => a.step - b.step);
    for (let i = 0; i < plan.length; i++) {
      plan[i].step = i + 1;
    }

    return {
      tech_stack: normalized.tech_stack || {
        language: "Unknown",
        framework: "Unknown",
      },
      risk_level: /^L[1-5]$/i.test(String(normalized.risk_level || ""))
        ? String(normalized.risk_level).toUpperCase()
        : "L2",
      plan,
    };
  }

  private extractFirstJsonObject(raw: string): string {
    const text = this.stripMarkdownCodeFence(raw);
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return text;
    }
    // Attempt to find a valid JSON object by finding the matching closing brace
    // rather than just the last brace in the entire text.
    let braceCount = 0;
    let foundStart = false;
    for (let i = firstBrace; i < text.length; i++) {
      if (text[i] === "{") {
        braceCount++;
        foundStart = true;
      } else if (text[i] === "}") {
        braceCount--;
      }
      if (foundStart && braceCount === 0) {
        return text.slice(firstBrace, i + 1);
      }
    }
    // Fallback to last brace if simple matching fails
    return text.slice(firstBrace, lastBrace + 1);
  }

  private stripMarkdownCodeFence(raw: string): string {
    const text = String(raw || "").trim();
    if (!text) return "";
    // More robust regex to catch code fences anywhere in the text
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    return match ? String(match[1] || "").trim() : text;
  }

  private buildExecutionDirectives(step: any, context: string): string {
    let riskLevel = "L2"; // Default
    if (context) {
      const riskMatch = /"risk_level":\s*"(L[1-5])"/i.exec(context);
      if (riskMatch) {
        riskLevel = riskMatch[1];
      } else {
        const textMatch = /Risk Level:\s*(L[1-5])/i.exec(context);
        if (textMatch) riskLevel = textMatch[1];
      }
    }

    let constraintDirective = "";
    switch (riskLevel) {
      case "L1":
        constraintDirective =
          "RISK LEVEL L1 (UI/Text): RELAX CONSTRAINTS. Focus on speed and visual correctness. Skip heavy architecture checks.";
        break;
      case "L2":
        constraintDirective =
          "RISK LEVEL L2 (Feature): STANDARD CONSTRAINTS. Ensure code works and update history.md.";
        break;
      case "L3":
        constraintDirective =
          "RISK LEVEL L3 (Module): STRICT ARCHITECTURE CHECK. Verify imports and dependencies. Update memory.md.";
        break;
      case "L4":
        constraintDirective =
          "RISK LEVEL L4 (Dependency): CRITICAL IMPACT ANALYSIS. Check for circular dependencies. Confirm safety.";
        break;
      case "L5":
        constraintDirective =
          "RISK LEVEL L5 (Core): MAX SECURITY & VERIFICATION. Do not break existing features. STOP & VERIFY.";
        break;
    }

    const stepType = this.normalizeStepType(step?.type);
    const selfEvalDirective =
      stepType === "file_write"
        ? `
## SELF-EVALUATION LOOP
1. **EXECUTE**: Generate code changes with [writeFile].
2. **EVALUATE**: Review output against ${riskLevel} constraints.
3. **CORRECT**: If needed, fix immediately in this same response.
4. **UPDATE**: Optional metadata logs (.vico/history.md, lesson.md/lessons.md) only after core code is done.
`
        : stepType === "terminal_command"
          ? `
## SELF-EVALUATION LOOP
1. **EXECUTE**: Return exactly one [command] block.
2. **EVALUATE**: Ensure command is short-lived and relevant.
3. **CORRECT**: If blocked, return [REPLAN] with reason.
`
          : stepType === "complete"
            ? `
## SELF-EVALUATION LOOP
1. **EXECUTE**: Return concise completion acknowledgement only.
2. **EVALUATE**: Do not generate [writeFile] or [command] for complete step.
`
            : `
## SELF-EVALUATION LOOP
1. **EXECUTE**: Follow the requested step type precisely.
2. **EVALUATE**: Keep output executable and minimal.
`;

    const outputContractDirective =
      stepType === "file_write"
        ? [
          "OUTPUT CONTRACT (MANDATORY FOR THIS STEP):",
          "- This is a file_write step.",
          "- Output MUST include [writeFile]...[file]/[diff]...[/writeFile].",
          "- CRITICAL: Ensure the file path MATCHES the project structure (e.g., use 'src/app/' for Next.js App Router).",
          "- Do NOT output JSON plan objects.",
          "- Do NOT output markdown code fences (```json / ```).",
          "- Do NOT output shell echo redirection commands for file creation.",
          "- If you cannot proceed, output [REPLAN]reason[/REPLAN].",
        ].join("\n")
        : stepType === "terminal_command"
          ? [
            "OUTPUT CONTRACT (MANDATORY FOR THIS STEP):",
            "- This is a terminal_command step.",
            "- Output MUST be exactly one [command]...[/command] block.",
            "- Do NOT output JSON plan objects.",
            "- Do NOT output markdown code fences.",
            "- If you cannot proceed, output [REPLAN]reason[/REPLAN].",
          ].join("\n")
          : "";

    return [constraintDirective, selfEvalDirective, outputContractDirective]
      .filter(Boolean)
      .join("\n\n");
  }

  private normalizeVerificationMode(raw: any): string {
    const value = String(raw || "")
      .trim()
      .toLowerCase();
    if (value === "minimal" || value === "strict") return value;
    return "normal";
  }

  private buildAgentStateContext(state: any): string {
    if (
      !state ||
      !Array.isArray(state.recent_steps) ||
      state.recent_steps.length === 0
    ) {
      return "";
    }
    const recent = state.recent_steps.slice(-8);
    const rendered = recent
      .map((s: any, idx: number) => {
        const line = [
          `${idx + 1}. step=${s.step || "?"}`,
          `desc="${String(s.description || "").slice(0, 180)}"`,
          s.command ? `command="${s.command}"` : "",
          Array.isArray(s.changed_files) && s.changed_files.length > 0
            ? `changed=${JSON.stringify(s.changed_files)}`
            : "",
          s.has_replan ? "replan=true" : "",
          s.has_write ? "write=true" : "",
        ]
          .filter(Boolean)
          .join(" | ");
        return line;
      })
      .join("\n");
    return `RECENT EXECUTION STATE (most recent last):\n${rendered}`;
  }

  private buildLoopBreakerContext(state: any, stepDescription: string): string {
    if (!state || !Array.isArray(state.recent_steps) || !stepDescription)
      return "";
    const desc = String(stepDescription).trim().toLowerCase();
    if (!desc) return "";
    const hits = state.recent_steps.slice(-6).filter(
      (s: any) =>
        String(s?.description || "")
          .trim()
          .toLowerCase() === desc,
    ).length;
    if (hits < 2) return "";
    return `LOOP PREVENTION: The same step description has repeated ${hits} times recently. Do not repeat identical action; adapt with a different concrete fix.`;
  }

  private buildVerificationModeDirective(mode: string): string {
    if (mode === "minimal") {
      return [
        "VERIFICATION_MODE: minimal",
        "- Keep verification lightweight.",
        "- Do not loop on repeated checks.",
        "- After implementation is persisted and no critical error appears, finish.",
      ].join("\n");
    }
    if (mode === "strict") {
      return [
        "VERIFICATION_MODE: strict",
        "- Require explicit final verification before claiming complete.",
        "- Run stronger consistency checks for edited files and references.",
        "- Only mark complete when implementation and verification both pass.",
      ].join("\n");
    }
    return [
      "VERIFICATION_MODE: normal",
      "- Use balanced verification.",
      "- Verify enough to avoid regressions, but avoid unnecessary loops.",
    ].join("\n");
  }

  private buildGuardrailsContext(guardrails: any): string {
    const parsed = guardrails && typeof guardrails === "object" ? guardrails : {};
    const whitelist = Array.isArray(parsed?.whitelist) ? parsed.whitelist : [];
    const lineLimits = parsed?.line_limits || parsed?.lineLimits || {};

    const segments = [];
    if (whitelist.length > 0) {
      segments.push(
        `WHITELISTED FILES (preferred targets): ${JSON.stringify(whitelist)}\n` +
        `(You have FULL PERMISSION to edit ANY file needed for the fix. The whitelist is just a hint to prioritize these paths if possible. DO NOT skip a necessary fix or emit [REPLAN] just because a file is not on this list.)`,
      );
    }

    const limitEntries =
      lineLimits && typeof lineLimits === "object"
        ? Object.entries(lineLimits).filter(([, limit]) => limit != null)
        : [];
    if (limitEntries.length > 0) {
      const formatted = limitEntries.map(([file, limit]) =>
        `- ${file}: lines ${JSON.stringify(limit)}`,
      );
      segments.push(
        `LINE LIMITS (apply to the listed files): \n${formatted.join("\n")}\n` +
        `(Respect these ranges for the specified files, but you may freely edit anywhere else. If a critical fix requires changes outside these lines, prioritize the fix and mention it in your thought block.)`,
      );
    }

    if (segments.length === 0) return "";
    return segments.join("\n\n");
  }

  private buildHistoryContext(history: any[]): string {
    if (!Array.isArray(history) || history.length === 0) return "";
    const recent = history.slice(-10);
    return recent
      .map((m) => {
        const role = (m?.role || "").toUpperCase();
        const content = String(m?.content || "");
        return `[${role}]: ${content.substring(0, 1200)}`;
      })
      .join("\n\n");
  }

  private compressContext(context: string, maxChars = 50000): string {
    const text = String(context || "");
    if (!text) return "";
    if (text.length <= maxChars) return text;

    const head = Math.floor(maxChars * 0.65);
    const tail = maxChars - head;
    return `${text.slice(0, head)}\n\n[... context truncated ...]\n\n${text.slice(-tail)}`;
  }

  private async analyzeFramework(rootPath: string): Promise<{ framework: string; structure: string; pageBasePath: string }> {
    const pkgPath = path.join(rootPath, "package.json");
    if (!fs.existsSync(pkgPath)) return { framework: "Unknown", structure: "No package.json", pageBasePath: "" };

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      let framework = "Unknown";
      if (deps["next"]) framework = "Next.js";
      else if (deps["nuxt"]) framework = "Nuxt.js";
      else if (deps["@angular/core"]) framework = "Angular";
      else if (deps["react"]) framework = "React";
      else if (deps["vue"]) framework = "Vue";
      else if (deps["svelte"]) framework = "Svelte";

      // Detect structure
      const hasSrc = fs.existsSync(path.join(rootPath, "src"));
      const hasApp = fs.existsSync(path.join(rootPath, "app")) || (hasSrc && fs.existsSync(path.join(rootPath, "src", "app")));
      const hasPages = fs.existsSync(path.join(rootPath, "pages")) || (hasSrc && fs.existsSync(path.join(rootPath, "src", "pages")));

      let structure = hasSrc ? "Using src/ directory. " : "Root-level structure. ";
      let pageBasePath = "";

      if (framework === "Next.js") {
        if (hasApp) {
          structure += "App Router detected (app/). ";
          pageBasePath = hasSrc ? "src/app/" : "app/";
        } else if (hasPages) {
          structure += "Pages Router detected (pages/). ";
          pageBasePath = hasSrc ? "src/pages/" : "pages/";
        }
      }

      return { framework, structure, pageBasePath };
    } catch (e) {
      return { framework: "Unknown", structure: "Error parsing package.json", pageBasePath: "" };
    }
  }

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

      const workspaceFolders = vscode.workspace.workspaceFolders;
      const rootPath = workspaceFolders ? workspaceFolders[0].uri.fsPath : "";
      const analysis = await this.analyzeFramework(rootPath);
      const frameworkInfo = `${analysis.framework} | ${analysis.structure}`;

      const structureHeader = `// ===== PROJECT CONTEXT =====
// Framework: ${frameworkInfo}
// Page Base Path: ${analysis.pageBasePath || "N/A"}
// MANDATORY RULE: All new pages MUST be created in '${analysis.pageBasePath || "the existing page directory"}'.
// NEVER create a 'pages/' directory if 'app/' is used, and vice versa.
// ALWAYS check the tree view below to match the existing folder structure (e.g., if 'src/' exists, stay inside 'src/').

// ===== PROJECT STRUCTURE (Tree View) =====
`;
      if (filePaths.length === 0) {
        return structureHeader + "// (The project is currently empty. No files found.)\n\n";
      }
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

        // sort by file name (not random)
        priorityFiles.sort((a, b) => a.path.localeCompare(b.path));
        normalFiles.sort((a, b) => a.path.localeCompare(b.path));
        configFiles.sort((a, b) => a.path.localeCompare(b.path));

        // get max 3 priority files first
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

        // If slots are still empty, then include config
        const finalSlots =
          this.maxFilesPerFolder -
          selectedFiles.filter((f) => path.dirname(f.path) === folder).length;
        if (finalSlots > 0) {
          configFiles
            .slice(0, finalSlots)
            .forEach((f) => selectedFiles.push(f));
        }
      }

      // Group output based on folder
      const grouped: Record<
        string,
        { path: string; code: string; priority: boolean; config: boolean }[]
      > = {};
      for (const f of selectedFiles) {
        const relativePath = vscode.workspace.asRelativePath(f.path);
        let folderKey = "(root)";
        if (relativePath.includes("src/app/")) {
          folderKey = "src/app";
        } else if (relativePath.includes("src/pages/")) {
          folderKey = "src/pages";
        } else if (relativePath.includes("app/")) {
          folderKey = "app";
        } else if (relativePath.includes("pages/")) {
          folderKey = "pages";
        } else if (relativePath.includes("src/")) {
          folderKey = "src";
        } else if (relativePath.includes("/")) {
          folderKey = relativePath.split("/")[0];
        }

        if (!grouped[folderKey]) grouped[folderKey] = [];
        grouped[folderKey].push(f);
      }

      // Combine results within size limits
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

  // --- Strip comments, but keep code intact ---
  private stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/^\s*#.*$/gm, "")
      .replace(/^\s*$/gm, "")
      .trim();
  }

  // --- Skeleton code for all languages ---
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

  // --- Detect text files ---
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

  // --- Detect priority files ---
  private isPriorityFile(filePath: string): boolean {
    const isNextJsPriority = /(app\/|pages\/|src\/app\/|src\/pages\/)/i.test(filePath) &&
      (filePath.endsWith("page.tsx") || filePath.endsWith("layout.tsx") || filePath.endsWith("index.tsx") || filePath.endsWith("route.ts"));

    if (isNextJsPriority) return true;

    return /(model|schema|entity|types?|interfaces?|dto|config|api|routes?|validation|controller|service|store|hook|utils|lib|context|provider|component)/i.test(
      filePath,
    );
  }

  // --- Detect config files ---
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
