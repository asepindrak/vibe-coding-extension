"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = __importStar(require("vscode"));
const SidebarProvider_1 = require("./SidebarProvider");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const vico_logger_1 = __importDefault(require("vico-logger"));
// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
let lastSuggestion = null;
let lastLinePrefix = null;
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
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
function stripPrefix(suggestion, linePrefix) {
    if (suggestion.startsWith(linePrefix)) {
        return suggestion.slice(linePrefix.length);
    }
    return suggestion;
}
let requestId = 0;
let currentAbortController = null;
let lastRequestLine = null;
let lastRequestPrefix = null;
let lastTypedAt = Date.now();
async function fetchSuggestions(context, editor) {
    if (!isInlineEnabled())
        return;
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
    if (!lineText.trim())
        return;
    const cleanedInput = removeCommentTags(lineText.trim());
    if (cleanedInput.length < 3 && cursorLine === sourceLine)
        return;
    // 👉 Inline muncul di posisi cursor (bisa baris kosong)
    const isNewLine = cursorLine !== sourceLine;
    lastRequestLine = cursorLine;
    lastRequestPrefix = isNewLine ? '' : cleanedInput;
    lastLinePrefix = lineText;
    const token = context.globalState.get('token');
    if (!token) {
        vscode.window.showErrorMessage("Vibe Coding token is missing. Please login first.");
        return;
    }
    // 🔥 Ambil konteks sekitar baris sumber (hemat token + relevan)
    const CONTEXT_RADIUS = 40;
    const contextCenterLine = sourceLine;
    const start = Math.max(0, contextCenterLine - CONTEXT_RADIUS);
    const end = Math.min(editor.document.lineCount - 1, contextCenterLine + CONTEXT_RADIUS);
    let contextCode = '';
    for (let i = start; i <= end; i++) {
        contextCode += editor.document.lineAt(i).text + '\n';
    }
    // Status bar loading
    loadingStatusBarItem.text = "⚡ Vibe Coding thinking...";
    if (isNewLine) {
        loadingStatusBarItem.text = "✨ Vibe Coding predicting next line...";
    }
    const showLoadingTimeout = setTimeout(() => loadingStatusBarItem.show(), 400);
    const lang = editor.document.languageId;
    const file = path.basename(editor.document.fileName);
    const body = {
        userId: 'vscode-user',
        message: `File: ${file}\n` +
            `Language: ${lang}\n` +
            `Follow ${lang} best practices and syntax.\n` +
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
            `Return ONLY the continuation text without explanations, markdown, or code fences.`
    };
    // 👉 simpan posisi cursor saat request dikirim
    const requestLine = cursorLine;
    try {
        const response = await fetch('http://localhost:13100/api/suggest', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const errorMessage = await response.text();
            throw new Error(`Error ${response.status}: ${errorMessage}`);
        }
        if (currentRequest !== requestId)
            return; // ❌ skip response lama
        const suggestions = await response.json();
        // ❌ Kalau user pindah baris, skip
        if (editor.selection.active.line !== requestLine)
            return;
        const freshLine = editor.document.lineAt(requestLine).text;
        presentSuggestions(suggestions.message, freshLine);
        await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
        setTimeout(() => {
            if (lastSuggestion) {
                vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            }
        }, 50);
    }
    catch (error) {
        if (error.name === 'AbortError')
            return;
        console.error('Error while fetching suggestions:', error);
    }
    finally {
        clearTimeout(showLoadingTimeout);
        loadingStatusBarItem.hide();
    }
}
function isInlineEnabled() {
    return vscode.workspace
        .getConfiguration("vibeCoding")
        .get("inline.enabled", true);
}
function normalizeInlineSuggestion(text) {
    return text
        .replace(/\n/g, '')
        .replace(/\r/g, '')
        .slice(0, 120);
}
async function presentSuggestions(suggestion, linePrefix) {
    console.log("Presenting suggestion:", suggestion);
    if (suggestion && suggestion.trim().length > 0) {
        let next = suggestion;
        if (linePrefix) {
            next = stripPrefix(suggestion, linePrefix);
        }
        lastSuggestion = normalizeInlineSuggestion(next);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}
async function writeFileVico(context, editor) {
    vico_logger_1.default.info("writeFileVico called");
    const writeContent = context.globalState.get('writeContent');
    if (!writeContent) {
        vscode.window.showWarningMessage('No content to write. No response from assistant.');
        return;
    }
    if (!vscode.workspace.workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open!');
        return;
    }
    const projectRoot = vscode.workspace.workspaceFolders[0].uri;
    try {
        // 1. Extract block [writeFile]...[/writeFile]
        // Supports both single block or multiple blocks if the AI outputs them sequentially
        const blockRegex = /\[writeFile\]([\s\S]*?)\[\/writeFile\]/g;
        let match;
        let contentToProcess = '';
        // Accumulate all content within [writeFile] tags
        while ((match = blockRegex.exec(writeContent)) !== null) {
            contentToProcess += match[1] + '\n';
        }
        if (!contentToProcess.trim()) {
            // Fallback: try to parse the whole message if the tags are missing but command was triggered
            // or if the tag was just [writeFile] without closing (though regex above requires closing)
            // Let's try to match open tag until end of string if no closing tag found
            const openTagMatch = writeContent.match(/\[writeFile\]([\s\S]*)/);
            if (openTagMatch) {
                contentToProcess = openTagMatch[1];
            }
            else {
                contentToProcess = writeContent;
            }
        }
        // 2. Parse [file name="path"]...[/file]
        // Regex explanation:
        // \[file name="([^"]+)"\]  -> Matches [file name="path/to/file.ext"] and captures the path
        // ([\s\S]*?)               -> Matches content non-greedily
        // \[\/file\]               -> Matches [/file]
        const fileRegex = /\[file name="([^"]+)"\]([\s\S]*?)\[\/file\]/g;
        let fileMatch;
        let filesCreated = 0;
        while ((fileMatch = fileRegex.exec(contentToProcess)) !== null) {
            const relativePath = fileMatch[1].trim();
            const fileContent = fileMatch[2].trim(); // Trim leading/trailing whitespace from content
            const fileUri = vscode.Uri.joinPath(projectRoot, relativePath);
            const dirUri = vscode.Uri.file(path.dirname(fileUri.fsPath));
            // 3. Create directory if it doesn't exist
            await vscode.workspace.fs.createDirectory(dirUri);
            // 4. Write file
            const data = Buffer.from(fileContent, 'utf8');
            // Check if file exists
            try {
                await vscode.workspace.fs.stat(fileUri);
                // File exists, ask for overwrite confirmation
                const confirmOverwrite = await vscode.window.showWarningMessage(`File ${relativePath} already exists. Overwrite?`, { modal: true }, 'Yes', 'No');
                if (confirmOverwrite !== 'Yes') {
                    vscode.window.showInformationMessage(`Skipped: ${relativePath}`);
                    continue;
                }
            }
            catch (error) {
                // File does not exist, proceed
            }
            await vscode.workspace.fs.writeFile(fileUri, data);
            vico_logger_1.default.info(`File created: ${fileUri.path}`);
            vscode.window.showInformationMessage(`✅ Created: ${relativePath}`);
            filesCreated++;
        }
        if (filesCreated > 0) {
            vscode.window.showInformationMessage(`🎉 Successfully created ${filesCreated} files.`);
        }
        else {
            vscode.window.showWarningMessage('No file blocks found to create. Format: [file name="path"]content[/file]');
        }
    }
    catch (err) {
        vico_logger_1.default.error('Failed to write file:', err);
        vscode.window.showErrorMessage('Failed to write file: ' + (err.message || err.toString()));
    }
}
let loadingStatusBarItem;
function activate(context) {
    loadingStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(loadingStatusBarItem);
    // Disini kita daftarin command
    let disposable = vscode.commands.registerCommand('vibe-coding.writeFile', async () => {
        vico_logger_1.default.info("writeFile command triggered");
        await writeFileVico(context, vscode.window.activeTextEditor);
    });
    context.subscriptions.push(disposable);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration("vibeCoding.inline.enabled")) {
            lastSuggestion = null; // clear ghost text
            vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
        }
    }));
    const SUPPORTED_LANGUAGES = [
        'javascript',
        'typescript',
        'python',
        'php',
        'go',
        'java',
        'c',
        'cpp',
        'csharp',
        'rust',
        'ruby',
        'json',
        'html',
        'css',
        'bash',
        'yaml',
        'dockerfile',
        'markdown',
        'sql'
    ];
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(SUPPORTED_LANGUAGES.map(lang => ({ scheme: 'file', language: lang })), {
        provideCompletionItems(document, position) {
            if (!lastSuggestion || !lastSuggestion.trim())
                return;
            const item = new vscode.CompletionItem(lastSuggestion, vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(lastSuggestion);
            item.detail = 'AI Suggestion from Vibe Coding';
            item.sortText = '\u0000';
            item.command = {
                command: 'vibe-coding.clearSuggestion',
                title: ''
            };
            return [item];
        }
    }, '' // manual trigger
    ));
    // Command untuk menghapus suggestion setelah dipilih
    context.subscriptions.push(vscode.commands.registerCommand('vibe-coding.clearSuggestion', () => {
        lastSuggestion = null;
    }));
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "vibe-coding" is now active!');
    // Register the Sidebar Panel
    const sidebarProvider = new SidebarProvider_1.SidebarProvider(context.extensionUri, context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("vibe-coding-sidebar", sidebarProvider));
    // Register a command to update the webview with the current file and line information
    context.subscriptions.push(vscode.commands.registerCommand('vibe-coding.updateWebview', () => {
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
                    command: 'updateFileInfo',
                    filePath: fileName, // Kirim nama file saja
                    selectedLine: `${startLine}-${endLine}` // Kirim rentang baris yang dipilih
                });
            }
        }
    }));
    context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, {
        async provideInlineCompletionItems(document, position) {
            if (!isInlineEnabled())
                return [];
            if (!lastSuggestion)
                return [];
            if (lastRequestLine !== position.line)
                return [];
            const lineText = document.lineAt(position.line).text;
            const isNewLine = lineText.trim() === '';
            if (!isNewLine && lastRequestPrefix && !lineText.trim().startsWith(lastRequestPrefix)) {
                return [];
            }
            return [{
                    insertText: lastSuggestion,
                    range: new vscode.Range(position, position)
                }];
        }
    }));
    const debouncedFetch = debounce(() => {
        const editor = vscode.window.activeTextEditor;
        if (editor)
            fetchSuggestions(context, editor);
    }, 600);
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const change = e.contentChanges[0];
        if (!change)
            return;
        lastSuggestion = null;
        vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
        const isNewLine = change.text === '\n';
        const isTyping = change.text.length > 0 && change.text !== '\n';
        if (isTyping || isNewLine) {
            debouncedFetch();
        }
        if (isNewLine) {
            setTimeout(() => {
                vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            }, 80);
        }
    }));
    vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const change = e.contentChanges[0];
        if (!change)
            return;
        // 👉 Detect user tekan Enter
        if (change.text === '\n') {
            setTimeout(() => {
                vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            }, 50);
        }
    });
    // Trigger the updateWebview command when the active editor changes or the selection changes
    vscode.window.onDidChangeActiveTextEditor(() => {
        vscode.commands.executeCommand('vibe-coding.updateWebview');
    });
    vscode.window.onDidChangeTextEditorSelection(() => {
        vscode.commands.executeCommand('vibe-coding.updateWebview');
    });
    // Initial trigger to update the webview
    vscode.commands.executeCommand('vibe-coding.updateWebview');
    context.subscriptions.push(vscode.commands.registerCommand('vibe-coding.applyCodeSelection', async (args) => {
        // Handle argument passing from webview which might be just "code" string or object
        let code = '';
        let filePath = null;
        if (typeof args === 'string') {
            code = args;
        }
        else if (typeof args === 'object') {
            code = args.code;
            filePath = args.filePath;
        }
        console.log("apply code from chat", filePath ? `to ${filePath}` : "to active editor");
        try {
            let document;
            let selection;
            let editor = vscode.window.activeTextEditor;
            if (filePath) {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders) {
                    const rootPath = workspaceFolders[0].uri.fsPath;
                    let cleanPath = filePath.trim();
                    if (cleanPath.startsWith('/') || cleanPath.startsWith('\\')) {
                        cleanPath = cleanPath.substring(1);
                    }
                    const fullPath = path.join(rootPath, cleanPath);
                    if (fs.existsSync(fullPath)) {
                        document = await vscode.workspace.openTextDocument(fullPath);
                    }
                    else {
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
                    newText = originalText.substring(0, startOffset) +
                        code +
                        originalText.substring(endOffset);
                }
                else if (filePath) {
                    newText = code;
                }
                else {
                    // Chat Mode (no file path) and no selection -> Append or Replace?
                    // Usually chat mode without selection assumes replacement or new content?
                    // Let's stick to replacing everything if no selection, OR warn user.
                    // But for safety, let's just use the code as is for the diff.
                    newText = code;
                }
                const tempDir = os.tmpdir();
                const fileName = path.basename(document.fileName);
                const tempFilePath = path.join(tempDir, `vico_diff_${Date.now()}_${fileName}`);
                fs.writeFileSync(tempFilePath, newText);
                const tempUri = vscode.Uri.file(tempFilePath);
                const originalUri = document.uri;
                await vscode.commands.executeCommand('vscode.diff', originalUri, tempUri, `${fileName} ↔ Proposed Changes`);
                // Show confirmation dialog
                const choice = await vscode.window.showInformationMessage(`Review changes for ${fileName}. Do you want to apply these changes?`, 'Apply Changes', 'Discard');
                if (choice === 'Apply Changes') {
                    // Apply changes to the original file
                    fs.writeFileSync(document.fileName, newText);
                    // Close the diff editor (optional, but good for UX)
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    // Show success message
                    vscode.window.showInformationMessage(`Changes applied to ${fileName}`);
                    // Open the updated file
                    const doc = await vscode.workspace.openTextDocument(document.fileName);
                    await vscode.window.showTextDocument(doc);
                }
                else {
                    // Discard - maybe delete temp file?
                    // fs.unlinkSync(tempFilePath); // Optional: cleanup
                    vscode.window.showInformationMessage('Changes discarded.');
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                }
            }
            else {
                vscode.window.showErrorMessage('No active editor or file found to apply code.');
            }
        }
        catch (err) {
            console.error('Failed to open diff:', err);
            vscode.window.showErrorMessage('Failed to open diff view.');
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('vibe-coding.fetchSuggestions', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            fetchSuggestions(context, editor);
        }
        else {
            vscode.window.showInformationMessage("No active text editor found.");
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('vibe-coding.triggerCompletion', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const currentLine = editor.selection.active.line;
            // Lakukan edit untuk menambahkan newline di posisi kursor
            editor.edit(editBuilder => {
                // Sisipkan newline di posisi kursor
                editBuilder.insert(editor.selection.active, '\n');
            }).then(() => {
                const currentLineText = editor.document.lineAt(currentLine).text;
                // Cek apakah baris sebelumnya adalah komentar
                if (/^\s*(\/\/|\/\*|\*|#|<!--)/.test(currentLineText)) {
                    console.log("code completion generate..");
                    // Jika baris sebelumnya adalah komentar, jalankan logika triggerCodeCompletion
                    const allCode = editor.document.getText(); // Dapatkan seluruh kode dari editor
                    let coding = currentLineText + '\n'; // Tambahkan baris sebelumnya ke coding
                    // Panggil fungsi untuk membersihkan comment dan trigger completion
                    const cleanCode = removeCommentTags(coding);
                    triggerCodeCompletion(context, cleanCode, allCode);
                }
            });
        }
    }));
}
function onUserInput(line) {
    // Simpan line ke riwayat
    console.log(line);
}
function removeCommentTags(code) {
    return code
        .replace(/\/\/(.*)$/gm, '$1') // Menghapus // dan menyimpan teks setelahnya
        .replace(/\/\*[\s\S]*?\*\//g, '') // Menghapus komentar multi-baris
        .replace(/#(.*)$/gm, '$1') // Menghapus # dan menyimpan teks setelahnya
        .replace(/<!--(.*?)-->/g, '$1') // Menghapus komentar HTML
        .replace(/\n\s*\n/g, '\n') // Menghapus baris kosong yang tersisa
        .trim(); // Menghapus spasi di awal dan akhir
}
async function triggerCodeCompletion(context, comment, allCode) {
    const allCodeData = "```" + allCode + "```";
    // Logika untuk generate suggestion berdasarkan lineContent
    const token = context.globalState.get('token');
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const body = {
            userId: 'vscode-user', // Ganti dengan ID pengguna yang sesuai,
            token: token,
            message: `The full code is:\n${allCode}\n\n` +
                `The user is currently typing this line: "${comment}".\n` +
                `Continue this line naturally. Do NOT repeat existing text, and do NOT add braces, semicolons, or syntax that already exists later in the file.`,
        };
        // Buat StatusBarItem untuk loading
        loadingStatusBarItem.text = "🔄 Vibe Coding loading...";
        loadingStatusBarItem.show();
        try {
            const response = await fetch('http://localhost:13100/api/suggest', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            // Cek apakah response berhasil
            if (!response.ok) {
                const errorMessage = await response.text();
                throw new Error(`Error ${response.status}: ${errorMessage}`);
            }
            // Jika berhasil, ambil data
            const coding = await response.json();
            // Menambahkan hasil sementara ke editor
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const currentLine = editor.selection.active.line;
                // Tampilkan pesan instruksi
                const instructionMessage = "Accept code from Vibe Coding...";
                vscode.window.showInformationMessage(instructionMessage, { modal: true }, "Accept Code", "Decline").then(selection => {
                    if (selection === "Accept Code") {
                        // Jika pengguna memilih 'Terima Kode'
                        editor.edit(editBuilder => {
                            // Hapus pesan instruksi jika ada
                            const instructionStartPosition = new vscode.Position(currentLine, 0);
                            const instructionEndPosition = new vscode.Position(currentLine + 1, 0);
                            editBuilder.delete(new vscode.Range(instructionStartPosition, instructionEndPosition));
                            // Sisipkan hasil code completion
                            editBuilder.insert(new vscode.Position(currentLine, 0), `${coding.message}\n`);
                        });
                    }
                    else if (selection === "Decline") {
                        // Jika pengguna memilih 'Tolak Kode', lakukan sesuatu jika perlu
                        console.log("Kode ditolak.");
                    }
                });
            }
        }
        catch (error) {
            console.error(error);
        }
        finally {
            // Sembunyikan StatusBarItem loading setelah selesai
            loadingStatusBarItem.hide();
        }
    }
}
//implementasi disini
// This method is called when your extension is deactivated
function deactivate() { }
//# sourceMappingURL=extension.js.map