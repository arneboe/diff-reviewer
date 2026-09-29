import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate every test repo from the user's git configuration. GitAdapter
// spawns git with process.env, so these apply to it as well.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Test';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'Test';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

/** A throwaway git repository for one test. */
export class GitSandbox {
  readonly root: string;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'diff-reviewer-git-'));
    this.git('init', '-q');
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.root, encoding: 'utf-8' });
  }

  write(path: string, content: string): void {
    writeFileSync(join(this.root, path), content);
  }

  read(path: string): string {
    return readFileSync(join(this.root, path), 'utf-8');
  }

  remove(path: string): void {
    unlinkSync(join(this.root, path));
  }

  chmod(path: string, mode: number): void {
    chmodSync(join(this.root, path), mode);
  }

  commitAll(message = 'commit'): void {
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
  }

  /** `git diff --cached` (what is approved). */
  staged(): string {
    return this.git('diff', '--cached');
  }

  /** `git diff` (what is pending). */
  unstaged(): string {
    return this.git('diff');
  }

  lsFiles(path: string): string {
    return this.git('ls-files', '-s', '--', path);
  }

  status(): string {
    return this.git('status', '--porcelain');
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Numbered lines "l1\nl2\n…" for building test files. */
export function lines(count: number, prefix = 'l'): string {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`).join('\n') + '\n';
}
