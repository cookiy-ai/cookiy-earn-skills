import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runCli, type CliIo } from '../src/cli.js';
import { renderDataSummary, validateFactsReport } from '../src/core/data-summary.js';
import { validateMarkdownBuffer } from '../src/core/markdown-contract.js';
import { computeFactsWithTopicReview } from '../src/core/statistics.js';
import { applyTopicReview, TOPICS, validateTopicReviewArtifact } from '../src/core/topics.js';

async function multilingualReview() {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-topics-'));
  const file = join(root, 'sessions.jsonl');
  const long = `\u90e8\u7f72\u6d41\u6c34\u7ebf ${'\u754c'.repeat(700)}`;
  await writeFile(file, [
    JSON.stringify({ type: 'user', sessionId: 'zh', message: { role: 'user', content: '\u8bf7\u4fee\u590d React \u7ec4\u4ef6\u7684\u56de\u5f52\u6d4b\u8bd5\u3002' } }),
    JSON.stringify({ type: 'user', sessionId: 'zh', message: { role: 'user', content: '\u90ae\u7bb1 alice@example.com\uff0cAPI_KEY=super-secret-value' } }),
    JSON.stringify({ type: 'user', sessionId: 'zh', message: { role: 'user', content: long } }),
    JSON.stringify({ type: 'user', sessionId: 'zh', message: { role: 'user', content: '\u7b2c\u56db\u6bb5\u4e0d\u5e94\u4fdd\u7559\u3002' } }),
    JSON.stringify({ type: 'user', sessionId: 'mixed-language', message: { role: 'user', content: 'Fix the API\uff0c\u7136\u540e\u66f4\u65b0\u524d\u7aef\u9875\u9762\u3002' } }),
    JSON.stringify({ type: 'user', sessionId: 'swahili', message: { role: 'user', content: 'Tafadhali rekebisha programu hii.' } }),
  ].join('\n'));
  return computeFactsWithTopicReview(
    [{ source: 'claude_code', path: file }],
    new Date('2026-09-04T00:00:00Z'),
  );
}

test('creates bounded, redacted, multilingual Topic evidence without classifying by keyword', async () => {
  const { facts, topicReview } = await multilingualReview();
  assert.equal(facts.overall.sessionCount, 3);
  assert.equal(topicReview.sessionCount, 3);
  assert.deepEqual(topicReview.sessions.map((session) => session.primaryTopic), [null, null, null]);
  assert.equal(topicReview.sessions[0]!.userEvidence.length, 3);
  assert.ok([...topicReview.sessions[0]!.userEvidence[2]!].length <= 600);
  const serialized = JSON.stringify(topicReview);
  assert.ok(serialized.includes('[REDACTED_EMAIL]'));
  assert.ok(serialized.includes('[REDACTED]'));
  assert.ok(!serialized.includes('alice@example.com'));
  assert.ok(!serialized.includes('super-secret-value'));
  assert.ok(!serialized.includes('\u7b2c\u56db\u6bb5\u4e0d\u5e94\u4fdd\u7559'));
  assert.ok(!serialized.includes('sessions.jsonl'));
  assert.ok(!serialized.includes('sessionId'));
  assert.equal('technicalSignals' in topicReview.sessions[0]!, false);
  assert.deepEqual(facts.topicReview!.evidenceRefs, topicReview.sessions.map((session) => session.evidenceRef));
});

test('uses report-local random references and population hashes', async () => {
  const first = await multilingualReview();
  const second = await multilingualReview();
  assert.notEqual(first.topicReview.populationSha256, second.topicReview.populationSha256);
  assert.notDeepEqual(first.topicReview.sessions.map((session) => session.evidenceRef), second.topicReview.sessions.map((session) => session.evidenceRef));
});

