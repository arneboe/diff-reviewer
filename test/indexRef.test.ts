import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { indexQuery, parseIndexQuery } from '../src/review/indexRef';

describe('index document query', () => {
  it('round-trips a file reference', () => {
    const ref = { repoRoot: '/home/me/repo', filePath: 'src/a b/ü.ts' };
    assert.deepEqual(parseIndexQuery(indexQuery(ref)), ref);
  });

  it('rejects queries that are not ours', () => {
    assert.equal(parseIndexQuery(''), undefined);
    assert.equal(parseIndexQuery('not json'), undefined);
    assert.equal(parseIndexQuery('{"repoRoot":"/r"}'), undefined);
    assert.equal(parseIndexQuery('[1,2]'), undefined);
  });
});
