import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

/** The chat panel. A placeholder from @codecoach/ui until stage 2. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "codecoach.chat";

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const distUri = vscode.Uri.joinPath(this.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    view.webview.html = renderHtml(view.webview, vscode.Uri.joinPath(distUri, "webview.js"));
  }
}

export function renderHtml(webview: vscode.Webview, scriptUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodeCoach</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${webview.asWebviewUri(scriptUri).toString()}"></script>
</body>
</html>`;
}
