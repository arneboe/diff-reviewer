import { buildPatch } from '../git/diffParser';
import { fsModeFromGitMode } from '../git/gitAdapter';
import { GitResolver } from '../git/repoManager';
import { DiffFile, UndoEntry, diffFilePath } from '../types';

/** Thrown when an undo entry can no longer be applied safely. */
export class UndoRefusedError extends Error {}

export type UndoneAction = 'approve' | 'reject';

/**
 * Executes review actions against git and keeps an in-memory undo stack.
 *
 * There is no status map any more: approved means staged, pending means
 * unstaged, rejected means gone from the working tree. Every method returns
 * the fresh DiffFile after the action, or null when the file has no unstaged
 * change left.
 */
export class StateManager {
  private undoStack: UndoEntry[] = [];

  constructor(private git: GitResolver) {}

  /** True when the file has to be handled as a whole (no per-hunk patches). */
  static isWholeFile(file: DiffFile): boolean {
    return file.isUntracked || file.isBinary || file.kind !== 'modified' || file.hunks.length === 0;
  }

  hasUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /**
   * Approve a hunk: stage it. Whole-file cases stage the entire file.
   */
  async approve(file: DiffFile, hunkId: string): Promise<DiffFile | null> {
    if (StateManager.isWholeFile(file)) {
      return this.approveAll(file);
    }
    const hunk = file.hunks.find((h) => h.id === hunkId);
    if (!hunk) {
      return null;
    }
    const git = this.git.getAdapter(file.repoRoot);
    const filePath = diffFilePath(file);
    const headSha = await git.headSha();
    const patch = buildPatch(file, hunk);
    await git.applyCached(patch);
    this.undoStack.push({ type: 'stage', repoRoot: file.repoRoot, filePath, headSha, patch });
    return git.getFileDiff(filePath);
  }

  /**
   * Approve everything unstaged in a file: `git add`.
   */
  async approveAll(file: DiffFile): Promise<DiffFile | null> {
    const git = this.git.getAdapter(file.repoRoot);
    const filePath = diffFilePath(file);
    const headSha = await git.headSha();
    const before = await git.readIndexEntry(filePath);
    await git.addPath(filePath);
    this.undoStack.push({ type: 'index', repoRoot: file.repoRoot, filePath, headSha, before });
    return git.getFileDiff(filePath);
  }

  /**
   * Reject a hunk: reverse-apply it on disk. Whole-file cases discard the
   * entire unstaged change of the file.
   */
  async reject(file: DiffFile, hunkId: string): Promise<DiffFile | null> {
    if (StateManager.isWholeFile(file)) {
      return this.rejectWholeFile(file);
    }
    const hunk = file.hunks.find((h) => h.id === hunkId);
    if (!hunk) {
      return null;
    }
    const git = this.git.getAdapter(file.repoRoot);
    const filePath = diffFilePath(file);
    const headSha = await git.headSha();
    const patch = buildPatch(file, hunk);
    await git.applyReverse(patch);
    this.undoStack.push({
      type: 'worktree-patch',
      repoRoot: file.repoRoot,
      filePath,
      headSha,
      forwardPatch: patch,
    });
    return git.getFileDiff(filePath);
  }

  /**
   * Reject every unstaged change in a file. Tracked text files are rejected
   * hunk by hunk (re-parsing after each) so every hunk gets its own undo
   * entry; a remaining mode change is reverted afterwards.
   */
  async rejectAll(file: DiffFile): Promise<DiffFile | null> {
    if (StateManager.isWholeFile(file)) {
      return this.rejectWholeFile(file);
    }

    let current: DiffFile | null = file;
    while (current && current.hunks.length > 0 && !StateManager.isWholeFile(current)) {
      current = await this.reject(current, current.hunks[0].id!);
    }
    if (current && current.modeChange) {
      current = await this.rejectMode(current);
    }
    return current;
  }

  private async rejectMode(file: DiffFile): Promise<DiffFile | null> {
    const git = this.git.getAdapter(file.repoRoot);
    const filePath = diffFilePath(file);
    const headSha = await git.headSha();
    const previousMode = await git.worktreeMode(filePath);
    await git.chmodWorktree(filePath, fsModeFromGitMode(file.modeChange!.from));
    this.undoStack.push({
      type: 'worktree-mode',
      repoRoot: file.repoRoot,
      filePath,
      headSha,
      previousMode,
    });
    return git.getFileDiff(filePath);
  }

  private async rejectWholeFile(file: DiffFile): Promise<DiffFile | null> {
    const git = this.git.getAdapter(file.repoRoot);
    const filePath = diffFilePath(file);
    const headSha = await git.headSha();
    const snapshot = await git.snapshotWorktreeFile(filePath);
    // A file that only exists as an intent-to-add entry (kind 'added' but
    // known to git) has no index content to restore; it is simply removed.
    const wasIntentToAdd = file.kind === 'added' && !file.isUntracked;

    if (file.isUntracked || wasIntentToAdd) {
      await git.unlinkWorktreeFile(filePath);
      if (wasIntentToAdd) {
        await git.restoreIndexEntry(filePath, null);
      }
    } else {
      await git.checkoutIndexPath(filePath);
    }

    this.undoStack.push({
      type: 'worktree-file',
      repoRoot: file.repoRoot,
      filePath,
      headSha,
      content: snapshot.content,
      mode: snapshot.mode,
      wasIntentToAdd,
    });
    return git.getFileDiff(filePath);
  }

  /**
   * Undo the last action. Returns the affected file or null if the stack is
   * empty. Throws UndoRefusedError (after dropping the entry) when the
   * repository moved on in a way that makes the undo unsafe.
   */
  async undo(): Promise<{ repoRoot: string; filePath: string; undone: UndoneAction } | null> {
    const entry = this.undoStack.pop();
    if (!entry) {
      return null;
    }
    const git = this.git.getAdapter(entry.repoRoot);

    const head = await git.headSha();
    if (head !== entry.headSha) {
      throw new UndoRefusedError(
        `Cannot undo: HEAD changed since the action on ${entry.filePath} (a commit was made).`,
      );
    }

    switch (entry.type) {
      case 'stage':
        await git.applyCachedReverse(entry.patch);
        break;
      case 'index':
        await git.restoreIndexEntry(entry.filePath, entry.before);
        break;
      case 'worktree-patch':
        await git.applyForward(entry.forwardPatch);
        break;
      case 'worktree-file':
        await git.restoreWorktreeFile(entry.filePath, entry.content, entry.mode);
        if (entry.wasIntentToAdd) {
          await git.addIntentToAdd(entry.filePath);
        }
        break;
      case 'worktree-mode':
        await git.chmodWorktree(entry.filePath, entry.previousMode);
        break;
    }

    const undone: UndoneAction =
      entry.type === 'stage' || entry.type === 'index' ? 'approve' : 'reject';
    return { repoRoot: entry.repoRoot, filePath: entry.filePath, undone };
  }

  /**
   * Drop undo entries of a repository whose HEAD no longer matches; they
   * could never be applied and would only produce refusals.
   */
  pruneForHead(repoRoot: string, headSha: string): void {
    this.undoStack = this.undoStack.filter((e) => e.repoRoot !== repoRoot || e.headSha === headSha);
  }
}
