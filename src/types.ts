export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  /** Set when git printed "\ No newline at end of file" after this line */
  noNewline?: true;
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

export type FileKind = 'modified' | 'added' | 'deleted';

/**
 * One file with unstaged changes (index → working tree), or an untracked file.
 * Anything already staged is invisible here: staged means approved.
 */
export interface DiffFile {
  /** Absolute path of the git repository this file belongs to */
  repoRoot: string;
  /** Path relative to repoRoot */
  oldPath: string;
  newPath: string;
  /** Unstaged sub-hunks, one per contiguous change group */
  hunks: DiffHunk[];
  isBinary: boolean;
  /** Raw diff header lines (--- and +++ lines) prepended to per-hunk patches */
  diffHeader: string[];
  kind: FileKind;
  /** Unstaged file-mode change (e.g. 100644 → 100755) */
  modeChange?: { from: string; to: string };
  /** True for files git does not know at all (not even intent-to-add) */
  isUntracked: boolean;
  /** True when the file is deleted in the working tree but still in the index */
  worktreeMissing: boolean;
}

/** One `git ls-files -s` entry. */
export interface IndexEntry {
  mode: string;
  sha: string;
  intentToAdd: boolean;
}

/**
 * Everything needed to revert one action. Approvals live in the git index,
 * so undoing them means unstaging; rejections are reverted on disk.
 */
export type UndoEntry = {
  repoRoot: string;
  filePath: string;
  /** HEAD at the time of the action; undo refuses if HEAD moved since */
  headSha: string;
} & (
  | { type: 'stage'; patch: string }
  | { type: 'index'; before: IndexEntry | null }
  | { type: 'worktree-patch'; forwardPatch: string }
  | { type: 'worktree-file'; content: Buffer | null; mode: number; wasIntentToAdd: boolean }
  | { type: 'worktree-mode'; previousMode: number }
);

// Extension → Webview messages
export type ExtToWebviewMessage = {
  command: 'showFile';
  file: DiffFile;
  fileContent: string[];
  highlightedLines: string[];
};

// Webview → Extension messages
// Every file-scoped message carries repoRoot so the extension can route it to
// the right repository when several are open.
export type WebviewToExtMessage =
  | { command: 'ready' }
  | { command: 'approve'; repoRoot: string; filePath: string; hunkIndex: number; hunkId?: string }
  | { command: 'reject'; repoRoot: string; filePath: string; hunkIndex: number; hunkId?: string }
  | { command: 'approveAll'; repoRoot: string; filePath: string }
  | { command: 'rejectAll'; repoRoot: string; filePath: string }
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
