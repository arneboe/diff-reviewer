import * as vscode from 'vscode';
import {
  DiffFile,
  DiffHunk,
  HunkStatus,
  UndoEntry,
  diffFilePath,
  fileKey,
  fileKeyOf,
} from '../types';
import { GitResolver } from '../git/repoManager';

const STORAGE_KEY = 'diffReviewer.hunkStatuses';

export class StateManager {
  /** fileKey(repoRoot, filePath) → Map<hunkId, HunkStatus> */
  private statuses = new Map<string, Map<string, HunkStatus>>();
  private undoStack: UndoEntry[] = [];

  constructor(
    private git: GitResolver,
    private storage?: vscode.Memento,
  ) {
    if (this.storage) {
      this.restoreFromStorage();
    }
  }

  /**
   * Sync statuses for a file: look up each hunk's ID in the map.
   * Returns ordered HunkStatus[] matching file.hunks order for the webview.
   * Stale IDs (hunks no longer in diff) are dropped.
   */
  syncStatuses(file: DiffFile): HunkStatus[] {
    const path = fileKeyOf(file);
    const existing = this.statuses.get(path);

    if (!existing || existing.size === 0) {
      const map = new Map<string, HunkStatus>();
      for (const hunk of file.hunks) {
        if (hunk.id) {
          map.set(hunk.id, 'pending');
        }
      }
      this.statuses.set(path, map);
      this.persist();
      return file.hunks.map(() => 'pending');
    }

    // Build new map with only hunks present in the current diff
    const newMap = new Map<string, HunkStatus>();
    for (const hunk of file.hunks) {
      if (hunk.id) {
        newMap.set(hunk.id, existing.get(hunk.id) || 'pending');
      }
    }
    this.statuses.set(path, newMap);
    this.persist();

    return file.hunks.map((h) => (h.id ? newMap.get(h.id) || 'pending' : 'pending'));
  }

  /**
   * Get statuses as an ordered array matching file.hunks order.
   */
  getStatusArray(file: DiffFile): HunkStatus[] {
    const map = this.statuses.get(fileKeyOf(file));
    if (!map) {
      return file.hunks.map(() => 'pending');
    }
    return file.hunks.map((h) => (h.id ? map.get(h.id) || 'pending' : 'pending'));
  }

  /**
   * Raw stored statuses for a file, in insertion order. Mainly for tests.
   */
  getStatuses(repoRoot: string, filePath: string): HunkStatus[] {
    const map = this.statuses.get(fileKey(repoRoot, filePath));
    if (!map) {
      return [];
    }
    return Array.from(map.values());
  }

  /**
   * Check if all hunks in a file are resolved (all approved).
   */
  isFileResolved(repoRoot: string, filePath: string): boolean {
    const map = this.statuses.get(fileKey(repoRoot, filePath));
    if (!map || map.size === 0) {
      return false;
    }
    for (const status of map.values()) {
      if (status !== 'approved') {
        return false;
      }
    }
    return true;
  }

  /**
   * Mark a hunk as approved by hunkId.
   */
  approve(file: DiffFile, hunkId: string): void {
    const map = this.statuses.get(fileKeyOf(file));
    if (!map || !map.has(hunkId)) {
      return;
    }
    map.set(hunkId, 'approved');
    this.undoStack.push({
      type: 'approve',
      repoRoot: file.repoRoot,
      filePath: diffFilePath(file),
      hunkId,
    });
    this.persist();
  }

  /**
   * Approve all pending hunks in a file.
   */
  approveAll(file: DiffFile): void {
    const map = this.statuses.get(fileKeyOf(file));
    if (!map) {
      return;
    }
    const filePath = diffFilePath(file);
    for (const hunk of file.hunks) {
      if (hunk.id && map.get(hunk.id) === 'pending') {
        map.set(hunk.id, 'approved');
        this.undoStack.push({
          type: 'approve',
          repoRoot: file.repoRoot,
          filePath,
          hunkId: hunk.id,
        });
      }
    }
    this.persist();
  }

  /**
   * Reject all pending hunks in a file, one at a time (re-parsing after each).
   */
  async rejectAll(file: DiffFile): Promise<DiffFile | null> {
    let currentFile: DiffFile | null = file;
    const key = fileKeyOf(file);

    while (currentFile) {
      const map = this.statuses.get(key);
      if (!map) {
        break;
      }

      // Find first pending hunk
      let pendingHunkId: string | undefined;
      for (const hunk of currentFile.hunks) {
        if (hunk.id && map.get(hunk.id) === 'pending') {
          pendingHunkId = hunk.id;
          break;
        }
      }
      if (!pendingHunkId) {
        break;
      }

      currentFile = await this.reject(currentFile, pendingHunkId);
    }

    return currentFile;
  }

