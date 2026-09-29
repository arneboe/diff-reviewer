import * as path from 'path';
import { DiffFile } from '../types';
import { GitAdapter } from './gitAdapter';
import { discoverRepos } from './repoDiscovery';

export interface RepoInfo {
  /** Absolute repository root */
  root: string;
  /** Short display name (directory name) */
  name: string;
  /** Path relative to the workspace folder containing the repo, '' if identical */
  relativePath: string;
}

/** Minimal interface StateManager needs to reach a repository's git adapter. */
export interface GitResolver {
  getAdapter(repoRoot: string): GitAdapter;
}

/**
 * Owns one GitAdapter per discovered repository and aggregates diffs across
 * all of them.
 */
export class RepoManager implements GitResolver {
  private adapters = new Map<string, GitAdapter>();
  private repos: RepoInfo[] = [];

  constructor(
    private workspaceFolders: string[],
    private maxDepth: number,
  ) {}

  setWorkspaceFolders(folders: string[]): void {
    this.workspaceFolders = folders;
  }

  setMaxDepth(depth: number): void {
    this.maxDepth = depth;
  }

  /** Re-discover repositories, keeping adapters for roots that still exist. */
  async discover(): Promise<RepoInfo[]> {
    const roots = await discoverRepos(this.workspaceFolders, this.maxDepth);

    for (const root of [...this.adapters.keys()]) {
      if (!roots.includes(root)) {
        this.adapters.delete(root);
      }
    }
    for (const root of roots) {
      if (!this.adapters.has(root)) {
        this.adapters.set(root, new GitAdapter(root));
      }
    }

    this.repos = roots
      .map((root) => ({
        root,
        name: path.basename(root),
        relativePath: this.relativeToWorkspace(root),
      }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    return this.repos;
  }

  getRepos(): RepoInfo[] {
    return this.repos;
  }

  getAdapter(repoRoot: string): GitAdapter {
    let adapter = this.adapters.get(repoRoot);
    if (!adapter) {
      adapter = new GitAdapter(repoRoot);
      this.adapters.set(repoRoot, adapter);
    }
    return adapter;
  }

  /**
   * Diff of every repository, in repo order. A repository whose diff fails
   * (e.g. no commits yet) is skipped so the others still show up.
   */
  async getDiff(): Promise<DiffFile[]> {
    const results = await Promise.allSettled(
      this.repos.map((r) => this.getAdapter(r.root).getDiff()),
    );
    const files: DiffFile[] = [];
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        files.push(...res.value);
      } else {
        console.error(`Diff Reviewer: failed to diff ${this.repos[i].root}:`, res.reason);
      }
    });
    return files;
  }

  private relativeToWorkspace(root: string): string {
    for (const folder of this.workspaceFolders) {
      const rel = path.relative(folder, root);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        return rel;
      }
    }
    return root;
  }
}