test('uses canonical Codex user messages and excludes Claude tool results and subagents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-topic-sources-'));
  const codex = join(root, 'codex.jsonl');
  const claude = join(root, 'claude.jsonl');
  await writeFile(codex, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'codex-private-id' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Canonical request.' }] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Duplicate fallback request.' } }),
  ].join('\n'));
  await writeFile(claude, [
    JSON.stringify({ type: 'user', sessionId: 'main', message: { role: 'user', content: 'Human request.' } }),
    JSON.stringify({ type: 'user', sessionId: 'main', message: { role: 'user', content: [{ type: 'tool_result', content: 'Private tool output.' }] } }),
    JSON.stringify({ type: 'user', sessionId: 'side', isSidechain: true, agentId: 'agent', message: { role: 'user', content: 'Internal prompt.' } }),
  ].join('\n'));
  const { topicReview } = await computeFactsWithTopicReview([
    { source: 'codex', path: codex },
    { source: 'claude_code', path: claude },
  ]);
  const evidence = JSON.stringify(topicReview.sessions.map((session) => session.userEvidence));
  assert.ok(evidence.includes('Canonical request.'));
  assert.ok(evidence.includes('Human request.'));
  assert.ok(!evidence.includes('Duplicate fallback request.'));
  assert.ok(!evidence.includes('Private tool output.'));
  assert.ok(!evidence.includes('Internal prompt.'));
  assert.ok(!JSON.stringify(topicReview).includes('codex-private-id'));
});

test('applies only complete reviews and derives immutable complete Topic counts', async () => {
  const { facts, topicReview } = await multilingualReview();
  assert.throws(() => applyTopicReview(facts, topicReview), /incomplete/);
  topicReview.sessions[0]!.primaryTopic = 'frontend';
  topicReview.sessions[1]!.primaryTopic = 'mixed';
  topicReview.sessions[2]!.primaryTopic = 'unknown';
  const classified = validateFactsReport(applyTopicReview(facts, topicReview));
  assert.equal(classified.topicClassification!.denominator, 3);
  assert.equal(classified.topicClassification!.reviewedSessionCount, 3);
  assert.equal(classified.topicClassification!.counts.frontend, 1);
  assert.equal(classified.topicClassification!.counts.mixed, 1);
  assert.equal(classified.topicClassification!.counts.unknown, 1);
  assert.deepEqual(Object.keys(classified.topicClassification!.counts), [...TOPICS]);
  assert.ok(classified.representativeCandidates?.some((candidate) => JSON.stringify(candidate).includes('\u8bf7\u4fee\u590d')));
  assert.ok(!JSON.stringify(classified.topicClassification).includes('\u8bf7\u4fee\u590d'));

  const forged = structuredClone(classified) as unknown as Record<string, unknown>;
  const classification = forged.topicClassification as Record<string, unknown>;
  (classification.counts as Record<string, number>).frontend = 2;
  assert.throws(() => validateFactsReport(forged), /derived from assignments|sum to denominator/);

  const wrongSource = structuredClone(classified) as unknown as Record<string, unknown>;
  const assignments = (wrongSource.topicClassification as Record<string, unknown>).assignments as Array<Record<string, unknown>>;
  assignments[0]!.source = 'codex';
  assert.throws(() => validateFactsReport(wrongSource), /assignment count must match/);

  const partial = structuredClone(classified) as unknown as Record<string, unknown>;
  (partial.topicClassification as Record<string, unknown>).reviewedSessionCount = 2;
  assert.throws(() => validateFactsReport(partial), /reviewedSessionCount must equal denominator/);
});

test('rejects malformed review bindings, illegal Topics, and remaining sensitive evidence', async () => {
  const { facts, topicReview } = await multilingualReview();
  const illegal = structuredClone(topicReview) as unknown as Record<string, unknown>;
  ((illegal.sessions as Array<Record<string, unknown>>)[0]!).primaryTopic = 'testing';
  assert.throws(() => validateTopicReviewArtifact(illegal), /unsupported Topic/);

  const sensitive = structuredClone(topicReview) as unknown as Record<string, unknown>;
  ((sensitive.sessions as Array<Record<string, unknown>>)[0]!).userEvidence = ['alice@example.com'];
  assert.throws(() => validateTopicReviewArtifact(sensitive), /not normalized and redacted|sensitive content/);

  const populationMismatch = structuredClone(topicReview);
  populationMismatch.populationSha256 = '0'.repeat(64);
  populationMismatch.sessions.forEach((session) => { session.primaryTopic = 'other'; });
  assert.throws(() => applyTopicReview(facts, populationMismatch), /populationSha256/);

  const timestampMismatch = structuredClone(topicReview);
  timestampMismatch.generatedAt = '2026-09-05T00:00:00.000Z';
  assert.throws(() => applyTopicReview(facts, timestampMismatch), /generatedAt/);

  const duplicate = structuredClone(topicReview);
  duplicate.sessions[1]!.evidenceRef = duplicate.sessions[0]!.evidenceRef;
  assert.throws(() => validateTopicReviewArtifact(duplicate), /unique/);

  const missing = structuredClone(topicReview) as unknown as Record<string, unknown>;
  (missing.sessions as unknown[]).pop();
  assert.throws(() => validateTopicReviewArtifact(missing), /length must equal sessionCount/);
});

