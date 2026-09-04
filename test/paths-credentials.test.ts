import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { credentialFilePath } from '../src/platform/paths.js';
import { deleteToken, readToken, saveTokenAtomic } from '../src/platform/credentials.js';
import { writePrivateFileAtomic } from '../src/platform/private-file.js';

const token = `cky_${'A'.repeat(50)}`;

test('maps Unix, Windows, spaces, and non-ASCII homes without using shell variables', () => {
  assert.equal(credentialFilePath({ homeDir: '/Users/José García', platform: 'darwin', env: {} }), '/Users/José García/.cookiy/earn-token.txt');
  assert.equal(credentialFilePath({ homeDir: 'C:\\Users\\Jane Doe', platform: 'win32', env: {} }), 'C:\\Users\\Jane Doe\\.cookiy\\earn-token.txt');
  assert.equal(credentialFilePath({ homeDir: '/ignored', platform: 'linux', env: { COOKIY_EARN_CREDENTIALS: '/tmp/custom token' } }), '/tmp/custom token');
});

test('atomically saves, reads, and deletes only the credential file, with Unix mode 0600', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-credential-'));
  const destination = join(root, 'nested dir', 'crédential.txt');
  const options = { platform: process.platform, env: { COOKIY_EARN_CREDENTIALS: destination } };
  await saveTokenAtomic(token, options);
  assert.equal(await readToken(options), token);
  if (process.platform !== 'win32') {
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'nested dir'))).mode & 0o777, 0o700);
  }
  assert.equal(await readFile(destination, 'utf8'), `${token}\n`);
  assert.equal(await deleteToken(options), true);
  assert.equal(await deleteToken(options), false);
});

test('rejects malformed tokens before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-invalid-'));
  const destination = join(root, 'token.txt');
  await assert.rejects(() => saveTokenAtomic('bad-token', { env: { COOKIY_EARN_CREDENTIALS: destination } }), /exactly 54/);
  await assert.rejects(() => readFile(destination), /ENOENT/);
});

test('missing credentials provide login instructions while preserving the filesystem cause', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-missing-credential-'));
  const destination = join(root, 'missing-token.txt');
  await assert.rejects(() => readToken({ env: { COOKIY_EARN_CREDENTIALS: destination } }), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^Not signed in.*auth save.*ENOENT/);
    assert.equal((error.cause as NodeJS.ErrnoException).code, 'ENOENT');
    assert.ok(!error.message.includes(destination));
    return true;
  });
});

test('malformed saved credentials provide recovery instructions without echoing their contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-malformed-credential-'));
  const destination = join(root, 'token.txt');
  const invalidToken = 'private-invalid-token';
  await writeFile(destination, invalidToken);
  await assert.rejects(() => readToken({ env: { COOKIY_EARN_CREDENTIALS: destination } }), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /save.*login token again.*auth save/);
    assert.ok(!error.message.includes(invalidToken));
    return true;
  });
});

test('does not tighten an existing override directory owned by another workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-shared-parent-'));
  const shared = join(root, 'shared');
  await mkdir(shared);
  if (process.platform !== 'win32') await chmod(shared, 0o755);
  const destination = join(shared, 'token.txt');
  await saveTokenAtomic(token, { platform: process.platform, env: { COOKIY_EARN_CREDENTIALS: destination } });
  if (process.platform !== 'win32') assert.equal((await stat(shared)).mode & 0o777, 0o755);
});

test('atomic private writes replace permissive files with mode 0600', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-private-write-'));
  const destination = join(root, 'facts.json');
  await writeFile(destination, 'old', { mode: 0o644 });
  if (process.platform !== 'win32') await chmod(destination, 0o644);
  await writePrivateFileAtomic(destination, 'new');
  assert.equal(await readFile(destination, 'utf8'), 'new');
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600);
});
