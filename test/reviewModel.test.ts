import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiff, prepareHunks } from '../src/git/diffParser';
import {
  buildRenderModel,
  hunkAtOrAfter,
  neighbourHunkLine,
  renderSignature,
  shiftSpan,
} from '../src/review/reviewModel';
import { DiffFile, DiffHunk, DiffLine } from '../src/types';

const __dirname =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

/** Parse a fixture and split its hunks the way GitAdapter does. */
function fixture(name: string, index = 0): DiffFile {
  const file = parseDiff(readFileSync(join(fixturesDir, name), 'utf-8'))[index];
  return { ...file, repoRoot: '/repo', hunks: prepareHunks(file.newPath, file.hunks) };
}

function hunk(newStart: number, removed: string[], added: string[]): DiffHunk {
  const lines: DiffLine[] = [
    ...removed.map((content) => ({ type: 'remove' as const, content })),
    ...added.map((content) => ({ type: 'add' as const, content })),
  ];
  return {
    oldStart: 1,
    oldCount: removed.length,
    newStart,
    newCount: added.length,
    header: `@@ -1,${removed.length} +${newStart},${added.length} @@`,
    lines,
    rawLines: [],
    id: `h${newStart}`,
  };
}

function modified(hunks: DiffHunk[], extra: Partial<DiffFile> = {}): DiffFile {
  return {
    repoRoot: '/repo',
    oldPath: 'a.txt',
    newPath: 'a.txt',
    hunks,
    isBinary: false,
    diffHeader: ['--- a/a.txt', '+++ b/a.txt'],
    kind: 'modified',
    isUntracked: false,
    worktreeMissing: false,
    ...extra,
  };
}

