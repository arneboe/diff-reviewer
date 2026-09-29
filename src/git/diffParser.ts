import { DiffFile, DiffHunk, DiffLine } from '../types';

const NO_NEWLINE = '\\ No newline at end of file';

/**
 * Parse unified diff output from `git diff` into structured DiffFile objects.
 * Custom parser to preserve rawLines per hunk (needed for git apply).
 * Files with a header but no hunks (mode-only changes, empty new files,
 * binary files) are kept so they can be handled at file level.
 */
export function parseDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diffText.split('\n');
  let i = 0;

  while (i < lines.length) {
    // Look for "diff --git a/... b/..."
    if (!lines[i].startsWith('diff --git ')) {
      i++;
      continue;
    }

    const paths = pathsFromDiffGitLine(lines[i]);
    const file: DiffFile = {
      // The parser has no repository context; GitAdapter stamps the real root.
      repoRoot: '',
      oldPath: paths?.oldPath ?? '',
      newPath: paths?.newPath ?? '',
      hunks: [],
      isBinary: false,
      diffHeader: [],
      kind: 'modified',
      isUntracked: false,
      worktreeMissing: false,
    };
    let oldMode: string | undefined;
    let newMode: string | undefined;

    i++;

    // Extended headers up to the ---/+++ pair, the hunks, or the next file
    while (
      i < lines.length &&
      !lines[i].startsWith('diff --git ') &&
      !lines[i].startsWith('--- ') &&
      !lines[i].startsWith('@@')
    ) {
      const line = lines[i];
      if (line.startsWith('new file mode ')) {
        file.kind = 'added';
      } else if (line.startsWith('deleted file mode ')) {
        file.kind = 'deleted';
      } else if (line.startsWith('old mode ')) {
        oldMode = line.slice('old mode '.length).trim();
      } else if (line.startsWith('new mode ')) {
        newMode = line.slice('new mode '.length).trim();
      } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
        file.isBinary = true;
      }
      i++;
    }

    // Parse --- and +++ lines
    if (i < lines.length && lines[i].startsWith('--- ')) {
      const oldLine = lines[i];
      file.diffHeader.push(oldLine);
      if (!paths) {
        file.oldPath = pathFromMarkerLine(oldLine, '--- ');
      }
      i++;
    }
    if (i < lines.length && lines[i].startsWith('+++ ')) {
      const newLine = lines[i];
      file.diffHeader.push(newLine);
      if (!paths) {
        file.newPath = pathFromMarkerLine(newLine, '+++ ');
      }
      i++;
    }

    // Parse hunks
    while (i < lines.length && !lines[i].startsWith('diff --git ')) {
      if (lines[i].startsWith('@@')) {
        const hunk = parseHunk(lines, i);
        file.hunks.push(hunk.hunk);
        i = hunk.nextIndex;
      } else {
        i++;
      }
    }

    if (oldMode && newMode && oldMode !== newMode) {
      file.modeChange = { from: oldMode, to: newMode };
    }
    file.worktreeMissing = file.kind === 'deleted';
    files.push(file);
  }

  return files;
}

/**
 * Extract both paths from "diff --git a/<p> b/<p>". Paths may contain spaces;
 * since renames are never requested both sides are the same path, which lets
 * us split the line at its midpoint and verify.
 */
function pathsFromDiffGitLine(line: string): { oldPath: string; newPath: string } | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) {
    return null;
  }
  const len = (rest.length - 'a/'.length - ' b/'.length) / 2;
  if (Number.isInteger(len) && len >= 0) {
    const candidate = rest.slice(2, 2 + len);
    if (rest.slice(2 + len) === ` b/${candidate}`) {
      return { oldPath: candidate, newPath: candidate };
    }
  }
  // Fallback: split at the last " b/" (correct unless the path contains " b/")
  const idx = rest.lastIndexOf(' b/');
  if (idx < 0) {
    return null;
  }
  return { oldPath: rest.slice(2, idx), newPath: rest.slice(idx + 3) };
}

/** Path from a "--- a/x" or "+++ b/x" line; "/dev/null" becomes ''. */
function pathFromMarkerLine(line: string, marker: string): string {
  let p = line.slice(marker.length);
  // git appends a TAB when the path contains spaces
  if (p.endsWith('\t')) {
    p = p.slice(0, -1);
  }
  if (p === '/dev/null') {
    return '';
  }
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function parseHunk(lines: string[], startIndex: number): { hunk: DiffHunk; nextIndex: number } {
  const headerLine = lines[startIndex];
  const match = headerLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);

  if (!match) {
    // Skip malformed hunk header
    return {
      hunk: {
        oldStart: 0,
        oldCount: 0,
        newStart: 0,
        newCount: 0,
        header: headerLine,
        lines: [],
        rawLines: [headerLine],
      },
      nextIndex: startIndex + 1,
    };
  }

  const hunk: DiffHunk = {
    oldStart: parseInt(match[1], 10),
    oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
    header: headerLine,
    lines: [],
    rawLines: [headerLine],
  };

  let i = startIndex + 1;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('@@') || line.startsWith('diff --git ')) {
      break;
    }

    // "\ No newline at end of file" belongs to the line before it
    if (line.startsWith('\\ ')) {
      hunk.rawLines.push(line);
      const prev = hunk.lines[hunk.lines.length - 1];
      if (prev) {
        prev.noNewline = true;
      }
      i++;
      continue;
    }

    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', content: line.slice(1) });
      hunk.rawLines.push(line);
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'remove', content: line.slice(1) });
      hunk.rawLines.push(line);
    } else if (line.startsWith(' ') || line === '') {
      // Context line (space prefix) or empty line at end of diff
      if (line === '' && i === lines.length - 1) {
        // Trailing empty line of the diff output, skip
        break;
      }
      hunk.lines.push({ type: 'context', content: line.slice(1) });
      hunk.rawLines.push(line);
    } else {
      // Unknown line format — likely next section
      break;
    }

    i++;
  }

  return { hunk, nextIndex: i };
}

