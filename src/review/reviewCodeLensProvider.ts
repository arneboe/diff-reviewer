import * as vscode from 'vscode';
import { FileRef } from '../types';
import { FileRender } from './reviewModel';

/** What the CodeLens provider needs to know about a document. */
export interface LensView {
  ref: FileRef;
  model: FileRender;
  dirty: boolean;
}

export interface LensSource {
  /** Render data for a reviewed document, undefined when nothing is to be shown. */
  lensViewFor(doc: vscode.TextDocument): LensView | undefined;
  readonly onDidChangeLenses: vscode.Event<void>;
}

/**
 * Approve / Reject actions above each pending hunk, plus a file-level line
 * at the top of every reviewed file. Lenses only exist while review mode is
 * on and the document has unstaged changes.
 */
export class ReviewCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private source: LensSource) {}

  get onDidChangeCodeLenses(): vscode.Event<void> {
    return this.source.onDidChangeLenses;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const view = this.source.lensViewFor(doc);
    if (!view) {
      return [];
    }
    const { ref, model, dirty } = view;
    const top = new vscode.Range(0, 0, 0, 0);

    if (dirty) {
      return [
        lens(top, '$(warning) Save the file to continue reviewing', 'workbench.action.files.save'),
      ];
    }

    const lenses: vscode.CodeLens[] = [
      lens(
        top,
        '$(check-all) Approve file',
        'diffReviewer.approveFileRef',
        [ref],
        'Stage the whole file',
      ),
      lens(
        top,
        '$(clear-all) Reject file',
        'diffReviewer.rejectFileRef',
        [ref],
        'Discard every unstaged change in this file',
      ),
      lens(top, model.summary, ''),
      lens(top, '$(eye-closed) Exit review mode', 'diffReviewer.disableReviewMode'),
    ];

    for (const hunk of model.hunks) {
      const range = new vscode.Range(hunk.lensLine, 0, hunk.lensLine, 0);
      const args = [ref.repoRoot, ref.filePath, hunk.hunkId];
      lenses.push(
        lens(range, '$(check) Approve', 'diffReviewer.approveHunk', args, 'Stage this change'),
        lens(
          range,
          '$(close) Reject',
          'diffReviewer.rejectHunk',
          args,
          'Discard this change on disk',
        ),
        lens(range, `+${hunk.addedCount} −${hunk.removedCount}`, '', undefined, hunk.header),
      );
    }
    return lenses;
  }
}

function lens(
  range: vscode.Range,
  title: string,
  command: string,
  args?: unknown[],
  tooltip?: string,
): vscode.CodeLens {
  return new vscode.CodeLens(range, { title, command, arguments: args, tooltip });
}
