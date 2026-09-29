import { join } from 'path';
import * as vscode from 'vscode';
import { RepoManager, RepoState } from './git/repoManager';
import { FileTreeProvider } from './sidebar/fileTreeProvider';
import { DiffPanelProvider } from './webview/diffPanelProvider';
import { StateManager, UndoRefusedError } from './state/stateManager';
import { DiffFile, WebviewToExtMessage, diffFilePath } from './types';
import { highlightFileContent } from './highlighter';

const CONFIG_SECTION = 'diffReviewer';
const DEFAULT_SCAN_DEPTH = 10;
/** Workspace-state key used by versions before 2.0; cleared once on activation. */
const LEGACY_STORAGE_KEY = 'diffReviewer.hunkStatuses';

let repos: RepoManager;
let fileTreeProvider: FileTreeProvider;
let diffPanelProvider: DiffPanelProvider;
let stateManager: StateManager;
let extensionContext: vscode.ExtensionContext;

/** One watcher on <gitdir>/{index,HEAD} per repository, keyed by repo root. */
const gitDirWatchers = new Map<string, vscode.FileSystemWatcher>();

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing = false;
let refreshQueued = false;

function getScanDepth(): number {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>('repoScanDepth', DEFAULT_SCAN_DEPTH);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_SCAN_DEPTH;
}

function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

/** Read file content + highlight for the webview. */
async function getFileData(
  file: DiffFile,
): Promise<{ fileContent: string[]; highlightedLines: string[] }> {
  const filePath = diffFilePath(file);
  const fileContent = await repos.getAdapter(file.repoRoot).getFileContent(filePath);
  const highlightedLines = highlightFileContent(filePath, fileContent);
  return { fileContent, highlightedLines };
}

