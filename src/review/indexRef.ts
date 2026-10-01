/**
 * Encoding of a file reference in the query of an index-document URI. Kept
 * free of `vscode` so it can be unit-tested.
 */
import { FileRef } from '../types';

/** URI scheme of documents showing a file as recorded in the git index. */
export const INDEX_SCHEME = 'diff-reviewer-index';

export function indexQuery(ref: FileRef): string {
  return JSON.stringify({ repoRoot: ref.repoRoot, filePath: ref.filePath });
}

export function parseIndexQuery(query: string): FileRef | undefined {
  try {
    const parsed: unknown = JSON.parse(query);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as FileRef).repoRoot === 'string' &&
      typeof (parsed as FileRef).filePath === 'string'
    ) {
      const { repoRoot, filePath } = parsed as FileRef;
      return { repoRoot, filePath };
    }
  } catch {
    // not ours
  }
  return undefined;
}
