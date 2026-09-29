import * as path from 'path';
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

/** Per-repository facts the extension needs besides the file list. */
export interface RepoState {
  headSha: string;
  hasStaged: boolean;
}

/** Minimal interface StateManager needs to reach a repository's git adapter. */
export interface GitResolver {
  getAdapter(repoRoot: string): GitAdapter;
}

/**
 * Owns one GitAdapter per discovered repository.
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

  /** Repository root containing an absolute path (innermost match), if any. */
  repoForPath(absPath: string): string | undefined {
    let best: string | undefined;
    for (const r of this.repos) {
      if (absPath === r.root || absPath.startsWith(r.root + path.sep)) {
        if (!best || r.root.length > best.length) {
          best = r.root;
        }
      }
    }
    return best;
  }

  /** HEAD and staged-ness of one repository. */
  async getRepoState(repoRoot: string): Promise<RepoState> {
    const adapter = this.getAdapter(repoRoot);
    const [headSha, hasStaged] = await Promise.all([adapter.headSha(), adapter.hasStagedChanges()]);
    return { headSha, hasStaged };
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
