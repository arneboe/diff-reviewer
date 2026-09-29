import { basename, join } from 'path';
import * as vscode from 'vscode';
import { RepoManager } from './git/repoManager';
import { FileTreeProvider } from './sidebar/fileTreeProvider';
import { DiffPanelProvider } from './webview/diffPanelProvider';
import { StateManager, UndoRefusedError } from './state/stateManager';
import { DiffFile, FileRef, WebviewToExtMessage, diffFilePath } from './types';
import { highlightFileContent } from './highlighter';

const CONFIG_SECTION = 'diffReviewer';
const DEFAULT_SCAN_DEPTH = 10;
/** Workspace-state key used by versions before 2.0; cleared once on activation. */
const LEGACY_STORAGE_KEY = 'diffReviewer.hunkStatuses';
/** Debounce for file-system events before the affected repositories are re-read. */
const WATCH_DEBOUNCE_MS = 300;

let repos: RepoManager;
let fileTreeProvider: FileTreeProvider;
let diffPanelProvider: DiffPanelProvider;
let stateManager: StateManager;
let extensionContext: vscode.ExtensionContext;

/** One watcher on <gitdir>/{index,HEAD} per repository, keyed by repo root. */
const gitDirWatchers = new Map<string, vscode.FileSystemWatcher>();
/** Whether each repository has staged changes; drives the welcome texts. */
const repoStaged = new Map<string, boolean>();

/**
 * Every git mutation and every refresh runs through this queue, one at a
 * time, so no step reads a state another step is halfway through changing.
 */
let queue: Promise<void> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job);
  queue = run.then(
    () => undefined,
    (err) => console.error('Diff Reviewer:', err),
  );
  return run;
}

// Pending work collected from file-system events until the debounce fires.
let watchTimer: ReturnType<typeof setTimeout> | undefined;
const dirtyRoots = new Set<string>();
let rediscoverPending = false;

function getScanDepth(): number {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>('repoScanDepth', DEFAULT_SCAN_DEPTH);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_SCAN_DEPTH;
}

