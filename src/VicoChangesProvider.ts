import * as vscode from "vscode";
import {
  DiffManager,
  type PendingChangeSummary,
  type PendingHunkSummary,
} from "./DiffManager";

export class PendingChangeFileItem extends vscode.TreeItem {
  constructor(readonly change: PendingChangeSummary) {
    super(change.relativePath, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${change.hunkCount} change${change.hunkCount === 1 ? "" : "s"}`;
    this.tooltip = `${change.relativePath}\n${change.preview}`;
    this.contextValue = "vicoPendingChangeFile";
    this.command = {
      command: "vibe-coding.revealPendingChange",
      title: "Reveal Pending Change",
      arguments: [change.uri],
    };
    this.iconPath = new vscode.ThemeIcon("diff");
  }
}

export class PendingChangeHunkItem extends vscode.TreeItem {
  constructor(readonly hunk: PendingHunkSummary) {
    super(hunk.label, vscode.TreeItemCollapsibleState.None);
    this.description = hunk.description;
    this.tooltip = hunk.description;
    this.contextValue = "vicoPendingChangeHunk";
    this.command = {
      command: "vibe-coding.revealPendingChange",
      title: "Reveal Pending Change Hunk",
      arguments: [hunk.uri, hunk.hunkIndex],
    };
    this.iconPath = new vscode.ThemeIcon("circle-large-outline");
  }
}

export type VicoChangeTreeItem = PendingChangeFileItem | PendingChangeHunkItem;

export class VicoChangesProvider
  implements vscode.TreeDataProvider<VicoChangeTreeItem>
{
  private readonly treeEmitter = new vscode.EventEmitter<
    VicoChangeTreeItem | undefined | null | void
  >();

  readonly onDidChangeTreeData = this.treeEmitter.event;

  constructor(private readonly diffManager: DiffManager) {
    this.diffManager.onDidChangePendingChanges(() => this.refresh());
  }

  refresh() {
    this.treeEmitter.fire();
  }

  getTreeItem(element: VicoChangeTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: VicoChangeTreeItem): VicoChangeTreeItem[] {
    if (!element) {
      return this.diffManager
        .getPendingChangesSummary()
        .map((change) => new PendingChangeFileItem(change));
    }

    if (element instanceof PendingChangeFileItem) {
      return this.diffManager
        .getPendingHunks(element.change.uri)
        .map((hunk) => new PendingChangeHunkItem(hunk));
    }

    return [];
  }
}
