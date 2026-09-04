import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli, type CliIo } from '../src/cli.js';

function captureIo(): { io: CliIo; stdout: PassThrough; stderr: PassThrough } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdin.end();
  return { io: { stdout, stderr, stdin }, stdout, stderr };
}

test('upload without per-invocation confirmation stops before file, credential, or network access', async () => {
  const { io, stderr } = captureIo();
  const code = await runCli(['upload', '/does/not/exist.md'], io);
  assert.equal(code, 1);
  assert.match(stderr.read().toString(), /Upload blocked.*--confirm-upload/);
});

test('upload binds consent to the full inspected SHA-256 before credential or network access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-cli-hash-'));
  const file = join(root, 'summary.md');
  await writeFile(file, '# changed summary');
  const { io, stderr } = captureIo();
  const code = await runCli(['upload', file, '--confirm-upload', '0'.repeat(64)], io);
  assert.equal(code, 1);
  assert.match(stderr.read().toString(), /file has changed since consent/);
});

test('help separates local-only commands from API commands', async () => {
  const { io, stdout } = captureIo();
  assert.equal(await runCli(['--help'], io), 0);
  const output = stdout.read().toString();
  assert.match(output, /Local-only commands/);
  assert.match(output, /Credential and API commands/);
  assert.doesNotMatch(output, /topic/i);
});

test('facts generation uses local fixtures without authentication or network access', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('network must not be used'); }) as typeof fetch;
  try {
    const root = await mkdtemp(join(tmpdir(), 'cookiy-cli-facts-'));
    const output = join(root, 'facts.json');
    const { io, stdout, stderr } = captureIo();
    const code = await runCli([
      'facts',
      '--source', `codex=${resolve('test/fixtures/codex')}`,
      '--output', output,
    ], io);
    assert.equal(code, 0, String(stderr.read() ?? ''));
    const log = String(stdout.read() ?? '');
    const facts = await readFile(output, 'utf8');
    assert.match(log, /sessions: 1/);
    assert.ok(!log.includes('alice@example.com'));
    assert.ok(!facts.includes('alice@example.com'));
    assert.ok(!facts.includes('/Users/alice'));
    assert.equal(JSON.parse(facts).topicReview, undefined);
    assert.equal(JSON.parse(facts).topicClassification, undefined);
    assert.deepEqual(await readdir(root), ['facts.json']);
    assert.doesNotMatch(log, /topic/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('render creates a facts-bound v1 draft without network access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-cli-render-'));
  const factsPath = join(root, 'facts.json');
  const draftPath = join(root, 'draft.md');
  const factsIo = captureIo();
  assert.equal(await runCli([
    'facts',
    '--source', `codex=${resolve('test/fixtures/codex')}`,
    '--output', factsPath,
  ], factsIo.io), 0);
  const renderIo = captureIo();
  assert.equal(await runCli(['render', factsPath, '--output', draftPath], renderIo.io), 0);
  const draft = await readFile(draftPath, 'utf8');
  assert.match(draft, /format_version: cookiy\.data-summary\.v1/);
  assert.doesNotMatch(draft, /facts_sha256/);
  assert.match(draft, /privacy_reviewed: false/);
  assert.match(draft, /This report summarizes 1 coding session from Codex/);
  assert.match(draft, /Recognized source records/);
  assert.doesNotMatch(draft, /cookiy:generated-statistics|Limitations/);
  assert.match(draft, /## Key Highlights\n\n- \*\*Coverage:\*\*/);
  assert.match(draft, /- \*\*Interaction volume:\*\*/);
  assert.match(draft, /- \*\*Tool use:\*\*/);
  assert.doesNotMatch(draft, /No evidence-backed highlights were added/);
  assert.doesNotMatch(draft, /Topic Distribution|Behavioral Signals|### Example 1\./);

  const inspectIo = captureIo();
  await runCli(['inspect', draftPath, '--facts', factsPath], inspectIo.io);
  assert.match(inspectIo.stdout.read().toString(), /sha256: [a-f0-9]{64}/);
});

test('render blocks an unapplied explicitly requested Topic review instead of silently omitting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-cli-explicit-topic-'));
  const factsPath = join(root, 'facts.json');
  const draftPath = join(root, 'draft.md');
  const factsIo = captureIo();
  assert.equal(await runCli([
    'facts',
    '--source', `codex=${resolve('test/fixtures/codex')}`,
    '--output', factsPath,
    '--topic-review-output', join(root, 'review.json'),
  ], factsIo.io), 0);

  const renderIo = captureIo();
  assert.equal(await runCli(['render', factsPath, '--output', draftPath], renderIo.io), 1);
  assert.match(renderIo.stderr.read().toString(), /explicitly requested Topic review has not been applied/);
});
