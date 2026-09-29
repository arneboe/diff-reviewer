import { execFile } from 'child_process';
import { chmod, readFile, stat, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { DiffFile, DiffHunk, IndexEntry } from '../types';
import { parseDiff, prepareHunks } from './diffParser';
import { isReviewable } from './fileFilter';

/** SHA-1 of the empty blob; what an intent-to-add entry reports in ls-files -s. */
const EMPTY_BLOB_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

const DIFF_ARGS = [
  '-c',
  'core.quotePath=false',
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-renames',
];

/** Result of a git invocation whose exit code is meaningful. */
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Git operations for a single repository. `repoRoot` must be the absolute
 * top-level directory of the work tree (see repoDiscovery.ts). Every DiffFile
 * produced here is stamped with that root so callers can route it back.
 *
 * Only unstaged changes (index → working tree) and untracked files are
 * reported: staged changes are approved and therefore invisible.
 */
export class GitAdapter {
  constructor(private repoRoot: string) {}

  getRepoRoot(): string {
    return this.repoRoot;
  }

  /**
   * Every file with unstaged changes plus every untracked file.
   */
  async getDiff(): Promise<DiffFile[]> {
    const [raw, untrackedList] = await Promise.all([
      this.exec(DIFF_ARGS),
      this.exec(['ls-files', '--others', '--exclude-standard', '-z']),
    ]);

    const tracked = raw.trim() ? parseDiff(raw).map((f) => this.finishTracked(f)) : [];

    const untracked = await Promise.all(
      untrackedList
        .split('\0')
        .filter((p) => p.length > 0 && !p.endsWith('/'))
        .map((p) => this.buildUntrackedDiffFile(p)),
    );

    return [...tracked, ...untracked.filter((f): f is DiffFile => f !== null)];
  }

  /**
   * Fresh diff for a single file, or null when it has no unstaged change
   * and is not untracked.
   */
  async getFileDiff(filePath: string): Promise<DiffFile | null> {
    const raw = await this.exec([...DIFF_ARGS, '--', filePath]);
    if (raw.trim()) {
      const parsed = parseDiff(raw);
      return parsed.length > 0 ? this.finishTracked(parsed[0]) : null;
    }
    const untrackedList = await this.exec([
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      filePath,
    ]);
    if (!untrackedList.trim()) {
      return null;
    }
    return this.buildUntrackedDiffFile(filePath);
  }

  private finishTracked(f: DiffFile): DiffFile {
    const filePath = f.newPath || f.oldPath;
    const isBinary = f.isBinary || !isReviewable(filePath);
    return {
      ...f,
      isBinary,
      hunks: isBinary ? [] : prepareHunks(filePath, f.hunks),
      repoRoot: this.repoRoot,
    };
  }

  /**
   * Synthesise a DiffFile for an untracked file by reading its content and
   * treating every line as an addition — mirroring what `git diff --no-index
   * /dev/null <file>` would produce.
   */
  private async buildUntrackedDiffFile(filePath: string): Promise<DiffFile | null> {
    const base: DiffFile = {
      repoRoot: this.repoRoot,
      oldPath: filePath,
      newPath: filePath,
      hunks: [],
      isBinary: false,
      isUntracked: true,
      kind: 'added',
      worktreeMissing: false,
      diffHeader: ['--- /dev/null', `+++ b/${filePath}`],
    };

    if (!isReviewable(filePath)) {
      return { ...base, isBinary: true };
    }

    try {
      const absPath = join(this.repoRoot, filePath);
      const bytes = await readFile(absPath);
      if (looksBinary(bytes)) {
        return { ...base, isBinary: true };
      }
      const lines = bytes.toString('utf-8').split('\n');

      // Drop the trailing empty string that results from a final newline
      const hasTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
      if (hasTrailingNewline) {
        lines.pop();
      }
      if (lines.length === 0) {
        return base;
      }

      const header = `@@ -0,0 +1,${lines.length} @@`;
      const hunk: DiffHunk = {
        // oldStart must be 1 (not 0) so splitHunks computes patchOldStart = 1-1 = 0,
        // producing the correct "@@ -0,0 +1,N @@" header for a new file.
        oldStart: 1,
        oldCount: 0,
        newStart: 1,
        newCount: lines.length,
        header,
        lines: lines.map((l) => ({ type: 'add' as const, content: l })),
        rawLines: [header, ...lines.map((l) => `+${l}`)],
      };
      if (!hasTrailingNewline) {
        hunk.lines[hunk.lines.length - 1].noNewline = true;
      }

      return { ...base, hunks: prepareHunks(filePath, [hunk]) };
    } catch {
      // File may have been deleted between ls-files and read — skip silently
      return null;
    }
  }

  // ---- index operations ---------------------------------------------------

  /** Stage a single sub-hunk. The patch must come from `git diff` (index → worktree). */
  async applyCached(patch: string): Promise<void> {
    await this.exec(['apply', '--cached', '--unidiff-zero', '-'], patch);
  }

  /** Unstage a single sub-hunk previously staged with applyCached. */
  async applyCachedReverse(patch: string): Promise<void> {
    await this.exec(['apply', '--cached', '-R', '--unidiff-zero', '-'], patch);
  }

  /** Stage a whole file (also records deletions and mode changes). */
  async addPath(filePath: string): Promise<void> {
    await this.exec(['add', '--', filePath]);
  }

  /** Register an untracked file with an empty index entry (intent-to-add). */
  async addIntentToAdd(filePath: string): Promise<void> {
    await this.exec(['add', '-N', '--', filePath]);
  }

  /**
   * The index entry for a path, or null when the path is not in the index.
   * Intent-to-add entries look like a staged empty blob in `ls-files -s`; they
   * are told apart by `diff --cached` ignoring them and HEAD not having the path.
   */
  async readIndexEntry(filePath: string): Promise<IndexEntry | null> {
    const out = await this.exec(['ls-files', '-s', '-z', '--', filePath]);
    const entry = out.split('\0').find((l) => l.length > 0);
    if (!entry) {
      return null;
    }
    const match = entry.match(/^(\d{6}) ([0-9a-f]{40}) (\d)\t/);
    if (!match) {
      return null;
    }
    const mode = match[1];
    const sha = match[2];
    let intentToAdd = false;
    if (sha === EMPTY_BLOB_SHA) {
      const [cached, inHead] = await Promise.all([
        this.run(['diff', '--cached', '--quiet', '--', filePath]),
        this.run(['cat-file', '-e', `HEAD:${filePath}`]),
      ]);
      intentToAdd = cached.code === 0 && inHead.code !== 0;
    }
    return { mode, sha, intentToAdd };
  }

  /** Put an index entry back exactly as readIndexEntry reported it. */
  async restoreIndexEntry(filePath: string, entry: IndexEntry | null): Promise<void> {
    if (entry === null) {
      await this.exec(['update-index', '--force-remove', '--', filePath]);
      return;
    }
    if (entry.intentToAdd) {
      await this.exec(['update-index', '--force-remove', '--', filePath]);
      await this.addIntentToAdd(filePath);
      return;
    }
    await this.exec([
      'update-index',
      '--add',
      '--cacheinfo',
      `${entry.mode},${entry.sha},${filePath}`,
    ]);
  }

  /** Overwrite the working-tree file with the index version (content and mode). */
  async checkoutIndexPath(filePath: string): Promise<void> {
    await this.exec(['checkout-index', '-f', '-u', '--', filePath]);
  }

  /** Current HEAD commit, or '' in a repository without commits. */
  async headSha(): Promise<string> {
    const res = await this.run(['rev-parse', '--verify', '-q', 'HEAD']);
    return res.code === 0 ? res.stdout.trim() : '';
  }

  /** True when the index differs from HEAD. */
  async hasStagedChanges(): Promise<boolean> {
    const res = await this.run(['diff', '--cached', '--quiet']);
    return res.code !== 0;
  }

  /** Absolute path of the .git directory (for watching index/HEAD). */
  async gitDir(): Promise<string> {
    return (await this.exec(['rev-parse', '--absolute-git-dir'])).trim();
  }

  // ---- working-tree operations -------------------------------------------

  /** Reverse-apply a sub-hunk on disk (reject). */
  async applyReverse(patch: string): Promise<void> {
    await this.exec(['apply', '-R', '--unidiff-zero', '-'], patch);
  }

  /** Forward-apply a sub-hunk on disk (undo a rejection). */
  async applyForward(patch: string): Promise<void> {
    await this.exec(['apply', '--unidiff-zero', '-'], patch);
  }

  /**
   * Current working-tree content of a file, split into lines. A missing file
   * yields an empty array. The final newline does not produce an extra line.
   */
  async getFileContent(filePath: string): Promise<string[]> {
    try {
      const content = await readFile(join(this.repoRoot, filePath), 'utf-8');
      const lines = content.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }
      return lines;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /** Raw bytes and permission bits of a working-tree file; null content when missing. */
  async snapshotWorktreeFile(filePath: string): Promise<{ content: Buffer | null; mode: number }> {
    const absPath = join(this.repoRoot, filePath);
    try {
      const [content, info] = await Promise.all([readFile(absPath), stat(absPath)]);
      return { content, mode: info.mode & 0o777 };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { content: null, mode: 0o644 };
      }
      throw err;
    }
  }

  async restoreWorktreeFile(filePath: string, content: Buffer | null, mode: number): Promise<void> {
    const absPath = join(this.repoRoot, filePath);
    if (content === null) {
      await this.unlinkWorktreeFile(filePath);
      return;
    }
    await writeFile(absPath, content);
    await chmod(absPath, mode);
  }

  async unlinkWorktreeFile(filePath: string): Promise<void> {
    try {
      await unlink(join(this.repoRoot, filePath));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async worktreeMode(filePath: string): Promise<number> {
    return (await stat(join(this.repoRoot, filePath))).mode & 0o777;
  }

  async chmodWorktree(filePath: string, mode: number): Promise<void> {
    await chmod(join(this.repoRoot, filePath), mode);
  }

  // ---- process plumbing ----------------------------------------------------

  private async exec(args: string[], stdin?: string): Promise<string> {
    const res = await this.run(args, stdin);
    if (res.code !== 0) {
      const sub = args.find((a) => !a.startsWith('-') && a !== 'core.quotePath=false') ?? args[0];
      throw new Error(`git ${sub} failed: ${res.stderr.trim() || `exit code ${res.code}`}`);
    }
    return res.stdout;
  }

  private run(args: string[], stdin?: string): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const proc = execFile(
        'git',
        args,
        { cwd: this.repoRoot, maxBuffer: 50 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && typeof (err as { code?: unknown }).code !== 'number') {
            reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
            return;
          }
          const code = err ? ((err as { code?: number }).code ?? 1) : 0;
          resolve({ code, stdout, stderr });
        },
      );
      if (stdin !== undefined) {
        proc.stdin!.write(stdin);
      }
      proc.stdin!.end();
    });
  }
}

/** Heuristic used by git itself: a NUL byte in the first 8 KiB means binary. */
function looksBinary(bytes: Buffer): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}

/** Octal permission bits for a git mode string such as '100755'. */
export function fsModeFromGitMode(gitMode: string): number {
  return gitMode.endsWith('755') ? 0o755 : 0o644;
}
