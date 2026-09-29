export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: DiffLine[];
  /** Raw diff lines including the @@ header, for reconstructing patches */
  rawLines: string[];
  /** Content-based ID for stable tracking across re-parses */
  id?: string;
}

export interface DiffFile {
  /** Absolute path of the git repository this file belongs to */
  repoRoot: string;
  /** Path relative to repoRoot */
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  isBinary: boolean;
  /** Raw diff header lines (--- and +++ lines) */
  diffHeader: string[];
  /** True for files not yet tracked by git (new, never staged) */
  isUntracked?: boolean;
}

export type HunkStatus = 'pending' | 'approved' | 'rejected';

export interface HunkState {
  repoRoot: string;
  filePath: string;
  hunkIndex: number;
  status: HunkStatus;
}

export interface UndoEntry {
  type: 'approve' | 'reject';
  repoRoot: string;
  filePath: string;
  hunkId: string;
  /** For reject undo of tracked files: the forward patch to re-apply via git apply */
  forwardPatch?: string;
  /** For reject undo of untracked files: lines to re-insert at the given 0-indexed position */
  untrackedInsert?: { lineIndex: number; lines: string[] };
}

// Extension → Webview messages
export type ExtToWebviewMessage =
  | {
      command: 'showFile';
      file: DiffFile;
      hunkStatuses: HunkStatus[];
      fileContent: string[];
      highlightedLines: string[];
    }
  | { command: 'updateHunk'; hunkIndex: number; status: HunkStatus }
  | { command: 'clear' };

// Webview → Extension messages
// Every file-scoped message carries repoRoot so the extension can route it to
// the right repository when several are open.
export type WebviewToExtMessage =
  | { command: 'ready' }
  | { command: 'approve'; repoRoot: string; filePath: string; hunkIndex: number }
  | { command: 'reject'; repoRoot: string; filePath: string; hunkIndex: number }
  | { command: 'approveAll'; repoRoot: string; filePath: string }
  | { command: 'rejectAll'; repoRoot: string; filePath: string }
  | { command: 'undo'; repoRoot: string; filePath: string; hunkIndex: number }
  | { command: 'openInEditor'; repoRoot: string; filePath: string };

/** Identifies one file within one repository. */
export interface FileRef {
  repoRoot: string;
  filePath: string;
}

/** Path of a DiffFile relative to its repo root. */
export function diffFilePath(file: DiffFile): string {
  return file.newPath || file.oldPath;
}

/**
 * Composite key uniquely identifying a file across repositories.
 * NUL cannot occur in paths, so it is a safe separator.
 */
export function fileKey(repoRoot: string, filePath: string): string {
  return `${repoRoot}\0${filePath}`;
}

export function fileKeyOf(file: DiffFile): string {
  return fileKey(file.repoRoot, diffFilePath(file));
}