test('renders all Topic rows only for completed classifications and validates their counts against facts', async () => {
  const { facts, topicReview } = await multilingualReview();
  const unavailable = renderDataSummary(facts);
  assert.doesNotMatch(unavailable, /Primary Topic Distribution/);
  assert.doesNotMatch(unavailable, /Primary Topic statistics are unavailable|Limitations/);

  topicReview.sessions[0]!.primaryTopic = 'frontend';
  topicReview.sessions[1]!.primaryTopic = 'mixed';
  topicReview.sessions[2]!.primaryTopic = 'unknown';
  const classified = applyTopicReview(facts, topicReview);
  const markdown = renderDataSummary(classified);
  assert.match(markdown, /#### Primary Topic Distribution/);
  assert.match(markdown, /\| frontend \| 1 \| 33\.33% \|/);
  assert.match(markdown, /\| backend \| 0 \| 0\.00% \|/);
  assert.doesNotMatch(markdown, /classifications can vary between Agents or runs|Limitations/);
  assert.ok(!markdown.includes(topicReview.sessions[0]!.userEvidence[0]!));
  assert.ok(!markdown.includes(topicReview.sessions[0]!.evidenceRef));
  const reviewed = markdown.replace('privacy_reviewed: false', 'privacy_reviewed: true');
  assert.equal(validateMarkdownBuffer(Buffer.from(reviewed), classified).valid, true);
  const tamperedMarkdown = reviewed.replace('| frontend | 1 | 33.33% |', '| frontend | 2 | 66.67% |');
  assert.ok(validateMarkdownBuffer(Buffer.from(tamperedMarkdown), classified).issues
    .some((issue) => issue.code === 'GENERATED_STATISTICS_CHANGED'));

  const changed = structuredClone(classified);
  changed.topicClassification!.assignments[0]!.primaryTopic = 'backend';
  changed.topicClassification!.counts.frontend = 0;
  changed.topicClassification!.counts.backend = 1;
  assert.ok(validateMarkdownBuffer(Buffer.from(reviewed), changed).issues
    .some((issue) => issue.code === 'GENERATED_STATISTICS_CHANGED'));
  assert.notEqual(renderDataSummary(changed), markdown);
});

test('Topic review and classified facts remain private files through the CLI workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-topic-cli-files-'));
  const source = join(root, 'source.jsonl');
  await writeFile(source, JSON.stringify({ type: 'user', sessionId: 'private', message: { role: 'user', content: 'Fix the API.' } }));
  const factsPath = join(root, 'facts.json');
  const reviewPath = join(root, 'facts.topic-review.json');
  const classifiedPath = join(root, 'classified.json');
  const streams = { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() } satisfies CliIo;
  streams.stdin.end();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('network must not be used'); }) as typeof fetch;
  try {
    assert.equal(await runCli([
      'facts', '--source', `claude_code=${source}`, '--output', factsPath,
      '--topic-review-output', reviewPath,
    ], streams), 0);
    const review = JSON.parse(await readFile(reviewPath, 'utf8')) as { sessions: Array<{ primaryTopic: string | null }> };
    review.sessions[0]!.primaryTopic = 'backend';
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    assert.equal(await runCli([
      'topics', 'apply', factsPath, reviewPath, '--output', classifiedPath,
    ], streams), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const classified = await readFile(classifiedPath, 'utf8');
  assert.ok(classified.includes('"representativeCandidates"'));
  assert.ok(classified.includes('Fix the API.'));
  assert.ok(!classified.includes('"userEvidence"'));
  assert.ok(classified.includes('agent_semantic_review_v1'));
  if (process.platform !== 'win32') {
    assert.equal((await stat(factsPath)).mode & 0o777, 0o600);
    assert.equal((await stat(reviewPath)).mode & 0o777, 0o600);
    assert.equal((await stat(classifiedPath)).mode & 0o777, 0o600);
  }
});
