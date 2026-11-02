import { basename, join, relative, sep } from 'path';
import * as vscode from 'vscode';
import { DiffFile, FileRef, fileKey } from '../types';
import { IndexContentProvider, indexUri } from './indexContentProvider';
import { LensSource, LensView } from './reviewCodeLensProvider';
import { FileRender, buildRenderModel, hunkAtOrAfter, renderSignature } from './reviewModel';

export interface ReviewModeDeps {
  /** The pending diff of a file, from the sidebar tree. */
  findFile(repoRoot: string, filePath: string): DiffFile | undefined;
  /** Root of the repository an absolute path belongs to. */
  repoForPath(absPath: string): string | undefined;
  /** Content of a file as recorded in the index. */
  readIndexContent(ref: FileRef): Promise<string>;
  /** A reviewed file became the active editor or was saved; its repo should be re-read. */
  onActiveFileChanged(ref: FileRef): void;
}

interface Rendered {
  signature: string;
  model: FileRender;
  dirty: boolean;
}

/** Workspace-state key: the diff-editor settings prompt was answered. */
const SETTINGS_PROMPTED_KEY = 'diffReviewer.diffEditorSettingsPrompted';

/**
 * Review mode in the editor.
 *
 * A file under review opens as a diff editor, index ↔ working tree, so that
 * VS Code itself draws removed lines as red rows and added lines green. The
 * right side is the real file, so editing and every language feature work.
 * While review mode is on, the diff editor of a file with unstaged changes
 * gets Approve / Reject CodeLenses; plain (non-diff) editors are left
 * untouched. Review mode off means no lenses at all.
 *
 * Replaces the old webview panel provider: `refreshRepos`/`refreshFile`
 * rebuild the lens models of exactly the files an update concerns, reload the
 * index side of open diffs, and a per-file signature skips identical rebuilds.
 */
