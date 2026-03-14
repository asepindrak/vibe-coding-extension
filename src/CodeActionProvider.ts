import * as vscode from "vscode";

export class VicoCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // 1. Add "Send Code to Chat" if there's a selection
    if (!range.isEmpty) {
      actions.push(this.createSendCodeToChatAction(document, range));
    }

    // 2. Add Fix and Send To Chat if there are diagnostics
    if (context.diagnostics.length > 0) {
      // Filter to only include errors/warnings that intersect with the user's cursor/hover range
      const relevantDiagnostics = context.diagnostics.filter(
        (d) =>
          (d.severity === vscode.DiagnosticSeverity.Error ||
            d.severity === vscode.DiagnosticSeverity.Warning) &&
          (range.intersection(d.range) || d.range.contains(range))
      );

      if (relevantDiagnostics.length > 0) {
        // Sort by:
        // 1. Closest starting position to the user's cursor/hover point (offset-based)
        // 2. Smallest range size (most specific)
        relevantDiagnostics.sort((a, b) => {
          const cursorOffset = document.offsetAt(range.start);
          const startOffsetA = document.offsetAt(a.range.start);
          const startOffsetB = document.offsetAt(b.range.start);

          // Priority 1: Distance from the cursor to the start of the diagnostic
          const distA = Math.abs(startOffsetA - cursorOffset);
          const distB = Math.abs(startOffsetB - cursorOffset);

          if (distA !== distB) {
            return distA - distB;
          }

          // Priority 2: Smallest range size
          const sizeA = document.offsetAt(a.range.end) - startOffsetA;
          const sizeB = document.offsetAt(b.range.end) - startOffsetB;
          return sizeA - sizeB;
        });

        // Provide TWO actions: Vico Fix (Preferred) and Send To Chat
        actions.push(this.createFixAction(document, relevantDiagnostics));
        actions.push(this.createChatAction(document, relevantDiagnostics));
      }
    }

    return actions;
  }

  private createSendCodeToChatAction(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      "📝 Send Code to Chat",
      vscode.CodeActionKind.QuickFix
    );

    action.command = {
      command: "vico.sendCodeToChat",
      title: "Send Code to Chat",
      arguments: [document, range],
    };

    return action;
  }

  private createFixAction(
    document: vscode.TextDocument,
    diagnostics: vscode.Diagnostic[]
  ): vscode.CodeAction {
    // Use a shorter, more concise title similar to VS Code's built-in AI fix
    const action = new vscode.CodeAction(
      "✨ Vico Fix",
      vscode.CodeActionKind.QuickFix
    );

    // Pass ALL diagnostics to the command
    action.command = {
      command: "vico.aiFix",
      title: "Vico Fix",
      arguments: [document, diagnostics],
    };

    // Associate the action with all diagnostics it fixes
    action.diagnostics = diagnostics;
    action.isPreferred = true;

    return action;
  }

  private createChatAction(
    document: vscode.TextDocument,
    diagnostics: vscode.Diagnostic[]
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      "💬 Send To Chat",
      vscode.CodeActionKind.QuickFix
    );

    action.command = {
      command: "vico.sendToChat",
      title: "Send To Chat",
      arguments: [document, diagnostics],
    };

    action.diagnostics = diagnostics;

    return action;
  }
}
