import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { buildPatch } from '../src/git/diffParser';
import { GitAdapter } from '../src/git/gitAdapter';
import { GitSandbox, lines } from './helpers/gitSandbox';

describe('GitAdapter', () => {
  let repo: GitSandbox;
  let git: GitAdapter;

  beforeEach(() => {
    repo = new GitSandbox();
    git = new GitAdapter(repo.root);
  });

  afterEach(() => repo.cleanup());

  it('reports only unstaged changes and untracked files', async () => {
    repo.write('a.txt', lines(5));
    repo.write('b.txt', lines(5));
    repo.commitAll();
    repo.write('a.txt', lines(5).replace('l2', 'staged'));
    repo.git('add', 'a.txt');
    repo.write('b.txt', lines(5).replace('l4', 'unstaged'));
    repo.write('new.txt', 'x\ny\n');

    const files = await git.getDiff();
    const byPath = new Map(files.map((f) => [f.newPath, f]));

    assert.equal(byPath.has('a.txt'), false, 'fully staged file is approved and hidden');
    assert.equal(byPath.get('b.txt')!.hunks.length, 1);
    assert.equal(byPath.get('b.txt')!.kind, 'modified');
    assert.equal(byPath.get('new.txt')!.isUntracked, true);
    assert.equal(byPath.get('new.txt')!.hunks[0].newCount, 2);
    for (const f of files) {
      assert.equal(f.repoRoot, repo.root);
    }
  });

  it('shows only the unstaged part of a partially staged file', async () => {
    repo.write('a.txt', lines(10));
    repo.commitAll();
    repo.write('a.txt', lines(10).replace('l2', 'first').replace('l8', 'second'));
    repo.git('add', 'a.txt');
    repo.write(
      'a.txt',
      lines(10).replace('l2', 'first').replace('l8', 'second').replace('l5', 'third'),
    );

    const file = await git.getFileDiff('a.txt');
    assert.ok(file);
    assert.equal(file.hunks.length, 1);
    assert.deepEqual(
      file.hunks[0].lines.map((l) => `${l.type}:${l.content}`),
      ['remove:l5', 'add:third'],
    );
  });

  it('describes deleted, intent-to-add, binary and mode-only files', async () => {
    repo.write('gone.txt', 'a\n');
    repo.write('script.sh', 'echo\n');
    repo.write('pic.dat', 'x\0y');
    repo.commitAll();
    repo.remove('gone.txt');
    repo.chmod('script.sh', 0o755);
    repo.write('pic.dat', 'x\0z');
    repo.write('ita.txt', 'hello\n');
    repo.git('add', '-N', 'ita.txt');

    const byPath = new Map((await git.getDiff()).map((f) => [f.newPath, f]));

    const gone = byPath.get('gone.txt')!;
    assert.equal(gone.kind, 'deleted');
    assert.equal(gone.worktreeMissing, true);

    const ita = byPath.get('ita.txt')!;
    assert.equal(ita.kind, 'added');
    assert.equal(ita.isUntracked, false);

    const pic = byPath.get('pic.dat')!;
    assert.equal(pic.isBinary, true);
    assert.equal(pic.hunks.length, 0);

    const script = byPath.get('script.sh')!;
    assert.deepEqual(script.modeChange, { from: '100644', to: '100755' });
    assert.equal(script.hunks.length, 0);
  });

  it('stages a hunk exactly even when an unstaged insertion sits above it', async () => {
    repo.write('a.txt', lines(10));
    repo.commitAll();
    // Unstaged insertion of three lines at the top, change further down.
    repo.write('a.txt', 'i1\ni2\ni3\n' + lines(10).replace('l8', 'changed'));

    const file = (await git.getFileDiff('a.txt'))!;
    const lower = file.hunks.find((h) => h.lines.some((l) => l.content === 'changed'))!;
    await git.applyCached(buildPatch(file, lower));

    assert.equal(repo.git('show', ':a.txt'), lines(10).replace('l8', 'changed'));
    const rest = (await git.getFileDiff('a.txt'))!;
    assert.equal(rest.hunks.length, 1);
    assert.deepEqual(
      rest.hunks[0].lines.map((l) => l.content),
      ['i1', 'i2', 'i3'],
    );

    await git.applyCachedReverse(buildPatch(file, lower));
    assert.equal(repo.staged(), '');
  });

  it('stages and rejects the last line of a file without trailing newline', async () => {
    repo.write('n.txt', 'one\ntwo');
    repo.commitAll();
    repo.write('n.txt', 'one\ntwo\nthree');

    const file = (await git.getFileDiff('n.txt'))!;
    assert.equal(file.hunks.length, 1);
    await git.applyCached(buildPatch(file, file.hunks[0]));
    assert.equal(repo.git('show', ':n.txt'), 'one\ntwo\nthree');
    assert.equal(await git.getFileDiff('n.txt'), null);

    repo.git('reset', '-q');
    await git.applyReverse(buildPatch(file, file.hunks[0]));
    assert.equal(repo.read('n.txt'), 'one\ntwo');
  });

  it('detects intent-to-add entries and restores them', async () => {
    repo.write('base.txt', 'x\n');
    repo.commitAll();
    repo.write('ita.txt', 'hello\n');
    repo.git('add', '-N', 'ita.txt');
    repo.write('empty.txt', '');
    repo.git('add', 'empty.txt');

    const ita = await git.readIndexEntry('ita.txt');
    assert.equal(ita?.intentToAdd, true);
    const empty = await git.readIndexEntry('empty.txt');
    assert.equal(empty?.intentToAdd, false);
    assert.equal(await git.readIndexEntry('missing.txt'), null);

    await git.addPath('ita.txt');
    await git.restoreIndexEntry('ita.txt', ita);
    assert.match(repo.status(), /^ A ita\.txt$/m);
  });

  it('re-creates a removed index entry', async () => {
    repo.write('a.txt', 'a\n');
    repo.commitAll();
    const before = await git.readIndexEntry('a.txt');
    repo.git('rm', '-q', '--cached', 'a.txt');
    assert.equal(await git.readIndexEntry('a.txt'), null);

    await git.restoreIndexEntry('a.txt', before);
    assert.equal(repo.staged(), '');
  });

  it('restores a deleted file with its mode from the index', async () => {
    repo.write('run.sh', 'echo\n');
    repo.chmod('run.sh', 0o755);
    repo.commitAll();
    repo.remove('run.sh');

    await git.checkoutIndexPath('run.sh');
    assert.equal(repo.read('run.sh'), 'echo\n');
    assert.ok((await git.worktreeMode('run.sh')) & 0o100, 'executable bit restored');
  });

  it('reports HEAD and staged state, also in an unborn repository', async () => {
    assert.equal(await git.headSha(), '');
    assert.equal(await git.hasStagedChanges(), false);
    repo.write('a.txt', 'a\n');
    repo.git('add', 'a.txt');
    assert.equal(await git.hasStagedChanges(), true);
    repo.git('commit', '-q', '-m', 'x');
    assert.match(await git.headSha(), /^[0-9a-f]{40}$/);
    assert.equal(await git.hasStagedChanges(), false);
  });
});