describe('buildRenderModel', () => {
  it('maps a replace hunk: added span, lens on first added line, widget above', () => {
    // hello / -world / +beautiful world / +today / end  → 4 lines on disk
    const model = buildRenderModel(fixture('simple.diff'), 4);
    assert.equal(model.wholeFile, false);
    assert.equal(model.hunks.length, 1);
    const h = model.hunks[0];
    assert.deepEqual(h.added, { start: 1, end: 2 });
    assert.equal(h.lensLine, 1);
    assert.deepEqual(h.removed, { anchorLine: 0, atTop: false, lines: ['world'] });
    assert.equal(h.addedCount, 2);
    assert.equal(h.removedCount, 1);
    assert.deepEqual(model.addedSpans, [{ start: 1, end: 2 }]);
    assert.equal(model.summary, '1 hunk left');
  });

  it('positions do not depend on the no-newline marker', () => {
    const model = buildRenderModel(fixture('nonl.diff'), 3);
    const h = model.hunks[0];
    assert.deepEqual(h.added, { start: 1, end: 2 });
    assert.deepEqual(h.removed, { anchorLine: 0, atTop: false, lines: ['two'] });
  });

  it('keeps hunks sorted and handles pure additions', () => {
    const model = buildRenderModel(fixture('multi-hunk.diff'), 16);
    assert.equal(model.hunks.length, 2);
    assert.deepEqual(model.hunks[0].added, { start: 1, end: 1 });
    assert.deepEqual(model.hunks[0].removed?.lines, ['const app = express();']);
    const second = model.hunks[1];
    assert.deepEqual(second.added, { start: 12, end: 13 });
    assert.equal(second.lensLine, 12);
    assert.equal(second.removed, null);
    assert.equal(second.removedCount, 0);
    assert.equal(model.summary, '2 hunks left');
  });

  it('pure deletion in the middle: no span, lens on the following line, widget above it', () => {
    const model = buildRenderModel(modified([hunk(5, ['gone', 'also gone'], [])]), 10);
    const h = model.hunks[0];
    assert.equal(h.added, null);
    assert.equal(h.lensLine, 4);
    assert.deepEqual(h.removed, { anchorLine: 3, atTop: false, lines: ['gone', 'also gone'] });
    assert.deepEqual(model.addedSpans, []);
  });

  it('pure deletion at the end of the file sits on the last line', () => {
    const model = buildRenderModel(modified([hunk(11, ['tail'], [])]), 10);
    const h = model.hunks[0];
    assert.equal(h.lensLine, 9);
    assert.equal(h.removed?.anchorLine, 9);
    assert.equal(h.removed?.atTop, false);
  });

  it('deletion before the first line is flagged atTop', () => {
    const model = buildRenderModel(modified([hunk(1, ['head'], [])]), 10);
    const h = model.hunks[0];
    assert.equal(h.lensLine, 0);
    assert.deepEqual(h.removed, { anchorLine: 0, atTop: true, lines: ['head'] });
  });

  it('a file added in the index is whole-file with every line painted', () => {
    const model = buildRenderModel(fixture('newfile.diff'), 2);
    assert.equal(model.wholeFile, true);
    assert.deepEqual(model.hunks, []);
    assert.deepEqual(model.addedSpans, [{ start: 0, end: 1 }]);
    assert.equal(model.summary, 'New file');
  });

  it('an untracked file is whole-file with every line painted', () => {
    const file = modified([hunk(1, [], ['a', 'b', 'c'])], { kind: 'added', isUntracked: true });
    const model = buildRenderModel(file, 3);
    assert.equal(model.wholeFile, true);
    assert.deepEqual(model.addedSpans, [{ start: 0, end: 2 }]);
    assert.equal(model.summary, 'New file');
  });

  it('describes empty, mode-only, binary and deleted files', () => {
    const empty = modified([], { kind: 'added', isUntracked: true });
    assert.equal(buildRenderModel(empty, 1).summary, 'New empty file');

    const modeOnly = buildRenderModel(fixture('mode-only.diff'), 5);
    assert.equal(modeOnly.wholeFile, true);
    assert.deepEqual(modeOnly.addedSpans, []);
    assert.equal(modeOnly.summary, 'Mode 100644 → 100755');

    const binary = modified([], { isBinary: true });
    assert.equal(buildRenderModel(binary, 1).summary, 'Binary file');

    const deleted = modified([], { kind: 'deleted', worktreeMissing: true });
    assert.equal(buildRenderModel(deleted, 1).summary, 'Deleted file');
  });

  it('mentions a mode change next to the hunk count', () => {
    const file = modified([hunk(2, [], ['x'])], { modeChange: { from: '100644', to: '100755' } });
    assert.equal(buildRenderModel(file, 5).summary, '1 hunk left, mode 100644 → 100755');
  });

  it('clamps or drops spans when the document is shorter than the diff says', () => {
    const partial = buildRenderModel(modified([hunk(9, [], ['a', 'b', 'c', 'd', 'e'])]), 10);
    assert.deepEqual(partial.hunks[0].added, { start: 8, end: 9 });

    const beyond = buildRenderModel(modified([hunk(20, ['old'], ['a', 'b'])]), 10);
    assert.equal(beyond.hunks[0].added, null);
    assert.equal(beyond.hunks[0].lensLine, 9);
    assert.equal(beyond.hunks[0].removed?.anchorLine, 9);
    assert.deepEqual(beyond.addedSpans, []);
  });

  it('collapses everything onto line 0 for a one-line document', () => {
    const model = buildRenderModel(modified([hunk(1, ['x'], ['a', 'b', 'c'])]), 1);
    assert.deepEqual(model.hunks[0].added, { start: 0, end: 0 });
    assert.equal(model.hunks[0].lensLine, 0);
    assert.equal(model.hunks[0].removed?.anchorLine, 0);
  });
});

