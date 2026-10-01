import { join } from 'path';
import * as vscode from 'vscode';
import { FileRef } from '../types';
import { INDEX_SCHEME, indexQuery, parseIndexQuery } from './indexRef';

/**
 * URI of the index version of a file. The path is the real file path so the
 * editor picks the right language; the query carries the repository.
 */
export function indexUri(ref: FileRef): vscode.Uri {
  return vscode.Uri.file(join(ref.repoRoot, ref.filePath)).with({
    scheme: INDEX_SCHEME,
    query: indexQuery(ref),
  });
}

export function refFromIndexUri(uri: vscode.Uri): FileRef | undefined {
  return uri.scheme === INDEX_SCHEME ? parseIndexQuery(uri.query) : undefined;
}

/**
 * Serves the index version of files for the left side of the review diff
 * editor. When the index changes (approve, undo, `git add` in a terminal),
 * the affected documents are told to reload so the diff shrinks or grows.
 */
export class IndexContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private registration: vscode.Disposable;

  constructor(private readIndexContent: (ref: FileRef) => Promise<string>) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(INDEX_SCHEME, this);
  }

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = refFromIndexUri(uri);
    return ref ? this.readIndexContent(ref) : Promise.resolve('');
  }

  /** Reload the index document of one file, if open. */
  refreshFile(ref: FileRef): void {
    this.emitter.fire(indexUri(ref));
  }

  /** Reload every open index document of these repositories. */
  refreshRepos(roots: Set<string>): void {
    for (const doc of vscode.workspace.textDocuments) {
      const ref = refFromIndexUri(doc.uri);
      if (ref && roots.has(ref.repoRoot)) {
        this.emitter.fire(doc.uri);
      }
    }
  }

  dispose(): void {
    this.registration.dispose();
    this.emitter.dispose();
  }
}