  /**
   * Reject a hunk: reverse-apply it on disk via git apply -R.
   * Returns the updated DiffFile after re-parsing.
   */
  async reject(file: DiffFile, hunkId: string): Promise<DiffFile | null> {
    const hunk = file.hunks.find((h) => h.id === hunkId);
    if (!hunk) {
      return null;
    }

    const filePath = diffFilePath(file);
    const key = fileKeyOf(file);
    const git = this.git.getAdapter(file.repoRoot);

    if (file.isUntracked) {
      await git.rejectUntrackedHunk(filePath, hunk);
      this.undoStack.push({
        type: 'reject',
        repoRoot: file.repoRoot,
        filePath,
        hunkId,
        untrackedInsert: {
          lineIndex: hunk.newStart - 1,
          lines: hunk.lines.map((l) => l.content),
        },
      });
    } else {
      const patch = buildPatch(file, hunk);
      await git.applyReverse(patch);
      this.undoStack.push({
        type: 'reject',
        repoRoot: file.repoRoot,
        filePath,
        hunkId,
        forwardPatch: patch,
      });
    }

    const map = this.statuses.get(key);
    if (map) {
      map.delete(hunkId);
    }

    // Re-parse the file diff to get updated line numbers
    const freshFiles = await git.getFileDiff(filePath);
    if (freshFiles.length === 0) {
      this.statuses.delete(key);
      this.persist();
      return null;
    }

    const freshFile = freshFiles[0];
    this.syncStatuses(freshFile);
    return freshFile;
  }

  /**
   * Undo a specific approval (reset to pending).
   */
  undoApprove(file: DiffFile, hunkId: string): void {
    const map = this.statuses.get(fileKeyOf(file));
    const filePath = diffFilePath(file);
    if (map && map.get(hunkId) === 'approved') {
      map.set(hunkId, 'pending');
      // Remove matching undo entry from the stack
      for (let i = this.undoStack.length - 1; i >= 0; i--) {
        const e = this.undoStack[i];
        if (
          e.type === 'approve' &&
          e.repoRoot === file.repoRoot &&
          e.filePath === filePath &&
          e.hunkId === hunkId
        ) {
          this.undoStack.splice(i, 1);
          break;
        }
      }
      this.persist();
    }
  }

  /**
   * Undo the last action. Returns the affected file or null if stack is empty.
   */
  async undo(): Promise<{
    repoRoot: string;
    filePath: string;
    undoneType: 'approve' | 'reject';
  } | null> {
    const entry = this.undoStack.pop();
    if (!entry) {
      return null;
    }

    if (entry.type === 'approve') {
      const map = this.statuses.get(fileKey(entry.repoRoot, entry.filePath));
      if (map && map.has(entry.hunkId)) {
        map.set(entry.hunkId, 'pending');
      }
    } else if (entry.type === 'reject') {
      const git = this.git.getAdapter(entry.repoRoot);
      if (entry.forwardPatch) {
        await git.applyForward(entry.forwardPatch);
      } else if (entry.untrackedInsert) {
        await git.reInsertUntrackedLines(
          entry.filePath,
          entry.untrackedInsert.lineIndex,
          entry.untrackedInsert.lines,
        );
      }
    }

    this.persist();
    return { repoRoot: entry.repoRoot, filePath: entry.filePath, undoneType: entry.type };
  }

  /**
   * Clear all state (e.g., on full refresh).
   */
  clear(): void {
    this.statuses.clear();
    this.undoStack = [];
    this.persist();
  }

  /**
   * Remove files that are no longer in the diff (e.g., after a commit).
   */
  pruneCommittedFiles(currentDiffFiles: DiffFile[]): void {
    const currentPaths = new Set(currentDiffFiles.map((f) => fileKeyOf(f)));
    let changed = false;
    for (const path of this.statuses.keys()) {
      if (!currentPaths.has(path)) {
        this.statuses.delete(path);
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  private persist(): void {
    if (!this.storage) {
      return;
    }
    const data: Record<string, Record<string, HunkStatus>> = {};
    for (const [key, map] of this.statuses) {
      const obj: Record<string, HunkStatus> = {};
      for (const [id, status] of map) {
        // Only persist approved (pending is default, rejected hunks are gone)
        if (status === 'approved') {
          obj[id] = status;
        }
      }
      if (Object.keys(obj).length > 0) {
        data[key] = obj;
      }
    }
    this.storage.update(STORAGE_KEY, data);
  }

  private restoreFromStorage(): void {
    if (!this.storage) {
      return;
    }
    const data = this.storage.get<Record<string, Record<string, HunkStatus>>>(STORAGE_KEY);
    if (!data) {
      return;
    }
    for (const [key, obj] of Object.entries(data)) {
      // Entries persisted before multi-repo support were keyed by bare path
      // and can never match again; drop them.
      if (!key.includes('\0')) {
        continue;
      }
      const map = new Map<string, HunkStatus>();
      for (const [id, status] of Object.entries(obj)) {
        map.set(id, status);
      }
      this.statuses.set(key, map);
    }
  }
}

/**
 * Build a valid unified diff patch string for a single hunk,
 * suitable for piping to `git apply`.
 */
function buildPatch(file: DiffFile, hunk: DiffHunk): string {
  return [...file.diffHeader, ...hunk.rawLines].join('\n') + '\n';
}
