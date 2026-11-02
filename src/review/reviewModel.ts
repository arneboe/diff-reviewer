/**
 * Pure mapping from a `DiffFile` to editor positions. No `vscode` import, so
 * it can be unit-tested with node:test.
 *
 * Line-number semantics (see `splitHunks`): a sub-hunk's 1-based `newStart`
 * and `newCount` refer to the working-tree file. Its added lines occupy lines
 * `newStart .. newStart+newCount-1`; its removed lines sit immediately before
 * line `newStart` and exist only in `hunk.lines`. A pure deletion has
 * `newCount = 0` and `newStart` pointing at the line that follows the removed
 * block, which is `lineCount + 1` for a deletion at the end of the file.
 *
 * All positions returned here are 0-based editor lines. CodeLenses are drawn
 * above their line, so a hunk's lens sits at `newStart - 1`.
 */
import { StateManager } from '../state/stateManager';
import { DiffFile, DiffHunk } from '../types';

/** 0-based, inclusive line span. */
export interface LineSpan {
  start: number;
  end: number;
}

export interface HunkRender {
  hunkId: string;
  /** 0-based line the CodeLens is attached to (drawn above it) */
  lensLine: number;
  /** Added lines, or null for a pure deletion */
  added: LineSpan | null;
  addedCount: number;
  removedCount: number;
  header: string;
}

export interface FileRender {
  /** True when the file can only be approved or rejected as a whole */
  wholeFile: boolean;
  /** Per-hunk render data, sorted by position; empty for whole-file cases */
  hunks: HunkRender[];
  /** Short text for the file-level CodeLens */
  summary: string;
}

function clampTo(last: number): (line: number) => number {
  return (line) => Math.min(Math.max(line, 0), last);
}

function addedSpan(hunk: DiffHunk, last: number): LineSpan | null {
  if (hunk.newCount === 0) {
    return null;
  }
  const start = hunk.newStart - 1;
  if (start > last) {
    // Stale diff: the file on disk is shorter than the diff says.
    return null;
  }
  return { start, end: Math.min(start + hunk.newCount - 1, last) };
}

function renderHunk(hunk: DiffHunk, lineCount: number): HunkRender {
  const last = Math.max(lineCount - 1, 0);
  const clamp = clampTo(last);
  const removedCount = hunk.lines.filter((l) => l.type === 'remove').length;
  const addedCount = hunk.lines.filter((l) => l.type === 'add').length;

  return {
    hunkId: hunk.id ?? '',
    lensLine: clamp(hunk.newStart - 1),
    added: addedSpan(hunk, last),
    addedCount,
    removedCount,
    header: hunk.header,
  };
}

function modeText(file: DiffFile): string | undefined {
  return file.modeChange ? `mode ${file.modeChange.from} → ${file.modeChange.to}` : undefined;
}

function wholeFileSummary(file: DiffFile): string {
  if (file.isBinary) {
    return 'Binary file';
  }
  if (file.kind === 'deleted' || file.worktreeMissing) {
    return 'Deleted file';
  }
  if (file.kind === 'added' || file.isUntracked) {
    return file.hunks.length > 0 ? 'New file' : 'New empty file';
  }
  const mode = modeText(file);
  if (mode && file.hunks.length === 0) {
    return mode.charAt(0).toUpperCase() + mode.slice(1);
  }
  return 'Whole file';
}

/** Map a file's pending hunks onto a document with `lineCount` lines. */
export function buildRenderModel(file: DiffFile, lineCount: number): FileRender {
  if (StateManager.isWholeFile(file)) {
    return { wholeFile: true, hunks: [], summary: wholeFileSummary(file) };
  }

  const sorted = [...file.hunks].sort((a, b) => a.newStart - b.newStart);
  const rendered = sorted.map((h) => renderHunk(h, lineCount));
  const count = rendered.length;
  const parts = [`${count} ${count === 1 ? 'hunk' : 'hunks'} left`];
  const mode = modeText(file);
  if (mode) {
    parts.push(mode);
  }
  return {
    wholeFile: false,
    hunks: rendered,
    summary: parts.join(', '),
  };
}

/** Identity of a rendering; equal signatures mean nothing needs re-drawing. */
export function renderSignature(file: DiffFile, lineCount: number, dirty: boolean): string {
  return `${JSON.stringify(file)}\0${lineCount}\0${dirty ? 1 : 0}`;
}

/** Last 0-based line a hunk visually covers (its lens line for pure deletions). */
function hunkEnd(hunk: HunkRender): number {
  return hunk.added ? hunk.added.end : hunk.lensLine;
}

/** The hunk containing `line`, or the nearest one below it. */
export function hunkAtOrAfter(model: FileRender, line: number): HunkRender | undefined {
  return model.hunks.find((h) => line <= hunkEnd(h));
}

/**
 * Lens line of the next or previous hunk relative to `line`, wrapping around
 * at either end. Undefined when the file has no hunks.
 */
export function neighbourHunkLine(
  model: FileRender,
  line: number,
  dir: 'next' | 'prev',
): number | undefined {
  const lines = model.hunks.map((h) => h.lensLine);
  if (lines.length === 0) {
    return undefined;
  }
  if (dir === 'next') {
    return lines.find((l) => l > line) ?? lines[0];
  }
  const before = lines.filter((l) => l < line);
  return before.length > 0 ? before[before.length - 1] : lines[lines.length - 1];
}
