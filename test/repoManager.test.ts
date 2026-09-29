import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { RepoManager } from '../src/git/repoManager';
import './helpers/gitSandbox';

describe('RepoManager.repoForPath', () => {
  let parent: string;
  let manager: RepoManager;
  let alpha: string;
  let beta: string;

  before(async () => {
    parent = mkdtempSync(join(tmpdir(), 'diff-reviewer-mgr-'));
    for (const name of ['alpha', 'beta']) {
      mkdirSync(join(parent, name));
      execFileSync('git', ['init', '-q'], { cwd: join(parent, name) });
    }
    mkdirSync(join(parent, 'plain'));
    manager = new RepoManager([parent], 3);
    const repos = await manager.discover();
    alpha = repos.find((r) => r.name === 'alpha')!.root;
    beta = repos.find((r) => r.name === 'beta')!.root;
  });

  after(() => rmSync(parent, { recursive: true, force: true }));

  it('maps a path to the repository that contains it', () => {
    assert.equal(manager.repoForPath(join(alpha, 'src', 'x.ts')), alpha);
    assert.equal(manager.repoForPath(join(beta, 'y.txt')), beta);
    assert.equal(manager.repoForPath(alpha), alpha);
  });

  it('returns undefined outside every repository and for name prefixes', () => {
    assert.equal(manager.repoForPath(join(parent, 'plain', 'z.txt')), undefined);
    assert.equal(manager.repoForPath(`${alpha}-other/file`), undefined);
  });
});
