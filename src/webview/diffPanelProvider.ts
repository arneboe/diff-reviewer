import * as vscode from 'vscode';
import { DiffFile, FileRef, WebviewToExtMessage, diffFilePath, fileKey, fileKeyOf } from '../types';

interface FileData {
  file: DiffFile;
  fileContent: string[];
  highlightedLines: string[];
}

export class DiffPanelProvider {
  /** Track one panel per file (keyed by repoRoot + path) */
  private panels = new Map<string, vscode.WebviewPanel>();
  /** Pending data to send once the webview signals 'ready' */
  private pendingData = new Map<string, FileData>();
  /** Which file each open panel shows, keyed like `panels` */
  private refs = new Map<string, FileRef>();

  constructor(
    private extensionUri: vscode.Uri,
    private onMessage: (msg: WebviewToExtMessage) => void,
    private onPanelFocus?: (ref: FileRef) => void,
  ) {}

  showFile(file: DiffFile, fileContent: string[], highlightedLines: string[]): void {
    const filePath = file.newPath || file.oldPath;
    const key = fileKeyOf(file);
    const existing = this.panels.get(key);

    if (existing) {
      existing.reveal(vscode.ViewColumn.One);
      existing.webview.postMessage({
        command: 'showFile',
        file,
        fileContent,
        highlightedLines,
      });
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'diffReviewerView',
      `Diff: ${filePath.split('/').pop()}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'media'),
          vscode.Uri.joinPath(this.extensionUri, 'out'),
        ],
      },
    );

    panel.webview.html = this.getHtml(panel.webview);

    this.pendingData.set(key, { file, fileContent, highlightedLines });
    this.refs.set(key, { repoRoot: file.repoRoot, filePath: diffFilePath(file) });

    panel.webview.onDidReceiveMessage((msg: WebviewToExtMessage) => {
      if (msg.command === 'ready') {
        const pending = this.pendingData.get(key);
        if (pending) {
          panel.webview.postMessage({
            command: 'showFile',
            file: pending.file,
            fileContent: pending.fileContent,
            highlightedLines: pending.highlightedLines,
          });
          this.pendingData.delete(key);
        }
        return;
      }
      this.onMessage(msg);
    });

    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active && this.onPanelFocus) {
        this.onPanelFocus({ repoRoot: file.repoRoot, filePath });
      }
    });

    panel.onDidDispose(() => {
      this.panels.delete(key);
      this.pendingData.delete(key);
      this.refs.delete(key);
    });

    this.panels.set(key, panel);
  }

  /** Files currently shown in an open panel. */
  openRefs(): FileRef[] {
    return [...this.refs.values()];
  }

  refreshFile(file: DiffFile, fileContent: string[], highlightedLines: string[]): void {
    const panel = this.panels.get(fileKeyOf(file));
    if (panel) {
      panel.webview.postMessage({
        command: 'showFile',
        file,
        fileContent,
        highlightedLines,
      });
    }
  }

  closeFile(ref: FileRef): void {
    const panel = this.panels.get(fileKey(ref.repoRoot, ref.filePath));
    if (panel) {
      panel.dispose();
    }
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    this.pendingData.clear();
    this.refs.clear();
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.css'),
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Diff Reviewer</title>
</head>
<body>
  <div id="container"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
