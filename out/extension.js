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
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = __importStar(require("vscode"));
const SidebarProvider_1 = require("./SidebarProvider");
const path = __importStar(require("path"));
// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
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
async function fetchSuggestions(context, editor) {
    const currentLine = editor.selection.active.line;
    const lineText = editor.document.lineAt(currentLine).text;
    // Remove comments and prepare the input for the API
    const cleanedInput = removeCommentTags(lineText.trim());
    if (cleanedInput) {
        const allCode = editor.document.getText();
        const token = context.globalState.get('token'); // Get your token
        const filePath = editor.document.fileName;
        const fileName = path.basename(filePath); // Dapatkan nama file saja
        // Buat StatusBarItem untuk loading
        const loadingStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        loadingStatusBarItem.text = "🔄 Code Sugestion from Vibe Coding...";
        loadingStatusBarItem.show();
        console.log("Fetching suggestions for:", cleanedInput);
        const body = {
            userId: 'vscode-user',
            token: token,
            message: `The full code is:\n${allCode}\n\n` +
                `The user is currently typing this line: "${cleanedInput}".\n` +
                `Continue this line naturally. Do NOT repeat existing text, and do NOT add braces, semicolons, or syntax that already exists later in the file.`
        };
        try {
            const response = await fetch('http://103.250.10.249:5678/webhook/01fe259e-4cf2-438f-9d99-69ea451e55f7', {
                method: 'POST',
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
            const suggestions = await response.json();
            presentSuggestions(suggestions.message);
        }
        catch (error) {
            console.error('Error while fetching suggestions:', error);
        }
        finally {
            // Sembunyikan StatusBarItem loading setelah selesai
            loadingStatusBarItem.hide();
        }
    }
}
let lastSuggestion = null;
async function presentSuggestions(suggestion) {
    console.log("Presenting suggestion:", suggestion);
    if (suggestion && suggestion.trim().length > 0) {
        lastSuggestion = suggestion;
        // Beri jeda kecil agar state update
        await new Promise(resolve => setTimeout(resolve, 50));
        // Trigger autocomplete
        await vscode.commands.executeCommand('editor.action.triggerSuggest');
    }
    else {
        vscode.window.showInformationMessage("No suggestions available.");
    }
}
function activate(context) {
    vscode.languages.registerCompletionItemProvider({ scheme: 'file', language: "php" }, {
        provideCompletionItems(document, position, token, context) {
            // Jika tidak ada suggestion, return null (jangan error)
            if (!lastSuggestion || lastSuggestion.trim() === '') {
                return undefined;
            }
            // Ambil posisi kursor
            const linePrefix = document.lineAt(position).text.substr(0, position.character);
            // Buat completion item
            const item = new vscode.CompletionItem(lastSuggestion, vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(lastSuggestion);
            item.detail = 'AI Suggestion from Vibe Coding';
            item.sortText = '\u0000'; // Karakter null — paling awal dalam urutan Unicode
            item.filterText = lastSuggestion; // Opsional: kontrol pencarian
            item.command = {
                command: 'vibe-coding.clearSuggestion',
                title: ''
            };
            return [item];
        }
    }, '' // Trigger manual
    );
    vscode.languages.registerCompletionItemProvider({ scheme: 'file', language: "javascript" }, {
        provideCompletionItems(document, position, token, context) {
            // Jika tidak ada suggestion, return null (jangan error)
            if (!lastSuggestion || lastSuggestion.trim() === '') {
                return undefined;
            }
            // Ambil posisi kursor
            const linePrefix = document.lineAt(position).text.substr(0, position.character);
            // Buat completion item
            const item = new vscode.CompletionItem(lastSuggestion, vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(lastSuggestion);
            item.detail = 'AI Suggestion from Vibe Coding';
            item.command = {
                command: 'vibe-coding.clearSuggestion',
                title: ''
            };
            return [item];
        }
    }, '' // Trigger manual
    );
    vscode.languages.registerCompletionItemProvider({ scheme: 'file', language: "typescript" }, {
        provideCompletionItems(document, position, token, context) {
            // Jika tidak ada suggestion, return null (jangan error)
            if (!lastSuggestion || lastSuggestion.trim() === '') {
                return undefined;
            }
            // Ambil posisi kursor
            const linePrefix = document.lineAt(position).text.substr(0, position.character);
            // Buat completion item
            const item = new vscode.CompletionItem(lastSuggestion, vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(lastSuggestion);
            item.detail = 'AI Suggestion from Vibe Coding';
            item.command = {
                command: 'vibe-coding.clearSuggestion',
                title: ''
            };
            return [item];
        }
    }, '' // Trigger manual
    );
    vscode.languages.registerCompletionItemProvider({ scheme: 'file', language: "python" }, {
        provideCompletionItems(document, position, token, context) {
            // Jika tidak ada suggestion, return null (jangan error)
            if (!lastSuggestion || lastSuggestion.trim() === '') {
                return undefined;
            }
            // Ambil posisi kursor
            const linePrefix = document.lineAt(position).text.substr(0, position.character);
            // Buat completion item
            const item = new vscode.CompletionItem(lastSuggestion, vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(lastSuggestion);
            item.detail = 'AI Suggestion from Vibe Coding';
            item.command = {
                command: 'vibe-coding.clearSuggestion',
                title: ''
            };
            return [item];
        }
    }, '' // Trigger manual
    );
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
    // Trigger the updateWebview command when the active editor changes or the selection changes
    vscode.window.onDidChangeActiveTextEditor(() => {
        vscode.commands.executeCommand('vibe-coding.updateWebview');
    });
    vscode.window.onDidChangeTextEditorSelection(() => {
        vscode.commands.executeCommand('vibe-coding.updateWebview');
    });
    // Initial trigger to update the webview
    vscode.commands.executeCommand('vibe-coding.updateWebview');
    context.subscriptions.push(vscode.commands.registerCommand('vibe-coding.testSuggestion', () => {
        presentSuggestions("$nomor_kantor = mysqli_real_escape_string($conn, trim($_POST['nomor_kantor']));");
    }));
    context.subscriptions.push(vscode.commands.registerCommand('vibe-coding.applyCodeSelection', (code) => {
        const editor = vscode.window.activeTextEditor;
        console.log("apply code from chat");
        if (editor) {
            const selection = editor.selection;
            editor.edit(editBuilder => {
                // Ganti teks yang dipilih dengan kode baru
                editBuilder.replace(selection, code);
            }).then(() => {
                console.log('Code applied successfully!');
            }, (err) => {
                console.error('Failed to apply code:', err);
            });
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
        const loadingStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        loadingStatusBarItem.text = "🔄 Vibe Coding loading...";
        loadingStatusBarItem.show();
        try {
            const response = await fetch('http://103.250.10.249:5678/webhook/01fe259e-4cf2-438f-9d99-69ea451e55f7', {
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