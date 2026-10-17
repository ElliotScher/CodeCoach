import * as vscode from "vscode";

import { ChatViewProvider } from "./chatView.js";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider),
    vscode.commands.registerCommand("codecoach.openChat", () =>
      vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`),
    ),
  );
}

export function deactivate(): void {}