/**
 * Split each hunk into granular sub-hunks — one per contiguous group of
 * changed lines. Context lines between changes become boundaries.
 */
export function splitHunks(hunks: DiffHunk[]): DiffHunk[] {
  const result: DiffHunk[] = [];

  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    let i = 0;

    while (i < hunk.lines.length) {
      // Skip context lines
      if (hunk.lines[i].type === 'context') {
        oldLine++;
        newLine++;
        i++;
        continue;
      }

      // Collect a contiguous group of changed lines (add/remove with no context gap)
      const groupOldStart = oldLine;
      const groupNewStart = newLine;
      let groupOldCount = 0;
      let groupNewCount = 0;
      const groupLines: DiffLine[] = [];
      const groupRawLines: string[] = [];

      while (i < hunk.lines.length && hunk.lines[i].type !== 'context') {
        const line = hunk.lines[i];
        groupLines.push(line);

        if (line.type === 'remove') {
          groupRawLines.push('-' + line.content);
          groupOldCount++;
          oldLine++;
        } else if (line.type === 'add') {
          groupRawLines.push('+' + line.content);
          groupNewCount++;
          newLine++;
        }
        if (line.noNewline) {
          groupRawLines.push(NO_NEWLINE);
        }
        i++;
      }

      // For the @@ header used by git apply --unidiff-zero:
      // When count=0, start refers to the line BEFORE the change point
      const patchOldStart = groupOldCount === 0 ? groupOldStart - 1 : groupOldStart;
      const patchNewStart = groupNewCount === 0 ? groupNewStart - 1 : groupNewStart;
      const header = `@@ -${patchOldStart},${groupOldCount} +${patchNewStart},${groupNewCount} @@`;

      result.push({
        oldStart: groupOldStart,
        oldCount: groupOldCount,
        // newStart/newCount are used for rendering position in the file
        newStart: groupNewStart,
        newCount: groupNewCount,
        header,
        lines: groupLines,
        rawLines: [header, ...groupRawLines],
      });
    }
  }

  return result;
}

/**
 * Build a unified diff patch for a single sub-hunk, suitable for piping to
 * `git apply --unidiff-zero` (forward, reverse, or --cached).
 */
export function buildPatch(file: DiffFile, hunk: DiffHunk): string {
  return [...file.diffHeader, ...hunk.rawLines].join('\n') + '\n';
}

/**
 * FNV-1a hash producing an 8-char hex string.
 */
function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compute a content-based ID for a hunk by hashing only the changed lines
 * (add/remove content, not context or line numbers).
 */
export function computeHunkId(filePath: string, hunk: DiffHunk): string {
  const changedContent = hunk.lines
    .filter((l) => l.type === 'add' || l.type === 'remove')
    .map((l) => `${l.type}:${l.content}`)
    .join('\n');
  return fnv1a(`${filePath}\0${changedContent}`);
}

/**
 * Compute IDs for all hunks in a file, appending `-2`, `-3` etc. for duplicates.
 */
export function computeHunkIds(filePath: string, hunks: DiffHunk[]): string[] {
  const ids: string[] = [];
  const seen = new Map<string, number>();

  for (const hunk of hunks) {
    const baseId = computeHunkId(filePath, hunk);
    const count = (seen.get(baseId) || 0) + 1;
    seen.set(baseId, count);
    ids.push(count === 1 ? baseId : `${baseId}-${count}`);
  }

  // Retroactively fix first occurrence if there were duplicates
  for (let i = 0; i < ids.length; i++) {
    const baseId = ids[i];
    if (seen.get(baseId)! > 1) {
      ids[i] = `${baseId}-1`;
    }
  }

  return ids;
}

/** Sub-hunks with content IDs assigned, ready for a DiffFile. */
export function prepareHunks(filePath: string, hunks: DiffHunk[]): DiffHunk[] {
  const split = splitHunks(hunks);
  const ids = computeHunkIds(filePath, split);
  split.forEach((h, i) => {
    h.id = ids[i];
  });
  return split;
}