export async function activate(context: vscode.ExtensionContext) {
  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showErrorMessage('Diff Reviewer: No workspace folder open.');
    return;
  }

  extensionContext = context;
  void context.workspaceState.update(LEGACY_STORAGE_KEY, undefined);

  repos = new RepoManager(workspaceFolderPaths(), getScanDepth());
  stateManager = new StateManager(repos);
  fileTreeProvider = new FileTreeProvider(repos);

  // Sidebar tree view
  const treeView = vscode.window.createTreeView('diffReviewer.fileTree', {
    treeDataProvider: fileTreeProvider,
  });
  context.subscriptions.push(treeView);

  fileTreeProvider.onDidChangeTreeData(() => {
    const count = fileTreeProvider.getFiles().length;
    treeView.badge = count > 0 ? { value: count, tooltip: `${count} files to review` } : undefined;
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
    vscode.commands.registerCommand('diffReviewer.refresh', () => refreshAll()),

    vscode.commands.registerCommand('diffReviewer.openFile', async (file: DiffFile) => {
      const { fileContent, highlightedLines } = await getFileData(file);
      diffPanelProvider.showFile(file, fileContent, highlightedLines);
    }),

    vscode.commands.registerCommand('diffReviewer.approveFile', (file: DiffFile) =>
      runAction('Approve file', () => stateManager.approveAll(file)),
    ),

    vscode.commands.registerCommand('diffReviewer.rejectFile', (file: DiffFile) =>
      runAction('Reject file', () => stateManager.rejectAll(file)),
    ),

    vscode.commands.registerCommand('diffReviewer.undo', async () => {
      try {
        const result = await stateManager.undo();
        if (!result) {
          vscode.window.showInformationMessage('Nothing to undo.');
          return;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof UndoRefusedError) {
          vscode.window.showWarningMessage(message);
        } else {
          vscode.window.showErrorMessage(`Undo failed: ${message}`);
        }
      }
      await refreshAll();
    }),
  );

  // Re-discover repos when the workspace or the scan depth changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      repos.setWorkspaceFolders(workspaceFolderPaths());
      await refreshAll();
    }),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.repoScanDepth`)) {
        repos.setMaxDepth(getScanDepth());
        await refreshAll();
      }
    }),
  );

  // Working-tree watcher with debounce for auto-refresh
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  context.subscriptions.push(watcher);
  context.subscriptions.push({
    dispose: () => {
      for (const w of gitDirWatchers.values()) {
        w.dispose();
      }
      gitDirWatchers.clear();
    },
  });

  // Initial load
  void refreshAll();
}

function scheduleRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    void refreshAll();
  }, 500);
}

/**
 * Re-read every repository, update the sidebar, welcome contexts, git-dir
 * watchers and every open panel. Calls that arrive while a refresh runs are
 * coalesced into one follow-up run.
 */
async function refreshAll(): Promise<void> {
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    do {
      refreshQueued = false;
      await fileTreeProvider.refresh();
      const states = await repos.getRepoStates();
      for (const [root, state] of states) {
        stateManager.pruneForHead(root, state.headSha);
      }
      updateContexts(states);
      updateGitDirWatchers(states);
      await refreshOpenPanels();
    } while (refreshQueued);
  } catch (err) {
    console.error('Diff Reviewer: refresh failed', err);
  } finally {
    refreshing = false;
  }
}

function updateContexts(states: Map<string, RepoState>): void {
  const repoCount = fileTreeProvider.getRepoCount();
  const pending = fileTreeProvider.getFiles().length;
  const anyStaged = [...states.values()].some((s) => s.hasStaged);
  void vscode.commands.executeCommand('setContext', 'diffReviewer.noRepos', repoCount === 0);
  void vscode.commands.executeCommand(
    'setContext',
    'diffReviewer.allStaged',
    repoCount > 0 && pending === 0 && anyStaged,
  );
  void vscode.commands.executeCommand(
    'setContext',
    'diffReviewer.clean',
    repoCount > 0 && pending === 0 && !anyStaged,
  );
}

/**
 * Watch each repository's index and HEAD so that `git add`, `git reset` and
 * `git commit` run from a terminal are picked up even when the workspace
 * folder sits below the repository root.
 */
function updateGitDirWatchers(states: Map<string, RepoState>): void {
  for (const [root, watcher] of gitDirWatchers) {
    if (!states.has(root)) {
      watcher.dispose();
      gitDirWatchers.delete(root);
    }
  }
  for (const [root, state] of states) {
    if (gitDirWatchers.has(root)) {
      continue;
    }
    const pattern = new vscode.RelativePattern(vscode.Uri.file(state.gitDir), '{index,HEAD}');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(scheduleRefresh);
    watcher.onDidCreate(scheduleRefresh);
    watcher.onDidDelete(scheduleRefresh);
    gitDirWatchers.set(root, watcher);
    extensionContext.subscriptions.push(watcher);
  }
}

/** Re-send every open panel from the freshly loaded tree; close panels whose file is done. */
async function refreshOpenPanels(): Promise<void> {
  for (const ref of diffPanelProvider.openRefs()) {
    const file = fileTreeProvider.findFile(ref.repoRoot, ref.filePath);
    if (file) {
      await sendRefresh(file);
    } else {
      diffPanelProvider.closeFile(ref);
    }
  }
}

async function handlePanelFocus(): Promise<void> {
  await refreshAll();
}

async function sendRefresh(file: DiffFile): Promise<void> {
  const { fileContent, highlightedLines } = await getFileData(file);
  diffPanelProvider.refreshFile(file, fileContent, highlightedLines);
}

/** Run a git-mutating review action, report failures, then refresh everything. */
async function runAction(label: string, action: () => Promise<DiffFile | null>): Promise<void> {
  try {
    await action();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`${label} failed: ${message}`);
  }
  await refreshAll();
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
  if (!file) {
    // The panel is stale; a refresh either re-sends or closes it.
    await refreshAll();
    return;
  }

  if (msg.command === 'approve' || msg.command === 'reject') {
    const hunk = file.hunks[msg.hunkIndex];
    if (!hunk || !hunk.id || (msg.hunkId && hunk.id !== msg.hunkId)) {
      vscode.window.showInformationMessage('The change moved; the view was refreshed.');
      await refreshAll();
      return;
    }
    const hunkId = hunk.id;
    if (msg.command === 'approve') {
      await runAction('Approve', () => stateManager.approve(file, hunkId));
    } else {
      await runAction('Reject', () => stateManager.reject(file, hunkId));
    }
    return;
  }

  if (msg.command === 'approveAll') {
    await runAction('Approve file', () => stateManager.approveAll(file));
    return;
  }

  if (msg.command === 'rejectAll') {
    await runAction('Reject file', () => stateManager.rejectAll(file));
  }
}

export function deactivate() {
  // Cleanup handled by disposables
}