export class ReviewModeController implements vscode.Disposable, LensSource {
  private enabled = false;
  private readonly index: IndexContentProvider;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLenses = this.lensEmitter.event;
  /** Lens model of each file, keyed by fileKey. */
  private rendered = new Map<string, Rendered>();
  private settingsPromptShown = false;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private deps: ReviewModeDeps,
  ) {
    this.index = new IndexContentProvider((ref) => this.deps.readIndexContent(ref));

    this.statusBar = vscode.window.createStatusBarItem(
      'diffReviewer.reviewMode',
      vscode.StatusBarAlignment.Left,
      50,
    );
    this.statusBar.name = 'Diff Reviewer: review mode';
    this.statusBar.command = 'diffReviewer.toggleReviewMode';
    this.updateStatusBar();

    this.disposables.push(
      this.index,
      this.statusBar,
      this.lensEmitter,
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          this.renderEditor(editor);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) {
          return;
        }
        this.renderEditor(editor);
        const ref = this.enabled ? this.refForDocument(editor.document) : undefined;
        if (ref) {
          this.deps.onActiveFileChanged(ref);
        }
      }),
      // Opening or closing a diff tab decides whether the file shows lenses.
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        if (
          [...e.opened, ...e.closed].some((tab) => tab.input instanceof vscode.TabInputTextDiff)
        ) {
          this.lensEmitter.fire();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const ref = this.enabled ? this.refForDocument(doc) : undefined;
        if (ref) {
          this.deps.onActiveFileChanged(ref);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const ref = this.refForDocument(doc);
        if (ref) {
          this.rendered.delete(fileKey(ref.repoRoot, ref.filePath));
        }
      }),
    );
    context.subscriptions.push(this);
    void vscode.commands.executeCommand('setContext', 'diffReviewer.reviewMode', false);
  }

  // ---- mode -----------------------------------------------------------------

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) {
      return;
    }
    this.enabled = on;
    void vscode.commands.executeCommand('setContext', 'diffReviewer.reviewMode', on);
    this.updateStatusBar();
    if (on) {
      for (const editor of vscode.window.visibleTextEditors) {
        this.renderEditor(editor);
      }
    } else {
      this.rendered.clear();
    }
    this.lensEmitter.fire();
  }

  toggle(): void {
    this.setEnabled(!this.enabled);
  }

  /** Show the status bar item only while there is something to review in principle. */
  setStatusBarVisible(visible: boolean): void {
    if (visible) {
      this.statusBar.show();
    } else {
      this.statusBar.hide();
    }
  }

  private updateStatusBar(): void {
    this.statusBar.text = this.enabled ? '$(eye) Review' : '$(eye-closed) Review';
    this.statusBar.tooltip = this.enabled
      ? 'Diff Reviewer: review mode is on. Click to turn it off.'
      : 'Diff Reviewer: review mode is off. Click to show Approve / Reject actions in the editor.';
  }

  // ---- opening --------------------------------------------------------------

  /**
   * Open a file as an index ↔ working-tree diff and turn review mode on. The
   * first time per workspace, offer the diff-editor settings that make the
   * review comfortable (CodeLens in diff editors, inline view).
   */
  async openForReview(ref: FileRef): Promise<void> {
    this.offerDiffEditorSettings();
    const fileUri = vscode.Uri.file(join(ref.repoRoot, ref.filePath));
    await vscode.commands.executeCommand(
      'vscode.diff',
      indexUri(ref),
      fileUri,
      `${basename(ref.filePath)} (Review)`,
      { preview: false } satisfies vscode.TextDocumentShowOptions,
    );
    this.setEnabled(true);
    this.revealNextHunkFrom(ref, 0);
  }

  private offerDiffEditorSettings(): void {
    if (this.settingsPromptShown || this.context.workspaceState.get(SETTINGS_PROMPTED_KEY)) {
      return;
    }
    const config = vscode.workspace.getConfiguration('diffEditor');
    const codeLens = config.get<boolean>('codeLens', false);
    const sideBySide = config.get<boolean>('renderSideBySide', true);
    if (codeLens && !sideBySide) {
      return;
    }
    this.settingsPromptShown = true;
    const missing = [
      ...(codeLens
        ? []
        : ['"diffEditor.codeLens": true (VS Code hides CodeLens in diffs by default)']),
      ...(sideBySide ? ['"diffEditor.renderSideBySide": false (inline view)'] : []),
    ];
    void vscode.window
      .showInformationMessage(
        'Diff Reviewer: enable the diff editor settings it relies on for this workspace?',
        {
          modal: true,
          detail: `Without them the Approve / Reject CodeLenses do not show in the diff.\n\n${missing.join('\n')}`,
        },
        'Enable',
        "Don't ask again",
      )
      .then(async (choice) => {
        if (choice === 'Enable') {
          await config.update('codeLens', true, vscode.ConfigurationTarget.Workspace);
          await config.update('renderSideBySide', false, vscode.ConfigurationTarget.Workspace);
        }
        if (choice === 'Enable' || choice === "Don't ask again") {
          await this.context.workspaceState.update(SETTINGS_PROMPTED_KEY, true);
        }
      });
  }

  // ---- lookups --------------------------------------------------------------

  /** The repository file a document shows, whether or not it has pending changes. */
  refForDocument(doc: vscode.TextDocument): FileRef | undefined {
    if (doc.uri.scheme !== 'file') {
      return undefined;
    }
    const repoRoot = this.deps.repoForPath(doc.uri.fsPath);
    if (!repoRoot) {
      return undefined;
    }
    const filePath = relative(repoRoot, doc.uri.fsPath).split(sep).join('/');
    if (!filePath || filePath.startsWith('..')) {
      return undefined;
    }
    return { repoRoot, filePath };
  }

  /** The file shown in the active editor, when review mode draws it. */
  activeRef(): FileRef | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.enabled) {
      return undefined;
    }
    const ref = this.refForDocument(editor.document);
    return ref && this.deps.findFile(ref.repoRoot, ref.filePath) ? ref : undefined;
  }

  isVisible(ref: FileRef): boolean {
    return this.editorsFor(ref).length > 0;
  }

  /** Open document of a file, if any (also when not visible). */
  documentFor(ref: FileRef): vscode.TextDocument | undefined {
    const fsPath = join(ref.repoRoot, ref.filePath);
    return vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === 'file' && d.uri.fsPath === fsPath,
    );
  }

  private editorsFor(ref: FileRef): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter((editor) => {
      const r = this.refForDocument(editor.document);
      return r?.repoRoot === ref.repoRoot && r.filePath === ref.filePath;
    });
  }

  /** True when the document is the right side of a diff editor tab. */
  private isDiffPane(doc: vscode.TextDocument): boolean {
    const target = doc.uri.toString();
    return vscode.window.tabGroups.all.some((group) =>
      group.tabs.some(
        (tab) =>
          tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === target,
      ),
    );
  }

  /** Lenses belong to the diff editor only; plain editors of the file get none. */
  lensViewFor(doc: vscode.TextDocument): LensView | undefined {
    return this.isDiffPane(doc) ? this.viewFor(doc) : undefined;
  }

  private viewFor(doc: vscode.TextDocument): LensView | undefined {
    if (!this.enabled) {
      return undefined;
    }
    const ref = this.refForDocument(doc);
    const file = ref && this.deps.findFile(ref.repoRoot, ref.filePath);
    if (!ref || !file) {
      return undefined;
    }
    const model =
      this.rendered.get(fileKey(ref.repoRoot, ref.filePath))?.model ??
      buildRenderModel(file, doc.lineCount);
    return { ref, model, dirty: doc.isDirty };
  }

  /** Current render model of a document, undefined when not drawn. */
  modelFor(doc: vscode.TextDocument): FileRender | undefined {
    return this.viewFor(doc)?.model;
  }

  // ---- refresh --------------------------------------------------------------

  /** Re-render every visible editor showing a file of one of these repositories. */
  refreshRepos(roots: Iterable<string>): void {
    const rootSet = new Set(roots);
    this.index.refreshRepos(rootSet);
    for (const editor of vscode.window.visibleTextEditors) {
      const ref = this.refForDocument(editor.document);
      if (ref && rootSet.has(ref.repoRoot)) {
        this.renderEditor(editor);
      }
    }
    this.pruneHidden((key) => rootSet.has(key.split('\0')[0]));
  }

  /** Re-render the editors of one file, or clear them when it has nothing left to review. */
  refreshFile(ref: FileRef): void {
    this.index.refreshFile(ref);
    const editors = this.editorsFor(ref);
    for (const editor of editors) {
      this.renderEditor(editor);
    }
    if (editors.length === 0) {
      this.pruneHidden((key) => key === fileKey(ref.repoRoot, ref.filePath));
    }
  }

  /** Forget files that left the tree while no editor showed them. */
  private pruneHidden(matches: (key: string) => boolean): void {
    for (const key of this.rendered.keys()) {
      if (!matches(key)) {
        continue;
      }
      const [repoRoot, filePath] = key.split('\0');
      if (!this.deps.findFile(repoRoot, filePath)) {
        this.rendered.delete(key);
        this.lensEmitter.fire();
      }
    }
  }

  // ---- rendering ------------------------------------------------------------

  /** Rebuild a file's lens model when its diff, length or dirty flag changed. */
  private renderEditor(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const ref = this.enabled ? this.refForDocument(doc) : undefined;
    if (!ref) {
      return;
    }
    const key = fileKey(ref.repoRoot, ref.filePath);
    const file = this.deps.findFile(ref.repoRoot, ref.filePath);
    if (!file) {
      if (this.rendered.delete(key)) {
        this.lensEmitter.fire();
      }
      return;
    }

    const dirty = doc.isDirty;
    const signature = renderSignature(file, doc.lineCount, dirty);
    if (this.rendered.get(key)?.signature === signature) {
      return;
    }
    this.rendered.set(key, { signature, model: buildRenderModel(file, doc.lineCount), dirty });
    this.lensEmitter.fire();
  }

  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    const ref = this.enabled ? this.refForDocument(doc) : undefined;
    if (!ref) {
      return;
    }
    // While dirty the lenses only ask to save, so further typing changes nothing.
    if (doc.isDirty && this.rendered.get(fileKey(ref.repoRoot, ref.filePath))?.dirty) {
      return;
    }
    for (const editor of this.editorsFor(ref)) {
      this.renderEditor(editor);
    }
  }

  // ---- navigation -----------------------------------------------------------

  revealLine(editor: vscode.TextEditor, line: number): void {
    const target = Math.min(Math.max(line, 0), editor.document.lineCount - 1);
    const position = new vscode.Position(target, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  /** Put the cursor on the first pending hunk at or below `fromLine`, wrapping to the first. */
  revealNextHunkFrom(ref: FileRef, fromLine: number): void {
    const editors = this.editorsFor(ref);
    const active = vscode.window.activeTextEditor;
    const editor = editors.find((e) => e === active) ?? editors[0];
    if (!editor) {
      return;
    }
    const model = this.modelFor(editor.document);
    if (!model || model.hunks.length === 0) {
      return;
    }
    const hunk = hunkAtOrAfter(model, fromLine) ?? model.hunks[0];
    this.revealLine(editor, hunk.lensLine);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.rendered.clear();
  }
}
