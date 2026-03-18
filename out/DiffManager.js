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
const path = __importStar(require("path"));
const inlineDiff_1 = require("./inlineDiff");
class DiffManager {
    static instance;
    static originalScheme = "vico-original";
    static storageKey = "vico.pendingDiffs";
    pendingDiffs = new Map();
    codeLensEmitter = new vscode.EventEmitter();
    contentEmitter = new vscode.EventEmitter();
    pendingChangesEmitter = new vscode.EventEmitter();
    addIconPath;
    modifyIconPath;
    deleteIconPath;
    addedDecoration;
    modifiedDecoration;
    deletedDecoration;
    reviewStatusBarItem;
    context;
    onDidChangeCodeLenses = this.codeLensEmitter.event;
    onDidChangePendingChanges = this.pendingChangesEmitter.event;
    constructor(context) {
        this.context = context;
        this.addIconPath = vscode.Uri.file(path.join(context.extensionPath, "media", "diff-add.svg"));
        this.modifyIconPath = vscode.Uri.file(path.join(context.extensionPath, "media", "diff-modify.svg"));
        this.deleteIconPath = vscode.Uri.file(path.join(context.extensionPath, "media", "diff-delete.svg"));
        this.addedDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: "rgba(46, 160, 67, 0.14)",
            borderWidth: "0 0 0 3px",
            borderStyle: "solid",
            borderColor: "rgba(46, 160, 67, 0.55)",
            gutterIconPath: this.addIconPath,
            gutterIconSize: "65%",
            overviewRulerColor: "rgba(46, 160, 67, 0.75)",
            overviewRulerLane: vscode.OverviewRulerLane.Left,
        });
        this.modifiedDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: "rgba(210, 153, 34, 0.14)",
            borderWidth: "0 0 0 3px",
            borderStyle: "solid",
            borderColor: "rgba(210, 153, 34, 0.58)",
            gutterIconPath: this.modifyIconPath,
            gutterIconSize: "65%",
            overviewRulerColor: "rgba(210, 153, 34, 0.8)",
            overviewRulerLane: vscode.OverviewRulerLane.Left,
        });
        this.deletedDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: "rgba(248, 81, 73, 0.09)",
            borderWidth: "0 0 0 3px",
            borderStyle: "solid",
            borderColor: "rgba(248, 81, 73, 0.58)",
            gutterIconPath: this.deleteIconPath,
            gutterIconSize: "65%",
            overviewRulerColor: "rgba(248, 81, 73, 0.8)",
            overviewRulerLane: vscode.OverviewRulerLane.Left,
        });
        this.reviewStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        this.reviewStatusBarItem.name = "Vico Review Status";
        this.reviewStatusBarItem.command = "vibe-coding.showPendingChanges";
        context.subscriptions.push(this.codeLensEmitter, this.contentEmitter, this.pendingChangesEmitter, this.addedDecoration, this.modifiedDecoration, this.deletedDecoration, this.reviewStatusBarItem, vscode.commands.registerCommand("vibe-coding.acceptDiff", (uri) => this.acceptDiff(uri)), vscode.commands.registerCommand("vibe-coding.rejectDiff", (uri) => this.rejectDiff(uri)), vscode.commands.registerCommand("vibe-coding.acceptDiffHunk", (uri, hunkIndex) => this.acceptDiffHunk(uri, hunkIndex)), vscode.commands.registerCommand("vibe-coding.rejectDiffHunk", (uri, hunkIndex) => this.rejectDiffHunk(uri, hunkIndex)), vscode.commands.registerCommand("vibe-coding.openPendingDiff", (uri) => this.openPendingDiff(uri)), vscode.commands.registerCommand("vibe-coding.showPendingChanges", () => this.showPendingChanges()), vscode.commands.registerCommand("vibe-coding.nextDiffHunk", () => this.navigateDiffHunk("next")), vscode.commands.registerCommand("vibe-coding.previousDiffHunk", () => this.navigateDiffHunk("previous")), vscode.window.onDidChangeActiveTextEditor((editor) => this.handleEditorStateChange(editor)), vscode.window.onDidChangeVisibleTextEditors((editors) => this.renderVisibleEditors(editors)), vscode.workspace.onDidChangeTextDocument((event) => {
            const entry = this.pendingDiffs.get(event.document.uri.toString());
            if (entry) {
                entry.currentContent = event.document.getText();
                this.pendingDiffs.set(event.document.uri.toString(), entry);
                void this.savePendingDiffs();
                this.refreshFile(event.document.uri);
            }
        }), vscode.languages.registerCodeLensProvider({ scheme: "file" }, this), vscode.workspace.registerTextDocumentContentProvider(DiffManager.originalScheme, this));
        void this.restorePendingDiffs();
    }
    static getInstance(context) {
        if (!DiffManager.instance) {
            DiffManager.instance = new DiffManager(context);
        }
        return DiffManager.instance;
    }
    async openDiff(fileUri, newContent) {
        try {
            let oldContent = "";
            let fileExists = false;
            try {
                const uint8array = await vscode.workspace.fs.readFile(fileUri);
                oldContent = Buffer.from(uint8array).toString("utf8");
                fileExists = true;
            }
            catch {
                // File does not exist yet.
            }
            const existingEntry = this.pendingDiffs.get(fileUri.toString());
            const originalContentToKeep = existingEntry
                ? existingEntry.originalContent
                : oldContent;
            const originalExistsToKeep = existingEntry
                ? existingEntry.originalExists
                : fileExists;
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(newContent, "utf8"));
            this.pendingDiffs.set(fileUri.toString(), {
                originalUri: fileUri,
                originalContent: originalContentToKeep,
                currentContent: newContent,
                originalExists: originalExistsToKeep,
            });
            await this.savePendingDiffs();
            const document = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(document, {
                preview: false,
                preserveFocus: false,
                viewColumn: vscode.ViewColumn.Active,
            });
            this.refreshFile(fileUri);
            return {
                success: true,
                originalContent: originalExistsToKeep ? originalContentToKeep : null,
            };
        }
        catch (err) {
            vscode.window.showErrorMessage("Failed to write file: " + (err.message || err.toString()));
            return { success: false, originalContent: null };
        }
    }
    async acceptFile(fileUri) {
        const entry = this.pendingDiffs.get(fileUri.toString());
        if (!entry) {
            return;
        }
        this.cleanup(entry);
    }
    provideTextDocumentContent(uri) {
        const originalUri = this.decodeOriginalUri(uri);
        if (!originalUri) {
            return "";
        }
        return this.pendingDiffs.get(originalUri.toString())?.originalContent ?? "";
    }
    getPendingChangesSummary() {
        return [...this.pendingDiffs.values()]
            .map((entry) => {
            const hunks = (0, inlineDiff_1.computeInlineDiffHunks)(entry.originalContent, entry.currentContent);
            return {
                uri: entry.originalUri,
                relativePath: vscode.workspace.asRelativePath(entry.originalUri),
                hunkCount: hunks.length,
                preview: hunks[0] ? this.createHunkBadgeText(hunks[0]) : "No visible changes",
            };
        })
            .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    }
    getPendingHunks(uri) {
        const entry = this.pendingDiffs.get(uri.toString());
        if (!entry) {
            return [];
        }
        return (0, inlineDiff_1.computeInlineDiffHunks)(entry.originalContent, entry.currentContent).map((hunk, index) => ({
            uri,
            hunkIndex: index,
            label: `Hunk ${index + 1}`,
            description: this.createHunkBadgeText(hunk),
        }));
    }
    provideCodeLenses(document) {
        const entry = this.pendingDiffs.get(document.uri.toString());
        if (!entry) {
            return [];
        }
        const topOfFile = new vscode.Range(0, 0, 0, 0);
        const codeLenses = [
            new vscode.CodeLens(topOfFile, {
                command: "vibe-coding.acceptDiff",
                title: "$(check) Accept Vico Changes",
                arguments: [document.uri],
            }),
            new vscode.CodeLens(topOfFile, {
                command: "vibe-coding.rejectDiff",
                title: "$(close) Reject Vico Changes",
                arguments: [document.uri],
            }),
            new vscode.CodeLens(topOfFile, {
                command: "vibe-coding.openPendingDiff",
                title: "$(diff) Open Full Diff",
                arguments: [document.uri],
            }),
            new vscode.CodeLens(topOfFile, {
                command: "vibe-coding.previousDiffHunk",
                title: "$(arrow-up) Previous Change",
            }),
            new vscode.CodeLens(topOfFile, {
                command: "vibe-coding.nextDiffHunk",
                title: "$(arrow-down) Next Change",
            }),
        ];
        const hunks = (0, inlineDiff_1.computeInlineDiffHunks)(entry.originalContent, entry.currentContent);
        hunks.forEach((hunk, index) => {
            const anchorLine = this.getHunkAnchorLine(document, hunk);
            const anchorRange = new vscode.Range(anchorLine, 0, anchorLine, 0);
            codeLenses.push(new vscode.CodeLens(anchorRange, {
                command: "vibe-coding.acceptDiffHunk",
                title: "$(check) Accept This Hunk",
                arguments: [document.uri, index],
            }), new vscode.CodeLens(anchorRange, {
                command: "vibe-coding.rejectDiffHunk",
                title: "$(close) Reject This Hunk",
                arguments: [document.uri, index],
            }));
        });
        return codeLenses;
    }
    handleEditorStateChange(editor) {
        if (editor) {
            this.applyDecorations(editor);
        }
        this.updateContext(editor);
    }
    renderVisibleEditors(editors) {
        for (const editor of editors) {
            this.applyDecorations(editor);
        }
        this.updateContext(vscode.window.activeTextEditor);
    }
    updateContext(editor) {
        const isVicoDiff = Boolean(editor && this.pendingDiffs.has(editor.document.uri.toString()));
        void vscode.commands.executeCommand("setContext", "vibe-coding.isVicoDiff", isVicoDiff);
        this.updateStatusBar(editor?.document.uri);
    }
    refreshFile(fileUri) {
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() === fileUri.toString()) {
                this.applyDecorations(editor);
            }
        }
        this.updateContext(vscode.window.activeTextEditor);
        this.contentEmitter.fire(this.createOriginalContentUri(fileUri));
        this.codeLensEmitter.fire();
        this.pendingChangesEmitter.fire();
    }
    updateStatusBar(activeUri) {
        const fileCount = this.pendingDiffs.size;
        if (fileCount === 0) {
            this.reviewStatusBarItem.hide();
            return;
        }
        let hunkCount = 0;
        for (const entry of this.pendingDiffs.values()) {
            hunkCount += (0, inlineDiff_1.computeInlineDiffHunks)(entry.originalContent, entry.currentContent).length;
        }
        const activeEntry = activeUri
            ? this.pendingDiffs.get(activeUri.toString())
            : undefined;
        const activeLabel = activeUri
            ? path.basename(activeUri.fsPath || activeUri.path)
            : undefined;
        this.reviewStatusBarItem.text =
            `$(diff) Vico ${fileCount} file${fileCount === 1 ? "" : "s"} • ${hunkCount} change${hunkCount === 1 ? "" : "s"}`;
        this.reviewStatusBarItem.tooltip = activeEntry
            ? `Pending Vico review for ${activeLabel}. Click to open the full diff.`
            : "Pending Vico changes are waiting for review. Click to open the full diff.";
        this.reviewStatusBarItem.show();
    }
    applyDecorations(editor) {
        const entry = this.pendingDiffs.get(editor.document.uri.toString());
        if (!entry) {
            editor.setDecorations(this.addedDecoration, []);
            editor.setDecorations(this.modifiedDecoration, []);
            editor.setDecorations(this.deletedDecoration, []);
            return;
        }
        const hunks = (0, inlineDiff_1.computeInlineDiffHunks)(entry.originalContent, entry.currentContent);
        const addedOptions = [];
        const modifiedOptions = [];
        const deletedOptions = [];
        for (const hunk of hunks) {
            const option = this.createDecorationOption(editor.document, hunk);
            if (!option) {
                continue;
            }
            if (hunk.kind === "add") {
                addedOptions.push(option);
            }
            else if (hunk.kind === "modify") {
                modifiedOptions.push(option);
            }
            else {
                deletedOptions.push(option);
            }
        }
        editor.setDecorations(this.addedDecoration, addedOptions);
        editor.setDecorations(this.modifiedDecoration, modifiedOptions);
        editor.setDecorations(this.deletedDecoration, deletedOptions);
    }
    createDecorationOption(document, hunk) {
        const lineCount = Math.max(document.lineCount, 1);
        if (hunk.kind === "delete") {
            const anchorLine = Math.min(hunk.modifiedStart, lineCount - 1);
            const anchorRange = document.lineAt(anchorLine).range;
            const deletedPreview = this.truncateLine(this.createDeletedPreviewText(hunk));
            return {
                range: anchorRange,
                hoverMessage: this.createHoverMessage(document.languageId, hunk),
                renderOptions: {
                    after: {
                        margin: "0 0 0 1rem",
                        color: new vscode.ThemeColor("editorCodeLens.foreground"),
                        backgroundColor: new vscode.ThemeColor("editor.wordHighlightStrongBackground"),
                        textDecoration: "line-through",
                        contentText: deletedPreview
                            ? `Deleted: ${deletedPreview}`
                            : this.createHunkBadgeText(hunk),
                    },
                },
            };
        }
        const startLine = Math.min(hunk.modifiedStart, lineCount - 1);
        const endLine = Math.min(Math.max(hunk.modifiedEnd - 1, hunk.modifiedStart), lineCount - 1);
        return {
            range: new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).range.end.character),
            hoverMessage: this.createHoverMessage(document.languageId, hunk),
            renderOptions: {
                after: {
                    margin: "0 0 0 1rem",
                    color: new vscode.ThemeColor("descriptionForeground"),
                    contentText: this.createHunkBadgeText(hunk),
                },
            },
        };
    }
    getHunkAnchorLine(document, hunk) {
        const lineCount = Math.max(document.lineCount, 1);
        if (hunk.kind === "delete") {
            return Math.min(hunk.modifiedStart, lineCount - 1);
        }
        return Math.min(hunk.modifiedStart, lineCount - 1);
    }
    createHoverMessage(languageId, hunk) {
        const message = new vscode.MarkdownString(undefined, true);
        message.isTrusted = false;
        message.supportThemeIcons = true;
        message.appendMarkdown(`**Vico ${hunk.kind} change**\n\n`);
        if (hunk.originalLines.length > 0) {
            message.appendMarkdown("Before:\n");
            message.appendCodeblock(this.limitPreview(hunk.originalLines), languageId);
        }
        if (hunk.modifiedLines.length > 0) {
            if (hunk.originalLines.length > 0) {
                message.appendMarkdown("\n");
            }
            message.appendMarkdown("After:\n");
            message.appendCodeblock(this.limitPreview(hunk.modifiedLines), languageId);
        }
        message.appendMarkdown("\nUse the file actions above to accept or reject these Vico changes.");
        return message;
    }
    createHunkBadgeText(hunk) {
        const lineCount = hunk.kind === "delete" ? hunk.originalLines.length : hunk.modifiedLines.length;
        const prefix = hunk.kind === "add" ? "+" : hunk.kind === "delete" ? "-" : "~";
        const label = hunk.kind === "add"
            ? "added"
            : hunk.kind === "delete"
                ? "removed"
                : "updated";
        const previewSource = hunk.kind === "delete" ? hunk.originalLines : hunk.modifiedLines;
        const preview = this.truncateLine(hunk.kind === "delete"
            ? this.createDeletedPreviewText(hunk)
            : previewSource.find((line) => line.trim().length > 0) ?? "");
        return preview
            ? `Vico ${prefix} ${lineCount} line${lineCount === 1 ? "" : "s"} ${label}: ${preview}`
            : `Vico ${prefix} ${lineCount} line${lineCount === 1 ? "" : "s"} ${label}`;
    }
    limitPreview(lines) {
        const previewLines = lines.slice(0, 20);
        const preview = previewLines.join("\n");
        return lines.length > 20 ? `${preview}\n...` : preview;
    }
    createDeletedPreviewText(hunk) {
        const lines = hunk.originalLines
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .slice(0, 3);
        return lines.join(" ⏎ ");
    }
    resolveTargetUri(uri) {
        if (uri) {
            return uri;
        }
        return vscode.window.activeTextEditor?.document.uri;
    }
    truncateLine(line) {
        const compact = line.replace(/\s+/g, " ").trim();
        if (compact.length <= 72) {
            return compact;
        }
        return `${compact.slice(0, 69)}...`;
    }
    createOriginalContentUri(fileUri) {
        return vscode.Uri.from({
            scheme: DiffManager.originalScheme,
            path: fileUri.path,
            query: encodeURIComponent(fileUri.toString()),
        });
    }
    decodeOriginalUri(uri) {
        try {
            return vscode.Uri.parse(decodeURIComponent(uri.query));
        }
        catch {
            return undefined;
        }
    }
    async acceptDiff(uri) {
        const targetUri = this.resolveTargetUri(uri);
        if (!targetUri) {
            return;
        }
        const entry = this.pendingDiffs.get(targetUri.toString());
        if (!entry) {
            return;
        }
        const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === targetUri.toString());
        if (document?.isDirty) {
            await document.save();
        }
        this.cleanup(entry);
        vscode.window.showInformationMessage("Changes kept.");
    }
    async rejectDiff(uri) {
        const targetUri = this.resolveTargetUri(uri);
        if (!targetUri) {
            return;
        }
        const entry = this.pendingDiffs.get(targetUri.toString());
        if (!entry) {
            return;
        }
        try {
            if (entry.originalExists) {
                await vscode.workspace.fs.writeFile(entry.originalUri, Buffer.from(entry.originalContent, "utf8"));
            }
            else {
                await vscode.workspace.fs.delete(entry.originalUri, { useTrash: false });
            }
            vscode.window.showInformationMessage("Changes discarded.");
        }
        catch {
            vscode.window.showErrorMessage("Failed to revert changes.");
            return;
        }
        this.cleanup(entry);
    }
    async openPendingDiff(uri) {
        const targetUri = this.resolveTargetUri(uri);
        if (!targetUri) {
            return;
        }
        const entry = this.pendingDiffs.get(targetUri.toString());
        if (!entry) {
            return;
        }
        const originalContentUri = this.createOriginalContentUri(targetUri);
        const label = `${targetUri.path.split("/").pop() || "file"} (Original ↔ Current)`;
        await vscode.commands.executeCommand("vscode.diff", originalContentUri, targetUri, label, {
            preview: false,
            viewColumn: vscode.ViewColumn.Beside,
        });
    }
    async showPendingChanges() {
        if (this.pendingDiffs.size === 0) {
            vscode.window.showInformationMessage("No pending Vico changes.");
            return;
        }
        const items = [...this.pendingDiffs.values()].map((entry) => {
            const hunks = (0, inlineDiff_1.computeInlineDiffHunks)(entry.originalContent, entry.currentContent);
            const label = path.basename(entry.originalUri.fsPath || entry.originalUri.path);
            const description = vscode.workspace.asRelativePath(entry.originalUri);
            const detail = hunks.length > 0
                ? `${hunks.length} pending change${hunks.length === 1 ? "" : "s"}`
                : "No visible changes";
            return {
                label,
                description,
                detail,
                uri: entry.originalUri,
                hunkCount: hunks.length,
            };
        });
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: "Select a file with pending Vico changes",
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!selected) {
            return;
        }
        const document = await vscode.workspace.openTextDocument(selected.uri);
        await vscode.window.showTextDocument(document, {
            preview: false,
            preserveFocus: false,
            viewColumn: vscode.ViewColumn.Active,
        });
        if (selected.hunkCount > 0) {
            await this.navigateDiffHunk("next");
        }
    }
    async acceptDiffHunk(uri, hunkIndex) {
        const entry = this.pendingDiffs.get(uri.toString());
        if (!entry) {
            return;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        entry.currentContent = document.getText();
        const hunks = (0, inlineDiff_1.computeInlineDiffHunks)(entry.originalContent, entry.currentContent);
        const hunk = hunks[hunkIndex];
        if (!hunk) {
            return;
        }
        entry.originalContent = (0, inlineDiff_1.acceptInlineDiffHunk)(entry.originalContent, entry.currentContent, hunk);
        this.pendingDiffs.set(uri.toString(), entry);
        await this.savePendingDiffs();
        this.refreshFile(uri);
    }
    async rejectDiffHunk(uri, hunkIndex) {
        const entry = this.pendingDiffs.get(uri.toString());
        if (!entry) {
            return;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        entry.currentContent = document.getText();
        const hunks = (0, inlineDiff_1.computeInlineDiffHunks)(entry.originalContent, entry.currentContent);
        const hunk = hunks[hunkIndex];
        if (!hunk) {
            return;
        }
        const revertedContent = (0, inlineDiff_1.rejectInlineDiffHunk)(entry.originalContent, entry.currentContent, hunk);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(revertedContent, "utf8"));
        entry.currentContent = revertedContent;
        this.pendingDiffs.set(uri.toString(), entry);
        const remainingHunks = (0, inlineDiff_1.computeInlineDiffHunks)(entry.originalContent, revertedContent);
        if (remainingHunks.length === 0) {
            this.cleanup(entry);
            return;
        }
        await this.savePendingDiffs();
        this.refreshFile(uri);
    }
    cleanup(entry) {
        this.pendingDiffs.delete(entry.originalUri.toString());
        void this.savePendingDiffs();
        this.refreshFile(entry.originalUri);
    }
    async savePendingDiffs() {
        const persisted = [...this.pendingDiffs.values()].map((entry) => ({
            uri: entry.originalUri.toString(),
            originalContent: entry.originalContent,
            currentContent: entry.currentContent,
            originalExists: entry.originalExists,
        }));
        await this.context.workspaceState.update(DiffManager.storageKey, persisted);
        this.updateStatusBar(vscode.window.activeTextEditor?.document.uri);
    }
    async restorePendingDiffs() {
        const persisted = this.context.workspaceState.get(DiffManager.storageKey) || [];
        for (const entry of persisted) {
            try {
                const uri = vscode.Uri.parse(entry.uri);
                this.pendingDiffs.set(uri.toString(), {
                    originalUri: uri,
                    originalContent: entry.originalContent,
                    currentContent: entry.currentContent ?? entry.originalContent,
                    originalExists: entry.originalExists,
                });
            }
            catch {
                // Ignore malformed persisted entries.
            }
        }
        for (const editor of vscode.window.visibleTextEditors) {
            this.applyDecorations(editor);
        }
        this.updateContext(vscode.window.activeTextEditor);
        this.codeLensEmitter.fire();
        this.updateStatusBar(vscode.window.activeTextEditor?.document.uri);
    }
    async navigateDiffHunk(direction) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const entry = this.pendingDiffs.get(editor.document.uri.toString());
        if (!entry) {
            return;
        }
        const hunks = (0, inlineDiff_1.computeInlineDiffHunks)(entry.originalContent, entry.currentContent);
        if (hunks.length === 0) {
            return;
        }
        const currentLine = editor.selection.active.line;
        const lineTargets = hunks.map((hunk) => this.getHunkAnchorLine(editor.document, hunk));
        let targetIndex = -1;
        if (direction === "next") {
            targetIndex = lineTargets.findIndex((line) => line > currentLine);
            if (targetIndex === -1) {
                targetIndex = 0;
            }
        }
        else {
            for (let i = lineTargets.length - 1; i >= 0; i--) {
                if (lineTargets[i] < currentLine) {
                    targetIndex = i;
                    break;
                }
            }
            if (targetIndex === -1) {
                targetIndex = lineTargets.length - 1;
            }
        }
        const targetLine = lineTargets[targetIndex];
        const position = new vscode.Position(targetLine, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
}
exports.DiffManager = DiffManager;
//# sourceMappingURL=DiffManager.js.map