function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
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
  fileTreeProvider = new FileTreeProvider();

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
    vscode.commands.registerCommand('diffReviewer.refresh', () => fullRefresh()),

    vscode.commands.registerCommand('diffReviewer.openFile', (file: DiffFile) => openFile(file)),

    vscode.commands.registerCommand('diffReviewer.approveFile', (file: DiffFile) =>
      runAction('Approve file', refOf(file), (fresh) => stateManager.approveAll(fresh)),
    ),

    vscode.commands.registerCommand('diffReviewer.rejectFile', (file: DiffFile) =>
      runAction('Reject file', refOf(file), (fresh) => stateManager.rejectAll(fresh)),
    ),

    vscode.commands.registerCommand('diffReviewer.undo', () => undoLastAction()),
  );

  // Re-discover repos when the workspace or the scan depth changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      repos.setWorkspaceFolders(workspaceFolderPaths());
      return fullRefresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.repoScanDepth`)) {
        repos.setMaxDepth(getScanDepth());
        return fullRefresh();
      }
    }),
  );

  // Working-tree watcher: re-read only the repository a changed path belongs to
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidChange(onWorkspaceFileEvent);
  watcher.onDidCreate(onWorkspaceFileEvent);
  watcher.onDidDelete(onWorkspaceFileEvent);
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
  void fullRefresh();
}

function refOf(file: DiffFile): FileRef {
  return { repoRoot: file.repoRoot, filePath: diffFilePath(file) };
}

// ---- refresh --------------------------------------------------------------

/**
 * Re-discover repositories and re-read all of them. Only for startup,
 * workspace/setting changes, a repository appearing or disappearing, and the
 * Refresh button.
 */
function fullRefresh(): Promise<void> {
  return enqueue(async () => {
    const infos = await repos.discover();
    fileTreeProvider.setRepos(infos);
    for (const root of [...repoStaged.keys()]) {
      if (!infos.some((r) => r.root === root)) {
        repoStaged.delete(root);
      }
    }
    await readRepos(infos.map((r) => r.root));
    await updateGitDirWatchers();
  });
}

/** Re-read the given repositories (no discovery). */
function refreshRepos(roots: Iterable<string>): Promise<void> {
  const list = [...roots];
  return enqueue(() => readRepos(list));
}

/**
 * Re-read the given repositories: their files, HEAD and staged state, and the
 * panels showing their files. Must run inside the queue.
 */
async function readRepos(roots: string[]): Promise<void> {
  await Promise.all(
    roots.map(async (root) => {
      try {
        const [files, state] = await Promise.all([
          repos.getAdapter(root).getDiff(),
          repos.getRepoState(root),
        ]);
        stateManager.pruneForHead(root, state.headSha);
        repoStaged.set(root, state.hasStaged);
        fileTreeProvider.setRepoFiles(root, files);
      } catch (err) {
        console.error(`Diff Reviewer: failed to read ${root}:`, err);
      }
    }),
  );
  const rootSet = new Set(roots);
  for (const ref of diffPanelProvider.openRefs()) {
    if (rootSet.has(ref.repoRoot)) {
      await refreshPanel(ref);
    }
  }
  updateContexts();
}

/** Re-send one panel from the tree, or close it when its file is done. */
async function refreshPanel(ref: FileRef): Promise<void> {
  const file = fileTreeProvider.findFile(ref.repoRoot, ref.filePath);
  if (file) {
    await sendRefresh(file);
  } else {
    diffPanelProvider.closeFile(ref);
  }
}

/** Send a file to its open panel unless the panel already shows exactly that. */
async function sendRefresh(file: DiffFile): Promise<void> {
  const filePath = diffFilePath(file);
  const fileContent = await repos.getAdapter(file.repoRoot).getFileContent(filePath);
  if (diffPanelProvider.isUnchanged(file, fileContent)) {
    return;
  }
  diffPanelProvider.refreshFile(file, fileContent, highlightFileContent(filePath, fileContent));
}

async function openFile(file: DiffFile): Promise<void> {
  const filePath = diffFilePath(file);
  const fileContent = await repos.getAdapter(file.repoRoot).getFileContent(filePath);
  const highlightedLines = highlightFileContent(filePath, fileContent);
  diffPanelProvider.showFile(file, fileContent, highlightedLines);
}

function updateContexts(): void {
  const repoCount = fileTreeProvider.getRepoCount();
  const pending = fileTreeProvider.getFiles().length;
  const anyStaged = [...repoStaged.values()].some(Boolean);
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

// ---- watchers ---------------------------------------------------------------

function onWorkspaceFileEvent(uri: vscode.Uri): void {
  if (basename(uri.fsPath) === '.git') {
    // A repository appeared or disappeared.
    rediscoverPending = true;
  } else {
    const root = repos.repoForPath(uri.fsPath);
    if (!root) {
      return;
    }
    dirtyRoots.add(root);
  }
  scheduleWatchRefresh();
}

function scheduleWatchRefresh(): void {
  if (watchTimer) {
    clearTimeout(watchTimer);
  }
  watchTimer = setTimeout(() => {
    watchTimer = undefined;
    if (rediscoverPending) {
      rediscoverPending = false;
      dirtyRoots.clear();
      void fullRefresh();
      return;
    }
    const roots = [...dirtyRoots];
    dirtyRoots.clear();
    if (roots.length > 0) {
      void refreshRepos(roots);
    }
  }, WATCH_DEBOUNCE_MS);
}

/**
 * Watch each repository's index and HEAD so that `git add`, `git reset` and
 * `git commit` run from a terminal are picked up even when the workspace
 * folder sits below the repository root. Each watcher re-reads only its repo.
 */
async function updateGitDirWatchers(): Promise<void> {
  const roots = new Set(repos.getRepos().map((r) => r.root));
  for (const [root, watcher] of gitDirWatchers) {
    if (!roots.has(root)) {
      watcher.dispose();
      gitDirWatchers.delete(root);
    }
  }
  for (const root of roots) {
    if (gitDirWatchers.has(root)) {
      continue;
    }
    let gitDir: string;
    try {
      gitDir = await repos.getAdapter(root).gitDir();
    } catch (err) {
      console.error(`Diff Reviewer: no git dir for ${root}:`, err);
      continue;
    }
    const pattern = new vscode.RelativePattern(vscode.Uri.file(gitDir), '{index,HEAD}');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const markDirty = () => {
      dirtyRoots.add(root);
      scheduleWatchRefresh();
    };
    watcher.onDidChange(markDirty);
    watcher.onDidCreate(markDirty);
    watcher.onDidDelete(markDirty);
    gitDirWatchers.set(root, watcher);
    extensionContext.subscriptions.push(watcher);
  }
}

function handlePanelFocus(ref: FileRef): Promise<void> {
  return refreshRepos([ref.repoRoot]);
}

// ---- actions ----------------------------------------------------------------

/**
 * Run a git-mutating review action on one file and update only that file.
 *
 * The file is re-read inside the queue first, so the action never works on a
 * stale diff. When the action finishes a file whose panel was open, the panel
 * closes and the next file still to review opens in its place.
 */
function runAction(
  label: string,
  ref: FileRef,
  action: (fresh: DiffFile) => Promise<DiffFile | null>,
): Promise<void> {
  return enqueue(async () => {
    const adapter = repos.getAdapter(ref.repoRoot);
    const panelWasOpen = diffPanelProvider.isOpen(ref);
    const orderBefore = fileTreeProvider.getFiles();

    let after: DiffFile | null;
    try {
      const fresh = await adapter.getFileDiff(ref.filePath);
      after = fresh ? await action(fresh) : null;
      fileTreeProvider.updateFile(ref.repoRoot, ref.filePath, after);
      repoStaged.set(ref.repoRoot, await adapter.hasStagedChanges());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`${label} failed: ${message}`);
      await readRepos([ref.repoRoot]);
      return;
    }

    if (after) {
      await sendRefresh(after);
    } else {
      diffPanelProvider.closeFile(ref);
      if (panelWasOpen) {
        const next = nextFileToReview(orderBefore, ref);
        if (next) {
          await openFile(next);
        }
      }
    }
    updateContexts();
  });
}

/**
 * The file that followed `done` in the sidebar before the action and still has
 * changes; wraps around to the first remaining file.
 */
function nextFileToReview(orderBefore: DiffFile[], done: FileRef): DiffFile | undefined {
  const remaining = fileTreeProvider.getFiles();
  if (remaining.length === 0) {
    return undefined;
  }
  const idx = orderBefore.findIndex(
    (f) => f.repoRoot === done.repoRoot && diffFilePath(f) === done.filePath,
  );
  for (const candidate of orderBefore.slice(idx + 1)) {
    const fresh = fileTreeProvider.findFile(candidate.repoRoot, diffFilePath(candidate));
    if (fresh) {
      return fresh;
    }
  }
  return remaining[0];
}

function undoLastAction(): Promise<void> {
  return enqueue(async () => {
    try {
      const result = await stateManager.undo();
      if (!result) {
        vscode.window.showInformationMessage('Nothing to undo.');
        return;
      }
      await readRepos([result.repoRoot]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof UndoRefusedError) {
        vscode.window.showWarningMessage(message);
      } else {
        vscode.window.showErrorMessage(`Undo failed: ${message}`);
      }
      // The failed entry's repository is unknown here; re-read the known ones.
      await readRepos(repos.getRepos().map((r) => r.root));
    }
  });
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

  const ref: FileRef = { repoRoot: msg.repoRoot, filePath: msg.filePath };

  if (msg.command === 'approve' || msg.command === 'reject') {
    // The panel knows the hunk by its content ID; resolve it on the fresh diff.
    const shownId =
      msg.hunkId ?? fileTreeProvider.findFile(ref.repoRoot, ref.filePath)?.hunks[msg.hunkIndex]?.id;
    const isApprove = msg.command === 'approve';
    await runAction(isApprove ? 'Approve' : 'Reject', ref, async (fresh) => {
      const hunk = fresh.hunks.find((h) => h.id === shownId);
      if (!hunk && !StateManager.isWholeFile(fresh)) {
        vscode.window.showInformationMessage('The change moved; the view was refreshed.');
        return fresh;
      }
      const hunkId = hunk?.id ?? '';
      return isApprove ? stateManager.approve(fresh, hunkId) : stateManager.reject(fresh, hunkId);
    });
    return;
  }

  if (msg.command === 'approveAll') {
    await runAction('Approve file', ref, (fresh) => stateManager.approveAll(fresh));
    return;
  }

  if (msg.command === 'rejectAll') {
    await runAction('Reject file', ref, (fresh) => stateManager.rejectAll(fresh));
  }
}

export function deactivate() {
  // Cleanup handled by disposables
}
