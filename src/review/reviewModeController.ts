import { join, relative, sep } from 'path';
import * as vscode from 'vscode';
import { DiffFile, FileRef, fileKey } from '../types';
import { RemovedLinesComments } from './removedLinesComments';
import { LensSource, LensView } from './reviewCodeLensProvider';
import {
  FileRender,
  LineSpan,
  buildRenderModel,
  hunkAtOrAfter,
  renderSignature,
  shiftSpan,
} from './reviewModel';

export interface ReviewModeDeps {
  /** The pending diff of a file, from the sidebar tree. */
  findFile(repoRoot: string, filePath: string): DiffFile | undefined;
  /** Root of the repository an absolute path belongs to. */
  repoForPath(absPath: string): string | undefined;
  /** A reviewed file became the active editor or was saved; its repo should be re-read. */
  onActiveFileChanged(ref: FileRef): void;
}

interface Rendered {
  uri: vscode.Uri;
  signature: string;
  model: FileRender;
  /** Added spans as currently drawn; shifted along while the buffer is dirty */
  spans: LineSpan[];
  dirty: boolean;
}

/**
 * Draws the pending hunks of every visible editor while review mode is on:
 * added lines as whole-line decorations, removed lines as comment widgets,
 * actions as CodeLenses (via the provider). Review mode off means nothing is
 * drawn and the editor behaves as usual.
 *
 * Replaces the old webview panel provider: `refreshRepos`/`refreshFile`
 * re-render exactly the editors an update concerns, and a per-file
 * signature skips identical re-renders.
 */
