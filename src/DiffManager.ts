import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

interface DiffEntry {
  originalUri: vscode.Uri;
  tempUri: vscode.Uri;
  tempFilePath: string;
  originalContent: string;
}

export class DiffManager {
  private static instance: DiffManager;
  private pendingDiffs = new Map<string, DiffEntry>();
  private context: vscode.ExtensionContext;

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;

    // Register commands
    context.subscriptions.push(
      vscode.commands.registerCommand("vibe-coding.acceptDiff", () =>
        this.acceptDiff(),
      ),
      vscode.commands.registerCommand("vibe-coding.rejectDiff", () =>
        this.rejectDiff(),
      ),
    );

    // Register event listener
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        this.updateContext(editor),
      ),
    );
  }

  public static getInstance(context: vscode.ExtensionContext): DiffManager {
    if (!DiffManager.instance) {
      DiffManager.instance = new DiffManager(context);
    }
    return DiffManager.instance;
  }

  private updateContext(editor: vscode.TextEditor | undefined) {
    if (!editor) {
      vscode.commands.executeCommand(
        "setContext",
        "vibe-coding.isVicoDiff",
        false,
      );
      return;
    }
    const uri = editor.document.uri.toString();
    const isVicoDiff = [...this.pendingDiffs.values()].some(
      (d) => d.originalUri.toString() === uri || d.tempUri.toString() === uri,
    );
    vscode.commands.executeCommand(
      "setContext",
      "vibe-coding.isVicoDiff",
      isVicoDiff,
    );
  }

  public async openDiff(fileUri: vscode.Uri, newContent: string) {
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
      } catch (e) {
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
      const tempFilePath = path.join(
        tempDir,
        `vico_backup_${fileHash}_${fileName}`,
      );
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
      await vscode.commands.executeCommand(
        "vscode.diff",
        tempUri, // Left: Original / Backup
        fileUri, // Right: Current File (Modified)
        `${fileName} (Diff: Old ↔ New)`,
        {
          preview: false,
          viewColumn: vscode.ViewColumn.Active,
        },
      );

      // 6. Update Context
      this.updateContext(vscode.window.activeTextEditor);

      return true;
    } catch (err: any) {
      vscode.window.showErrorMessage(
        "Failed to write file: " + (err.message || err.toString()),
      );
      return false;
    }
  }

  public async acceptFile(fileUri: vscode.Uri) {
    const entry = this.findEntry(fileUri);
    if (entry) {
      this.cleanup(entry);
    }
  }

  private async acceptDiff() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const entry = this.findEntry(editor.document.uri);
    if (entry) {
      // Save original document if it's dirty (user edits in diff view)
      const originalDoc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === entry.originalUri.toString(),
      );
      if (originalDoc && originalDoc.isDirty) {
        await originalDoc.save();
      }

      // Close editor first to avoid file lock issues
      await vscode.commands.executeCommand(
        "workbench.action.closeActiveEditor",
      );

      // Cleanup
      this.cleanup(entry);
      vscode.window.showInformationMessage("Changes kept.");
    }
  }

  private async rejectDiff() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const entry = this.findEntry(editor.document.uri);
    if (entry) {
      // Revert changes
      try {
        await vscode.workspace.fs.writeFile(
          entry.originalUri,
          Buffer.from(entry.originalContent),
        );
        vscode.window.showInformationMessage("Changes discarded.");
      } catch (err) {
        vscode.window.showErrorMessage("Failed to revert changes.");
      }

      // Close editor first
      await vscode.commands.executeCommand(
        "workbench.action.closeActiveEditor",
      );

      this.cleanup(entry);
    }
  }

  private findEntry(uri: vscode.Uri): DiffEntry | undefined {
    const uriStr = uri.toString();
    return [...this.pendingDiffs.values()].find(
      (d) =>
        d.originalUri.toString() === uriStr || d.tempUri.toString() === uriStr,
    );
  }

  private cleanup(entry: DiffEntry) {
    this.pendingDiffs.delete(entry.originalUri.toString());
    try {
      if (fs.existsSync(entry.tempFilePath)) {
        fs.unlinkSync(entry.tempFilePath);
      }
    } catch (e) {
      console.error("Failed to delete temp file", e);
    }
    this.updateContext(vscode.window.activeTextEditor);
  }
}
