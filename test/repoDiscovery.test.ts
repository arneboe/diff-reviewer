import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { discoverRepos, gitToplevel } from '../src/git/repoDiscovery';

function gitInit(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
}

describe('repoDiscovery', () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'diff-reviewer-repos-'));
    // Layout:
    //   root/                (not a git repo)
    //     alpha/             (repo)
    //     services/beta/     (repo, depth 2)
    //     services/beta/sub/ (nested inside beta — must not be listed separately)
    //     deep/a/b/gamma/    (repo, depth 4 — beyond default depth)
    //     node_modules/dep/  (repo — must be skipped)
    //     .hidden/secret/    (repo — must be skipped)
    //     plain/             (no repo)
    gitInit(join(root, 'alpha'));
    gitInit(join(root, 'services', 'beta'));
    mkdirSync(join(root, 'services', 'beta', 'sub'), { recursive: true });
    gitInit(join(root, 'deep', 'a', 'b', 'gamma'));
    gitInit(join(root, 'node_modules', 'dep'));
    gitInit(join(root, '.hidden', 'secret'));
    mkdirSync(join(root, 'plain'), { recursive: true });
    writeFileSync(join(root, 'plain', 'file.txt'), 'x\n');
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('gitToplevel returns null outside a repo and the root inside one', async () => {
    assert.equal(await gitToplevel(join(root, 'plain')), null);
    const top = await gitToplevel(join(root, 'services', 'beta', 'sub'));
    assert.ok(top);
    assert.equal(top!.endsWith(join('services', 'beta')), true);
  });

  it('finds nested repos below a non-git folder up to the given depth', async () => {
    const repos = await discoverRepos([root], 3);
    const rel = repos.map((r) =>
      r.slice(r.indexOf('diff-reviewer-repos-')).split('/').slice(1).join('/'),
    );
    assert.deepEqual(rel, ['alpha', 'services/beta']);
  });

  it('reaches deeper repos with the default depth', async () => {
    const repos = await discoverRepos([root]);
    assert.equal(
      repos.some((r) => r.endsWith(join('deep', 'a', 'b', 'gamma'))),
      true,
    );
  });

  it('returns only the enclosing repo when the folder itself is inside one', async () => {
    const repos = await discoverRepos([join(root, 'services', 'beta', 'sub')]);
    assert.equal(repos.length, 1);
    assert.equal(repos[0].endsWith(join('services', 'beta')), true);
  });

  it('de-duplicates repos reachable from several workspace folders', async () => {
    const repos = await discoverRepos([root, join(root, 'alpha')]);
    assert.equal(repos.filter((r) => r.endsWith('alpha')).length, 1);
  });
});
