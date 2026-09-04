import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentHash } from '../src/core/content-hash.js';

test('content hashes are stable and content-sensitive', () => {
  assert.equal(contentHash('same'), contentHash(Buffer.from('same')));
  assert.notEqual(contentHash('same'), contentHash('different'));
  assert.match(contentHash('same'), /^[a-f0-9]{64}$/);
});
