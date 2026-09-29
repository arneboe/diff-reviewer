import { execFile } from 'child_process';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';

/** Directories never descended into while scanning for nested repositories. */
const SKIPPED_DIRS = new Set(['node_modules', 'bower_components', '.git']);

/**
 * Resolve the git top-level directory containing `dir`, or null if `dir` is
 * not inside a git work tree.
 */
export function gitToplevel(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd: dir }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const out = stdout.trim();
      resolve(out.length > 0 ? out : null);
    });
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively look for directories containing a `.git` entry (directory or
 * file, the latter for worktrees/submodules). Does not descend into a
 * directory once it is identified as a repository.
 */
async function scanForRepos(dir: string, depth: number, maxDepth: number, out: string[]) {
  let entries: import('fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const subdirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (await exists(join(full, '.git'))) {
      out.push(full);
    } else if (depth + 1 < maxDepth) {
      subdirs.push(full);
    }
  }

  await Promise.all(subdirs.map((d) => scanForRepos(d, depth + 1, maxDepth, out)));
}

/**
 * Discover git repositories for a set of workspace folders.
 *
 * For each folder: if the folder itself lies inside a git work tree, that
 * work tree is the (only) repository for the folder. Otherwise the folder's
 * subdirectories are scanned up to `maxDepth` levels for nested repositories.
 *
 * Returns absolute, de-duplicated, sorted repository roots.
 */
export async function discoverRepos(folders: string[], maxDepth = 10): Promise<string[]> {
  const roots = new Set<string>();

  for (const folder of folders) {
    const top = await gitToplevel(folder);
    if (top) {
      roots.add(top);
      continue;
    }

    const candidates: string[] = [];
    await scanForRepos(folder, 0, Math.max(1, maxDepth), candidates);

    // Canonicalise each candidate through git so the path matches what git
    // itself reports (symlinks, casing), and drop false positives.
    const resolved = await Promise.all(candidates.map((c) => gitToplevel(c)));
    for (const r of resolved) {
      if (r) {
        roots.add(r);
      }
    }
  }

  return [...roots].sort();
}
