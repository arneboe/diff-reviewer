import { join } from 'path';
import * as vscode from 'vscode';
import { RepoManager } from './git/repoManager';
import { FileTreeProvider } from './sidebar/fileTreeProvider';
import { DiffPanelProvider } from './webview/diffPanelProvider';
import { StateManager } from './state/stateManager';
import { DiffFile, FileRef, HunkStatus, WebviewToExtMessage, diffFilePath } from './types';
import { highlightFileContent } from './highlighter';

const CONFIG_SECTION = 'diffReviewer';
const DEFAULT_SCAN_DEPTH = 10;

let repos: RepoManager;
let fileTreeProvider: FileTreeProvider;
let diffPanelProvider: DiffPanelProvider;
let stateManager: StateManager;

function getScanDepth(): number {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>('repoScanDepth', DEFAULT_SCAN_DEPTH);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_SCAN_DEPTH;
}

function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

/** Read file content + highlight, then send to webview. */
async function getFileData(
  file: DiffFile,
): Promise<{ fileContent: string[]; highlightedLines: string[] }> {
  const filePath = diffFilePath(file);
  const fileContent = await repos.getAdapter(file.repoRoot).getFileContent(filePath);
  const highlightedLines = highlightFileContent(filePath, fileContent);
  return { fileContent, highlightedLines };
}

function refOf(file: DiffFile): FileRef {
  return { repoRoot: file.repoRoot, filePath: diffFilePath(file) };
}

export async function activate(context: vscode.ExtensionContext) {
  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showErrorMessage('Diff Reviewer: No workspace folder open.');
    return;
  }

  repos = new RepoManager(workspaceFolderPaths(), getScanDepth());
  stateManager = new StateManager(repos, context.workspaceState);
  fileTreeProvider = new FileTreeProvider(repos, stateManager);

  // Sidebar tree view
  const treeView = vscode.window.createTreeView('diffReviewer.fileTree', {
    treeDataProvider: fileTreeProvider,
  });
  context.subscriptions.push(treeView);

  // Update badge and welcome-view context when tree data changes
  fileTreeProvider.onDidChangeTreeData(() => {
    const count = fileTreeProvider.getFiles().length;
    treeView.badge = count > 0 ? { value: count, tooltip: `${count} modified files` } : undefined;
    vscode.commands.executeCommand(
      'setContext',
      'diffReviewer.noRepos',
      fileTreeProvider.getRepoCount() === 0,
    );
  });

  // Webview panel provider
  diffPanelProvider = new DiffPanelProvider(
    context.extensionUri,
    handleWebviewMessage,
    handlePanelFocus,
  );
  context.subscriptions.push({ dispose: () => diffPanelProvider.dispose() });

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('diffReviewer.refresh', async () => {
      stateManager.clear();
      await fileTreeProvider.refresh();
    }),

    vscode.commands.registerCommand('diffReviewer.openFile', async (file: DiffFile) => {
      const statuses = stateManager.syncStatuses(file);
      const { fileContent, highlightedLines } = await getFileData(file);
      diffPanelProvider.showFile(file, statuses, fileContent, highlightedLines);
    }),

    vscode.commands.registerCommand('diffReviewer.approveFile', async (file: DiffFile) => {
      stateManager.syncStatuses(file);
      stateManager.approveAll(file);
      fileTreeProvider.refresh();
      await sendRefresh(file);
    }),

    vscode.commands.registerCommand('diffReviewer.rejectFile', async (file: DiffFile) => {
      stateManager.syncStatuses(file);
      try {
        const updatedFile = await stateManager.rejectAll(file);
        if (updatedFile) {
          await sendRefresh(updatedFile);
        } else {
          diffPanelProvider.closeFile(refOf(file));
        }
        await fileTreeProvider.refresh();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Reject all failed: ${message}`);
      }
    }),

    vscode.commands.registerCommand('diffReviewer.undo', async () => {
      const result = await stateManager.undo();
      if (!result) {
        vscode.window.showInformationMessage('Nothing to undo.');
        return;
      }

      if (result.undoneType === 'reject') {
        await refreshFilePanel(result);
      }

      await fileTreeProvider.refresh();

      if (result.undoneType === 'approve') {
        const file = fileTreeProvider.findFile(result.repoRoot, result.filePath);
        if (file) {
          await sendRefresh(file);
        }
      }
    }),
  );

  // Re-discover repos when the workspace or the scan depth changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      repos.setWorkspaceFolders(workspaceFolderPaths());
      await fileTreeProvider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.repoScanDepth`)) {
        repos.setMaxDepth(getScanDepth());
        await fileTreeProvider.refresh();
      }
    }),
  );

  // File system watcher with debounce for auto-refresh
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');

  const debouncedRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(async () => {
      await fileTreeProvider.refresh();
      stateManager.pruneCommittedFiles(fileTreeProvider.getFiles());
    }, 500);
  };

  watcher.onDidChange(debouncedRefresh);
  watcher.onDidCreate(debouncedRefresh);
  watcher.onDidDelete(debouncedRefresh);
  context.subscriptions.push(watcher);

  // Initial load
  fileTreeProvider.refresh();
}

