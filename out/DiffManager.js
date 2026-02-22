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
exports.DiffManager = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
class DiffManager {
    static instance;
    pendingDiffs = new Map();
    context;
    constructor(context) {
        this.context = context;
        // Register commands
        context.subscriptions.push(vscode.commands.registerCommand("vibe-coding.acceptDiff", () => this.acceptDiff()), vscode.commands.registerCommand("vibe-coding.rejectDiff", () => this.rejectDiff()));
        // Register event listener
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => this.updateContext(editor)));
    }
    static getInstance(context) {
        if (!DiffManager.instance) {
            DiffManager.instance = new DiffManager(context);
        }
        return DiffManager.instance;
    }
    updateContext(editor) {
        if (!editor) {
            vscode.commands.executeCommand("setContext", "vibe-coding.isVicoDiff", false);
            return;
        }
        const uri = editor.document.uri.toString();
        const isVicoDiff = [...this.pendingDiffs.values()].some((d) => d.originalUri.toString() === uri || d.tempUri.toString() === uri);
        vscode.commands.executeCommand("setContext", "vibe-coding.isVicoDiff", isVicoDiff);
    }
    async openDiff(fileUri, newContent) {
        try {
            const tempDir = os.tmpdir();
            const fileName = path.basename(fileUri.fsPath);
            // 1. Get Existing Content (Old)
            let oldContent = "";
            let fileExists = false;
            try {
                const uint8array = await vscode.workspace.fs.readFile(fileUri);
                oldContent = Buffer.from(uint8array).toString("utf8");
                fileExists = true;
            }
            catch (e) {
                // File does not exist
            }
            // 2. Write NEW content to the actual file (Auto Apply)
            const data = Buffer.from(newContent, "utf8");
            await vscode.workspace.fs.writeFile(fileUri, data);
            // 3. Write OLD content to Temp (for Diff Left Side)
            // Use hash of file path to ensure only one diff tab per file
            const fileHash = crypto
                .createHash("md5")
                .update(fileUri.fsPath)
                .digest("hex");
            const tempFilePath = path.join(tempDir, `vico_backup_${fileHash}_${fileName}`);
            fs.writeFileSync(tempFilePath, oldContent);
            const tempUri = vscode.Uri.file(tempFilePath);
            // 4. Register in Map
            this.pendingDiffs.set(fileUri.toString(), {
                originalUri: fileUri,
                tempUri,
                tempFilePath,
                originalContent: oldContent,
            });
            // 5. Open Diff: Left (Old/Backup) <-> Right (Current/New)
            await vscode.commands.executeCommand("vscode.diff", tempUri, // Left: Original / Backup
            fileUri, // Right: Current File (Modified)
            `${fileName} (Diff: Old ↔ New)`, {
                preview: false,
                viewColumn: vscode.ViewColumn.Active,
            });
            // 6. Update Context
            this.updateContext(vscode.window.activeTextEditor);
            return { success: true, originalContent: fileExists ? oldContent : null };
        }
        catch (err) {
            vscode.window.showErrorMessage("Failed to write file: " + (err.message || err.toString()));
            return { success: false, originalContent: null };
        }
    }
    async acceptFile(fileUri) {
        const entry = this.findEntry(fileUri);
        if (entry) {
            this.cleanup(entry);
        }
    }
    async acceptDiff() {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const entry = this.findEntry(editor.document.uri);
        if (entry) {
            // Save original document if it's dirty (user edits in diff view)
            const originalDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === entry.originalUri.toString());
            if (originalDoc && originalDoc.isDirty) {
                await originalDoc.save();
            }
            // Close editor first to avoid file lock issues
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
            // Cleanup
            this.cleanup(entry);
            vscode.window.showInformationMessage("Changes kept.");
        }
    }
    async rejectDiff() {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const entry = this.findEntry(editor.document.uri);
        if (entry) {
            // Revert changes
            try {
                await vscode.workspace.fs.writeFile(entry.originalUri, Buffer.from(entry.originalContent));
                vscode.window.showInformationMessage("Changes discarded.");
            }
            catch (err) {
                vscode.window.showErrorMessage("Failed to revert changes.");
            }
            // Close editor first
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
            this.cleanup(entry);
        }
    }
    findEntry(uri) {
        const uriStr = uri.toString();
        return [...this.pendingDiffs.values()].find((d) => d.originalUri.toString() === uriStr || d.tempUri.toString() === uriStr);
    }
    cleanup(entry) {
        this.pendingDiffs.delete(entry.originalUri.toString());
        try {
            if (fs.existsSync(entry.tempFilePath)) {
                fs.unlinkSync(entry.tempFilePath);
            }
        }
        catch (e) {
            console.error("Failed to delete temp file", e);
        }
        this.updateContext(vscode.window.activeTextEditor);
    }
}
exports.DiffManager = DiffManager;
//# sourceMappingURL=DiffManager.js.map