export class ReviewModeController implements vscode.Disposable, LensSource {
  private enabled = false;
  private readonly added: vscode.TextEditorDecorationType;
  private readonly addedDimmed: vscode.TextEditorDecorationType;
  private readonly removalMarker: vscode.TextEditorDecorationType;
  private readonly comments = new RemovedLinesComments();
  private readonly statusBar: vscode.StatusBarItem;
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLenses = this.lensEmitter.event;
  /** What is drawn for each file, keyed by fileKey. */
  private rendered = new Map<string, Rendered>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    context: vscode.ExtensionContext,
    private deps: ReviewModeDeps,
  ) {
    this.added = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.addedDimmed = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '0 0 0 2px',
      borderStyle: 'dashed',
      borderColor: new vscode.ThemeColor('editorGutter.addedBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.removalMarker = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '0 0 1px 0',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.statusBar = vscode.window.createStatusBarItem(
      'diffReviewer.reviewMode',
      vscode.StatusBarAlignment.Left,
      50,
    );
    this.statusBar.name = 'Diff Reviewer: review mode';
    this.statusBar.command = 'diffReviewer.toggleReviewMode';
    this.updateStatusBar();

    this.disposables.push(
      this.added,
      this.addedDimmed,
      this.removalMarker,
      this.comments,
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
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const ref = this.enabled ? this.refForDocument(doc) : undefined;
        if (ref) {
          this.deps.onActiveFileChanged(ref);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.comments.clearDocument(doc.uri);
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
      for (const editor of vscode.window.visibleTextEditors) {
        this.clearDecorations(editor);
      }
      this.comments.clearAll();
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
      : 'Diff Reviewer: review mode is off. Click to highlight unstaged changes in the editor.';
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

  lensViewFor(doc: vscode.TextDocument): LensView | undefined {
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
    return this.lensViewFor(doc)?.model;
  }

  // ---- refresh --------------------------------------------------------------

  /** Re-render every visible editor showing a file of one of these repositories. */
  refreshRepos(roots: Iterable<string>): void {
    const rootSet = new Set(roots);
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
    const editors = this.editorsFor(ref);
    for (const editor of editors) {
      this.renderEditor(editor);
    }
    if (editors.length === 0) {
      this.pruneHidden((key) => key === fileKey(ref.repoRoot, ref.filePath));
    }
  }

  /** Drop widgets of files that left the tree while no editor showed them. */
  private pruneHidden(matches: (key: string) => boolean): void {
    for (const [key, entry] of this.rendered) {
      if (!matches(key)) {
        continue;
      }
      const [repoRoot, filePath] = key.split('\0');
      if (!this.deps.findFile(repoRoot, filePath)) {
        this.comments.clearDocument(entry.uri);
        this.rendered.delete(key);
        this.lensEmitter.fire();
      }
    }
  }

  // ---- rendering ------------------------------------------------------------

  private renderEditor(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const ref = this.enabled ? this.refForDocument(doc) : undefined;
    const file = ref && this.deps.findFile(ref.repoRoot, ref.filePath);
    if (!ref || !file) {
      this.clearDecorations(editor);
      if (ref) {
        const key = fileKey(ref.repoRoot, ref.filePath);
        if (this.rendered.has(key)) {
          this.rendered.delete(key);
          this.comments.clearDocument(doc.uri);
          this.lensEmitter.fire();
        }
      } else if (this.enabled) {
        this.comments.clearDocument(doc.uri);
      }
      return;
    }

    const key = fileKey(ref.repoRoot, ref.filePath);
    const dirty = doc.isDirty;
    const signature = renderSignature(file, doc.lineCount, dirty);
    const previous = this.rendered.get(key);

    let entry: Rendered;
    if (previous && previous.signature === signature) {
      entry = previous;
    } else {
      const model = buildRenderModel(file, doc.lineCount);
      // A buffer that is already dirty keeps the spans tracked so far; a
      // fresh render has only the on-disk positions to offer.
      const spans = dirty && previous ? previous.spans : model.addedSpans;
      entry = { uri: doc.uri, signature, model, spans, dirty };
      this.rendered.set(key, entry);
      if (!dirty || !previous) {
        this.comments.sync(doc, model);
      }
      this.lensEmitter.fire();
    }
    this.applyDecorations(editor, entry);
  }

  private applyDecorations(editor: vscode.TextEditor, entry: Rendered): void {
    const ranges = entry.spans.map((s) => new vscode.Range(s.start, 0, s.end, 0));
    if (entry.dirty) {
      editor.setDecorations(this.added, []);
      editor.setDecorations(this.addedDimmed, ranges);
      editor.setDecorations(this.removalMarker, []);
      return;
    }
    const anchors = entry.model.hunks
      .filter((h) => h.removed)
      .map((h) => new vscode.Range(h.removed!.anchorLine, 0, h.removed!.anchorLine, 0));
    editor.setDecorations(this.added, ranges);
    editor.setDecorations(this.addedDimmed, []);
    editor.setDecorations(this.removalMarker, anchors);
  }

  private clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.added, []);
    editor.setDecorations(this.addedDimmed, []);
    editor.setDecorations(this.removalMarker, []);
  }

  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    const ref = this.enabled ? this.refForDocument(doc) : undefined;
    if (!ref) {
      return;
    }
    const editors = this.editorsFor(ref);
    if (editors.length === 0) {
      return;
    }
    if (!doc.isDirty) {
      // Reloaded from disk (e.g. after a reject) or edited back to the saved
      // state: draw the on-disk positions again.
      for (const editor of editors) {
        this.renderEditor(editor);
      }
      return;
    }

    const key = fileKey(ref.repoRoot, ref.filePath);
    const entry = this.rendered.get(key);
    if (!entry) {
      for (const editor of editors) {
        this.renderEditor(editor);
      }
      return;
    }

    // All change ranges refer to the document before the edit; applying them
    // bottom-up keeps the earlier ones' coordinates valid.
    const changes = [...e.contentChanges].sort((a, b) => b.range.start.line - a.range.start.line);
    let spans = entry.spans;
    for (const change of changes) {
      const lineChange = {
        startLine: change.range.start.line,
        endLine: change.range.end.line,
        newLineCount: change.text.split('\n').length - 1,
      };
      spans = spans.flatMap((s) => {
        const moved = shiftSpan(s, lineChange);
        return moved ? [moved] : [];
      });
    }
    const becameDirty = !entry.dirty;
    const file = this.deps.findFile(ref.repoRoot, ref.filePath);
    const updated: Rendered = {
      ...entry,
      spans,
      dirty: true,
      signature: file ? renderSignature(file, doc.lineCount, true) : entry.signature,
    };
    this.rendered.set(key, updated);
    for (const editor of editors) {
      this.applyDecorations(editor, updated);
    }
    if (becameDirty) {
      this.lensEmitter.fire();
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