async function handlePanelFocus(ref: FileRef): Promise<void> {
  await fileTreeProvider.refresh();
  const file = fileTreeProvider.findFile(ref.repoRoot, ref.filePath);
  if (file) {
    const statuses = stateManager.syncStatuses(file);
    await sendRefresh(file, statuses);
  }
}

async function sendRefresh(file: DiffFile, statuses?: HunkStatus[]): Promise<void> {
  const s = statuses || stateManager.getStatusArray(file);
  const { fileContent, highlightedLines } = await getFileData(file);
  diffPanelProvider.refreshFile(file, s, fileContent, highlightedLines);
}

async function handleWebviewMessage(msg: WebviewToExtMessage): Promise<void> {
  if (msg.command === 'ready') {
    return;
  }

  if (msg.command === 'openInEditor') {
    const fileUri = vscode.Uri.file(join(msg.repoRoot, msg.filePath));
    await vscode.window.showTextDocument(fileUri, { preview: false });
    return;
  }

  const file = fileTreeProvider.findFile(msg.repoRoot, msg.filePath);

  if (msg.command === 'approve') {
    const hunkId = file?.hunks[msg.hunkIndex]?.id;
    if (!file || !hunkId) {
      return;
    }
    stateManager.approve(file, hunkId);
    diffPanelProvider.updateHunk(msg, msg.hunkIndex, 'approved');
    fileTreeProvider.refresh();
    return;
  }

  if (msg.command === 'reject') {
    try {
      if (!file) {
        vscode.window.showErrorMessage(`File not found in diff: ${msg.filePath}`);
        return;
      }

      const hunkId = file.hunks[msg.hunkIndex]?.id;
      if (!hunkId) {
        vscode.window.showErrorMessage(`Hunk not found at index ${msg.hunkIndex}`);
        return;
      }
      const updatedFile = await stateManager.reject(file, hunkId);

      if (updatedFile) {
        await sendRefresh(updatedFile);
      } else {
        diffPanelProvider.closeFile(msg);
      }

      await fileTreeProvider.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Reject failed: ${message}`);
    }
    return;
  }

  if (msg.command === 'approveAll') {
    if (!file) {
      return;
    }

    stateManager.approveAll(file);
    await sendRefresh(file);
    fileTreeProvider.refresh();
    return;
  }

  if (msg.command === 'undo') {
    const hunkId = file?.hunks[msg.hunkIndex]?.id;
    if (!file || !hunkId) {
      return;
    }
    stateManager.undoApprove(file, hunkId);
    diffPanelProvider.updateHunk(msg, msg.hunkIndex, 'pending');
    fileTreeProvider.refresh();
    return;
  }

  if (msg.command === 'rejectAll') {
    if (!file) {
      return;
    }

    try {
      const updatedFile = await stateManager.rejectAll(file);
      if (updatedFile) {
        await sendRefresh(updatedFile);
      } else {
        diffPanelProvider.closeFile(msg);
      }
      await fileTreeProvider.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Reject all failed: ${message}`);
    }
  }
}

async function refreshFilePanel(ref: FileRef): Promise<void> {
  await fileTreeProvider.refresh();
  const file = fileTreeProvider.findFile(ref.repoRoot, ref.filePath);
  if (file) {
    const statuses = stateManager.syncStatuses(file);
    await sendRefresh(file, statuses);
  } else {
    diffPanelProvider.closeFile(ref);
  }
}

export function deactivate() {
  // Cleanup handled by disposables
}