describe('hunkAtOrAfter', () => {
  const model = buildRenderModel(fixture('multi-hunk.diff'), 16); // hunks at [1,1] and [12,13]

  it('finds the hunk containing the line', () => {
    assert.equal(hunkAtOrAfter(model, 1)?.lensLine, 1);
    assert.equal(hunkAtOrAfter(model, 13)?.lensLine, 12);
  });

  it('falls through to the next hunk below the line', () => {
    assert.equal(hunkAtOrAfter(model, 0)?.lensLine, 1);
    assert.equal(hunkAtOrAfter(model, 5)?.lensLine, 12);
  });

  it('returns undefined after the last hunk', () => {
    assert.equal(hunkAtOrAfter(model, 14), undefined);
  });

  it('treats a pure deletion as covering its lens line', () => {
    const del = buildRenderModel(modified([hunk(5, ['gone'], [])]), 10);
    assert.equal(hunkAtOrAfter(del, 4)?.lensLine, 4);
    assert.equal(hunkAtOrAfter(del, 5), undefined);
  });
});

describe('neighbourHunkLine', () => {
  const model = buildRenderModel(fixture('multi-hunk.diff'), 16); // lenses at 1 and 12

  it('moves to the next hunk and wraps around', () => {
    assert.equal(neighbourHunkLine(model, 0, 'next'), 1);
    assert.equal(neighbourHunkLine(model, 1, 'next'), 12);
    assert.equal(neighbourHunkLine(model, 12, 'next'), 1);
  });

  it('moves to the previous hunk and wraps around', () => {
    assert.equal(neighbourHunkLine(model, 5, 'prev'), 1);
    assert.equal(neighbourHunkLine(model, 1, 'prev'), 12);
    assert.equal(neighbourHunkLine(model, 0, 'prev'), 12);
  });

  it('is undefined without hunks', () => {
    const empty = buildRenderModel(modified([]), 3);
    assert.equal(neighbourHunkLine(empty, 0, 'next'), undefined);
  });
});

describe('shiftSpan', () => {
  const span = { start: 5, end: 8 };

  it('leaves a span above the edit alone', () => {
    assert.deepEqual(shiftSpan(span, { startLine: 9, endLine: 9, newLineCount: 3 }), span);
  });

  it('shifts a span below an insertion down', () => {
    assert.deepEqual(shiftSpan(span, { startLine: 2, endLine: 2, newLineCount: 2 }), {
      start: 7,
      end: 10,
    });
  });

  it('shifts a span below a deletion up', () => {
    assert.deepEqual(shiftSpan(span, { startLine: 1, endLine: 3, newLineCount: 0 }), {
      start: 3,
      end: 6,
    });
  });

  it('shrinks a span when lines inside it are deleted', () => {
    assert.deepEqual(shiftSpan(span, { startLine: 6, endLine: 7, newLineCount: 0 }), {
      start: 5,
      end: 7,
    });
  });

  it('grows a span when lines are pasted inside it', () => {
    assert.deepEqual(shiftSpan(span, { startLine: 6, endLine: 6, newLineCount: 3 }), {
      start: 5,
      end: 11,
    });
  });

  it('cuts a span whose start was deleted', () => {
    assert.deepEqual(shiftSpan(span, { startLine: 3, endLine: 6, newLineCount: 0 }), {
      start: 3,
      end: 5,
    });
  });

  it('returns null when the whole span was deleted', () => {
    assert.equal(shiftSpan(span, { startLine: 4, endLine: 9, newLineCount: 0 }), null);
  });

  it('keeps a span whose last line is edited without a line break', () => {
    assert.deepEqual(shiftSpan(span, { startLine: 8, endLine: 8, newLineCount: 0 }), span);
  });
});

describe('renderSignature', () => {
  const file = fixture('simple.diff');

  it('is stable for identical input', () => {
    assert.equal(renderSignature(file, 4, false), renderSignature(file, 4, false));
  });

  it('changes with the dirty flag, the line count and the diff', () => {
    const base = renderSignature(file, 4, false);
    assert.notEqual(renderSignature(file, 4, true), base);
    assert.notEqual(renderSignature(file, 5, false), base);
    assert.notEqual(renderSignature({ ...file, hunks: [] }, 4, false), base);
  });
});
