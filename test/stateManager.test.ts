import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { GitAdapter } from '../src/git/gitAdapter';
import { GitResolver } from '../src/git/repoManager';
import { StateManager, UndoRefusedError } from '../src/state/stateManager';
import { DiffFile } from '../src/types';
import { GitSandbox, lines } from './helpers/gitSandbox';

function resolverFor(...sandboxes: GitSandbox[]): GitResolver & { requested: string[] } {
  const adapters = new Map(sandboxes.map((s) => [s.root, new GitAdapter(s.root)]));
  const requested: string[] = [];
  return {
    requested,
    getAdapter(repoRoot: string) {
      requested.push(repoRoot);
      const adapter = adapters.get(repoRoot);
      if (!adapter) {
        throw new Error(`unknown repo ${repoRoot}`);
      }
      return adapter;
    },
  };
}

describe('StateManager', () => {
  let repo: GitSandbox;
  let git: GitAdapter;
  let state: StateManager;

  const load = async (path: string): Promise<DiffFile> => {
    const file = await git.getFileDiff(path);
    assert.ok(file, `${path} should have unstaged changes`);
    return file;
  };

  beforeEach(() => {
    repo = new GitSandbox();
    git = new GitAdapter(repo.root);
    state = new StateManager(resolverFor(repo));
  });

  afterEach(() => repo.cleanup());

  it('approve stages exactly one hunk and undo unstages it', async () => {
    repo.write('a.txt', lines(10));
    repo.commitAll();
    repo.write('a.txt', lines(10).replace('l2', 'A').replace('l8', 'B'));

    const file = await load('a.txt');
    assert.equal(file.hunks.length, 2);
    const indexBefore = repo.lsFiles('a.txt');

    const after = await state.approve(file, file.hunks[1].id!);
    assert.ok(after);
    assert.equal(after.hunks.length, 1);
    assert.match(repo.staged(), /\+B/);
    assert.doesNotMatch(repo.staged(), /\+A/);

    const undone = await state.undo();
    assert.equal(undone?.undone, 'approve');
    assert.equal(repo.lsFiles('a.txt'), indexBefore);
    assert.equal(repo.staged(), '');

    // Approve again after undo works the same way
    const again = await load('a.txt');
    await state.approve(again, again.hunks[1].id!);
    assert.match(repo.staged(), /\+B/);
  });

  it('approving the last hunk leaves nothing to review', async () => {
    repo.write('a.txt', lines(3));
    repo.commitAll();
    repo.write('a.txt', lines(3).replace('l2', 'X'));

    const file = await load('a.txt');
    assert.equal(await state.approve(file, file.hunks[0].id!), null);
    assert.equal(await git.getFileDiff('a.txt'), null);
  });

  it('reject discards a hunk on disk and undo restores it', async () => {
    repo.write('a.txt', lines(10));
    repo.commitAll();
    const edited = 'top\n' + lines(10).replace('l8', 'B');
    repo.write('a.txt', edited);

    const file = await load('a.txt');
    const lower = file.hunks.find((h) => h.lines.some((l) => l.content === 'B'))!;
    await state.reject(file, lower.id!);
    assert.equal(repo.read('a.txt'), 'top\n' + lines(10));

    const undone = await state.undo();
    assert.equal(undone?.undone, 'reject');
    assert.equal(repo.read('a.txt'), edited);
  });

  it('approve on an untracked file stages it; undo makes it untracked again', async () => {
    repo.write('base.txt', 'x\n');
    repo.commitAll();
    repo.write('new.txt', 'a\nb\n');

    const file = await load('new.txt');
    assert.equal(file.isUntracked, true);
    assert.equal(await state.approve(file, file.hunks[0].id!), null);
    assert.match(repo.status(), /^A {2}new\.txt$/m);

    await state.undo();
    assert.match(repo.status(), /^\?\? new\.txt$/m);
  });

  it('reject on an untracked file deletes it; undo writes it back', async () => {
    repo.write('base.txt', 'x\n');
    repo.commitAll();
    repo.write('new.txt', 'a\nb\n');

    const file = await load('new.txt');
    assert.equal(await state.reject(file, file.hunks[0].id!), null);
    assert.doesNotMatch(repo.status(), /new\.txt/);

    await state.undo();
    assert.equal(repo.read('new.txt'), 'a\nb\n');
    assert.match(repo.status(), /^\?\? new\.txt$/m);
  });

  it('reject on an intent-to-add file removes file and entry; undo restores both', async () => {
    repo.write('base.txt', 'x\n');
    repo.commitAll();
    repo.write('ita.txt', 'hello\n');
    repo.git('add', '-N', 'ita.txt');

    const file = await load('ita.txt');
    await state.rejectAll(file);
    assert.equal(repo.status(), '');

    await state.undo();
    assert.equal(repo.read('ita.txt'), 'hello\n');
    assert.match(repo.status(), /^ A ita\.txt$/m);
  });

  it('approve file on an intent-to-add file, then undo, keeps the intent-to-add entry', async () => {
    repo.write('base.txt', 'x\n');
    repo.commitAll();
    repo.write('ita.txt', 'hello\n');
    repo.git('add', '-N', 'ita.txt');

    await state.approveAll(await load('ita.txt'));
    assert.match(repo.staged(), /\+hello/);

    await state.undo();
    assert.match(repo.status(), /^ A ita\.txt$/m);
    assert.equal(repo.staged(), '');
  });

  it('deleted file: approve stages the deletion, reject restores it', async () => {
    repo.write('gone.txt', 'a\nb\n');
    repo.commitAll();
    repo.remove('gone.txt');

    const file = await load('gone.txt');
    await state.approve(file, file.hunks[0].id!);
    assert.match(repo.status(), /^D {2}gone\.txt$/m);

    await state.undo();
    assert.match(repo.status(), /^ D gone\.txt$/m);

    await state.reject(await load('gone.txt'), '');
    assert.equal(repo.read('gone.txt'), 'a\nb\n');
    assert.equal(repo.status(), '');
  });

  it('rejectAll reverts every hunk and a mode change, each undoable', async () => {
    repo.write('s.sh', lines(10));
    repo.commitAll();
    repo.write('s.sh', lines(10).replace('l2', 'A').replace('l8', 'B'));
    repo.chmod('s.sh', 0o755);

    assert.equal(await state.rejectAll(await load('s.sh')), null);
    assert.equal(repo.status(), '');

    await state.undo(); // mode
    await state.undo(); // one hunk
    await state.undo(); // the other hunk
    assert.equal(repo.read('s.sh'), lines(10).replace('l2', 'A').replace('l8', 'B'));
    assert.ok((await git.worktreeMode('s.sh')) & 0o100, 'executable bit restored');
  });

  it('refuses to undo an approval after a commit', async () => {
    repo.write('a.txt', lines(3));
    repo.commitAll();
    repo.write('a.txt', lines(3).replace('l2', 'X'));

    const file = await load('a.txt');
    await state.approve(file, file.hunks[0].id!);
    repo.git('commit', '-q', '-m', 'approved work');

    await assert.rejects(state.undo(), UndoRefusedError);
    assert.equal(repo.staged(), '');
    assert.equal(await state.undo(), null, 'the refused entry is dropped');
  });

  it('pruneForHead drops entries recorded against another HEAD', async () => {
    repo.write('a.txt', lines(3));
    repo.commitAll();
    repo.write('a.txt', lines(3).replace('l2', 'X'));
    const file = await load('a.txt');
    await state.approve(file, file.hunks[0].id!);
    repo.git('commit', '-q', '-m', 'x');

    state.pruneForHead(repo.root, await git.headSha());
    assert.equal(state.hasUndo(), false);
  });

  it('routes actions and undo to the repository of each file', async () => {
    const other = new GitSandbox();
    try {
      const resolver = resolverFor(repo, other);
      state = new StateManager(resolver);
      for (const r of [repo, other]) {
        r.write('same.txt', lines(3));
        r.commitAll();
        r.write('same.txt', lines(3).replace('l2', 'X'));
      }
      const otherGit = new GitAdapter(other.root);

      const a = (await git.getFileDiff('same.txt'))!;
      await state.approve(a, a.hunks[0].id!);
      const b = (await otherGit.getFileDiff('same.txt'))!;
      await state.reject(b, b.hunks[0].id!);

      assert.match(repo.staged(), /\+X/);
      assert.equal(other.status(), '');

      assert.equal((await state.undo())?.repoRoot, other.root);
      assert.equal(other.read('same.txt'), lines(3).replace('l2', 'X'));
      assert.equal((await state.undo())?.repoRoot, repo.root);
      assert.equal(repo.staged(), '');
      assert.equal(resolver.requested.includes(other.root), true);
    } finally {
      other.cleanup();
    }
  });
});
