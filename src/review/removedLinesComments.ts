import * as vscode from 'vscode';
import { FileRender, HunkRender } from './reviewModel';

/**
 * Shows the removed lines of each pending hunk as a read-only comment widget
 * below the line they were removed after. A normal editor cannot insert
 * extra lines, and comment threads are the only stable API that adds
 * vertical space inside the editor.
 *
 * The controller gets no commenting-range provider, so VS Code offers no
 * "add comment" affordance, and no `comments/*` menus are contributed.
 */
export class RemovedLinesComments implements vscode.Disposable {
  private controller = vscode.comments.createCommentController('diffReviewer', 'Diff Reviewer');
  /** Threads per document URI, keyed by hunk ID. */
  private threads = new Map<string, Map<string, vscode.CommentThread>>();

  /** Make the document's threads match the model; `undefined` removes them all. */
  sync(doc: vscode.TextDocument, model: FileRender | undefined): void {
    const key = doc.uri.toString();
    const current = this.threads.get(key) ?? new Map<string, vscode.CommentThread>();
    const wanted = new Map<string, HunkRender>();
    for (const hunk of model?.hunks ?? []) {
      if (hunk.removed) {
        wanted.set(hunk.hunkId, hunk);
      }
    }

    for (const [id, thread] of current) {
      if (!wanted.has(id)) {
        thread.dispose();
        current.delete(id);
      }
    }

    for (const [id, hunk] of wanted) {
      const block = hunk.removed!;
      const range = new vscode.Range(block.anchorLine, 0, block.anchorLine, 0);
      const label = threadLabel(block.lines.length, block.atTop);
      const thread = current.get(id);
      if (thread) {
        // Same hunk ID means same content; only its position may have moved.
        if (!thread.range || !thread.range.isEqual(range)) {
          thread.range = range;
        }
        if (thread.label !== label) {
          thread.label = label;
        }
        continue;
      }
      const body = new vscode.MarkdownString();
      body.appendCodeblock(block.lines.join('\n'), doc.languageId);
      const created = this.controller.createCommentThread(doc.uri, range, [
        { body, mode: vscode.CommentMode.Preview, author: { name: 'Removed' } },
      ]);
      created.canReply = false;
      created.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      created.contextValue = 'diffReviewerRemoved';
      created.label = label;
      current.set(id, created);
    }

    if (current.size > 0) {
      this.threads.set(key, current);
    } else {
      this.threads.delete(key);
    }
  }

  clearDocument(uri: vscode.Uri): void {
    const key = uri.toString();
    for (const thread of this.threads.get(key)?.values() ?? []) {
      thread.dispose();
    }
    this.threads.delete(key);
  }

  clearAll(): void {
    for (const perDoc of this.threads.values()) {
      for (const thread of perDoc.values()) {
        thread.dispose();
      }
    }
    this.threads.clear();
  }

  dispose(): void {
    this.clearAll();
    this.controller.dispose();
  }
}

function threadLabel(count: number, atTop: boolean): string {
  const base = count === 1 ? 'Removed line' : `${count} removed lines`;
  return atTop ? `${base} (above this line)` : base;
}
