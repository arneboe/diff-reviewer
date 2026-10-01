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
 * above their line, so a hunk's lens sits at `newStart - 1`; a removal before
 * line `newStart` is anchored to the line it followed, `newStart - 2`.
 */
import { StateManager } from '../state/stateManager';
import { DiffFile, DiffHunk } from '../types';

/** 0-based, inclusive line span. */
export interface LineSpan {
  start: number;
  end: number;
}

export interface RemovedBlock {
  /** 0-based line the removed lines followed (marked in plain editors) */
  anchorLine: number;
  /** True when the lines were removed before the first line of the file */
  atTop: boolean;
  lines: string[];
}

export interface HunkRender {
  hunkId: string;
  /** 0-based line the CodeLens is attached to (drawn above it) */
  lensLine: number;
  /** Added lines, or null for a pure deletion */
  added: LineSpan | null;
  /** Removed lines, or null for a pure addition */
  removed: RemovedBlock | null;
  addedCount: number;
  removedCount: number;
  header: string;
}

export interface FileRender {
  /** True when the file can only be approved or rejected as a whole */
  wholeFile: boolean;
  /** Per-hunk render data, sorted by position; empty for whole-file cases */
  hunks: HunkRender[];
  /** Every span to paint as added (for an untracked file: all its lines) */
  addedSpans: LineSpan[];
  /** Short text for the file-level CodeLens */
  summary: string;
}

/** A document edit, as reported by `TextDocumentContentChangeEvent`. */
export interface LineChange {
  /** 0-based first line of the replaced range */
  startLine: number;
  /** 0-based last line of the replaced range */
  endLine: number;
  /** Number of line breaks in the inserted text */
  newLineCount: number;
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
  const removedLines = hunk.lines.filter((l) => l.type === 'remove').map((l) => l.content);
  const addedCount = hunk.lines.filter((l) => l.type === 'add').length;

  return {
    hunkId: hunk.id ?? '',
    lensLine: clamp(hunk.newStart - 1),
    added: addedSpan(hunk, last),
    removed:
      removedLines.length > 0
        ? { anchorLine: clamp(hunk.newStart - 2), atTop: hunk.newStart <= 1, lines: removedLines }
        : null,
    addedCount,
    removedCount: removedLines.length,
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
  const wholeFile = StateManager.isWholeFile(file);
  const sorted = [...file.hunks].sort((a, b) => a.newStart - b.newStart);
  const rendered = sorted.map((h) => renderHunk(h, lineCount));

  if (wholeFile) {
    return {
      wholeFile: true,
      hunks: [],
      addedSpans: file.isBinary ? [] : rendered.flatMap((h) => (h.added ? [h.added] : [])),
      summary: wholeFileSummary(file),
    };
  }

  const count = rendered.length;
  const parts = [`${count} ${count === 1 ? 'hunk' : 'hunks'} left`];
  const mode = modeText(file);
  if (mode) {
    parts.push(mode);
  }
  return {
    wholeFile: false,
    hunks: rendered,
    addedSpans: rendered.flatMap((h) => (h.added ? [h.added] : [])),
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

/**
 * Move a span to follow a document edit. Spans above the edit are unchanged,
 * spans below shift by the number of lines the edit added or removed, and a
 * span the edit overlaps shrinks or grows with it. Returns null when nothing
 * of the span is left.
 */
export function shiftSpan(span: LineSpan, change: LineChange): LineSpan | null {
  const delta = change.newLineCount - (change.endLine - change.startLine);
  if (change.startLine > span.end) {
    return span;
  }
  if (change.endLine < span.start) {
    return { start: span.start + delta, end: span.end + delta };
  }
  const start = Math.min(span.start, change.startLine);
  const end = span.end + delta;
  return end < start ? null : { start, end };
}
