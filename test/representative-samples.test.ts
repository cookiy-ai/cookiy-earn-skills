import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { renderDataSummary, validateFactsReport } from '../src/core/data-summary.js';
import { contentHash } from '../src/core/content-hash.js';
import { validateMarkdownBuffer } from '../src/core/markdown-contract.js';
import {
  createRepresentativeCandidates,
  type NormalizedMessage,
  type RepresentativeCandidate,
  type RepresentativeSessionInput,
} from '../src/core/representative-samples.js';
import { computeFacts, type FactsReport } from '../src/core/statistics.js';
import { runCli, type CliIo } from '../src/cli.js';
import { PassThrough } from 'node:stream';

function reviewed(markdown: string): string {
  return markdown.replace('privacy_reviewed: false', 'privacy_reviewed: true');
}

function card(candidate: RepresentativeCandidate, number: number, translation?: string): string {
  const excerpt = candidate.excerpts.find((item) => item.role === 'user')!;
  const quote = translation
    ? `> User: ${translation} (user, translated)`
    : `> User: ${excerpt.text}`;
  return `### Example ${number}. Generalized software task

| Field | Value |
| --- | --- |
| Evidence ref | ${candidate.evidenceRef} |
| Source | ${candidate.source === 'claude_code' ? 'Claude Code' : 'Codex'} |
| Model | ${candidate.models?.join(', ') ?? 'unavailable'} |
| Session type | ${candidate.sessionType} |
| Total tokens | ${candidate.totalTokens ?? 'unavailable'} |
| User turns | ${candidate.userTurns} |

**Tags:** testing, debugging, tool-use

**Context:** A generalized software task was requested.

**Workflow and outcome:** The assistant analyzed the task; the final outcome may be unavailable.

**Why it is valuable:** The exchange demonstrates realistic task framing and agent response behavior.

**Data-governance note:** Identifiers and sensitive values were removed and the excerpt was manually reviewed.

**Representative quote:**

${quote}`;
}

function withCards(facts: FactsReport, candidates: RepresentativeCandidate[]): string {
  return reviewed(renderDataSummary(facts)).replace(
    'No representative samples were included.',
    candidates.map((candidate, index) => card(candidate, index + 1)).join('\n\n'),
  );
}

async function generatedFacts(sessionCount: number, text = 'Please investigate the failing integration test.'): Promise<FactsReport> {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-samples-'));
  const file = join(root, 'sessions.jsonl');
  const records: string[] = [];
  for (let index = 0; index < sessionCount; index += 1) {
    records.push(JSON.stringify({
      type: 'user', sessionId: `local-${index}`, timestamp: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
      message: { role: 'user', content: `${text} Case ${index + 1}.` },
    }));
    records.push(JSON.stringify({
      type: 'assistant', sessionId: `local-${index}`, timestamp: `2026-08-${String(index + 1).padStart(2, '0')}T00:01:00Z`,
      message: { role: 'assistant', content: 'I inspected the failure and prepared a focused change.' },
    }));
  }
  await writeFile(file, records.join('\n'));
  return computeFacts([{ source: 'claude_code', path: file }], new Date('2026-09-04T00:00:00Z'));
}

test('creates bounded redacted representative candidates by default', async () => {
  const inputs = [
    { source: 'codex' as const, path: resolve('test/fixtures/codex') },
    { source: 'claude_code' as const, path: resolve('test/fixtures/claude-code') },
  ];
  const sampled = validateFactsReport(await computeFacts(inputs, new Date('2026-09-04T00:00:00Z')));
  assert.equal(sampled.representativeCandidates?.length, 2);
  assert.deepEqual(sampled.representativeCandidates?.map((item) => item.source), ['codex', 'claude_code']);
  assert.deepEqual(sampled.representativeCandidates?.map((item) => item.evidenceRef), ['candidate-01', 'candidate-02']);
  assert.match(sampled.representativeCandidates![0]!.excerpts[0]!.text, /\[REDACTED_EMAIL\]/);
  assert.doesNotMatch(JSON.stringify(sampled), /alice@example\.com|super-secret-value|raw-session/);
  assert.equal(sampled.representativeCandidates![0]!.sessionType, 'agentic');
  assert.equal(sampled.representativeCandidates![0]!.totalTokens, 140);
});

test('uses ordered canonical messages and excludes fallback duplicates and Claude tool results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-normalized-samples-'));
  const codex = join(root, 'codex.jsonl');
  const claude = join(root, 'claude.jsonl');
  await writeFile(codex, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'private-codex' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Duplicate fallback request.' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'Canonical opening request.' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Duplicate fallback response.' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Canonical response.' } }),
  ].join('\n'));
  await writeFile(claude, [
    JSON.stringify({ type: 'user', sessionId: 'main', message: { role: 'user', content: 'Human request.' } }),
    JSON.stringify({ type: 'user', sessionId: 'main', message: { role: 'user', content: [{ type: 'tool_result', content: 'private shell output' }] } }),
    JSON.stringify({ type: 'assistant', sessionId: 'main', message: { role: 'assistant', content: [
      { type: 'thinking', text: 'Hidden reasoning.' }, { type: 'text', text: 'Safe response.' },
    ] } }),
    JSON.stringify({ type: 'progress', sessionId: 'main', message: { role: 'user', content: 'Metadata prompt.' } }),
    JSON.stringify({ type: 'user', sessionId: 'agent', isSidechain: true, agentId: 'sub', message: { role: 'user', content: 'Subagent prompt.' } }),
    JSON.stringify({ type: 'user', sessionId: 'agent-two', is_sidechain: true, agent_id: 'sub-two', message: { role: 'user', content: 'Snake subagent prompt.' } }),
  ].join('\n'));
  const facts = await computeFacts([
    { source: 'codex', path: codex }, { source: 'claude_code', path: claude },
  ], new Date());
  const serialized = JSON.stringify(facts.representativeCandidates);
  assert.match(serialized, /Canonical opening request/);
  assert.match(serialized, /Canonical response/);
  assert.doesNotMatch(serialized, /Duplicate fallback|private shell output|Hidden reasoning|Metadata prompt|Subagent prompt/);
});

test('adds a bounded middle interaction window around the most informative internal user turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-middle-window-'));
  const file = join(root, 'sessions.jsonl');
  const records = [
    ['user', 'Please investigate the intermittent failure.'],
    ['assistant', 'I will start by changing the cache configuration.'],
    ['user', 'Also check the logs.'],
    ['assistant', 'I checked the logs and still suspect caching.'],
    ['user', 'That diagnosis is incorrect: caching is disabled, so inspect concurrent writes and contact dev@example.com only if needed.'],
    ['assistant', 'I switched to the concurrency path, reproduced the race, and added a regression test.'],
    ['user', 'Please summarize the final result.'],
    ['assistant', 'The concurrent-write regression test now passes.'],
  ].map(([type, content], index) => JSON.stringify({
    type,
    sessionId: 'middle-window',
    timestamp: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
    message: { role: type, content },
  }));
  await writeFile(file, records.join('\n'));

  const facts = await computeFacts([{ source: 'claude_code', path: file }], new Date('2026-09-04T00:00:00Z'));
  const candidate = facts.representativeCandidates![0]!;
  assert.deepEqual(candidate.excerpts.map((excerpt) => [excerpt.role, excerpt.position]), [
    ['user', 'opening'],
    ['assistant', 'middle'],
    ['user', 'middle'],
    ['assistant', 'middle'],
    ['assistant', 'closing'],
  ]);
  assert.equal(candidate.excerpts.length, 5);
  assert.equal(new Set(candidate.excerpts.map((excerpt) => excerpt.text)).size, candidate.excerpts.length);
  const serialized = JSON.stringify(candidate.excerpts);
  assert.match(serialized, /diagnosis is incorrect/);
  assert.match(serialized, /\[REDACTED_EMAIL\]/);
  assert.match(serialized, /regression test now passes/);
  assert.doesNotMatch(serialized, /dev@example\.com|Also check the logs/);

  const opening = candidate.excerpts.find((excerpt) => excerpt.role === 'user' && excerpt.position === 'opening')!;
  const middle = candidate.excerpts.find((excerpt) => excerpt.role === 'user' && excerpt.position === 'middle')!;
  const markdown = withCards(facts, [candidate]).replace(`> User: ${opening.text}`, `> User: ${middle.text}`);
  assert.equal(validateMarkdownBuffer(Buffer.from(markdown), facts).valid, true);
});

test('reserves a candidate-pool slot for the longest elapsed Session', () => {
  const messages = (label: string, userTurns: number): NormalizedMessage[] => Array.from(
    { length: userTurns * 2 },
    (_, index): NormalizedMessage => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: index % 2 === 0 ? `${label} user step ${index / 2 + 1}.` : `${label} assistant step ${(index + 1) / 2}.`,
      ordinal: index,
    }),
  );
  const start = Date.parse('2026-08-01T00:00:00Z');
  const sessions: RepresentativeSessionInput[] = Array.from({ length: 10 }, (_, index) => ({
    source: 'codex',
    sourceOrder: 0,
    sessionOrder: index,
    timestamps: [start, start + (index === 9 ? 14 * 24 * 60 * 60 * 1000 : (index + 1) * 60_000)],
    models: [],
    messages: messages(index === 9 ? 'Long elapsed task' : `Ordinary task ${index}`, Math.max(1, 8 - index)),
    toolCalls: index === 2 ? 20 : 0,
  }));

  const candidates = createRepresentativeCandidates(sessions);
  assert.equal(candidates.length, 8);
  assert.ok(candidates.some((candidate) => candidate.excerpts.some((excerpt) => /Long elapsed task/.test(excerpt.text))));
});

test('removes resources and code before Unicode-safe truncation and caps the pool at eight', async () => {
  const longText = `\u8bf7\u68c0\u67e5\u8fd9\u4e2a\u6d4b\u8bd5 [private](https://example.com/secret) ${'\u4fee\u590d'.repeat(180)}\n\`\`\`sh\nsecret output\n\`\`\``;
  const facts = await generatedFacts(10, longText);
  assert.equal(facts.representativeCandidates?.length, 8);
  assert.equal(new Set(facts.representativeCandidates?.map((item) => item.evidenceRef)).size, 8);
  for (const candidate of facts.representativeCandidates!) {
    for (const excerpt of candidate.excerpts) assert.ok(Array.from(excerpt.text).length <= 280);
  }
  const serialized = JSON.stringify(facts.representativeCandidates);
  assert.doesNotMatch(serialized, /https?:|secret output|```/);
});

test('strict candidate schema rejects extra fields, invalid metrics, token arithmetic, and unsafe excerpts', async () => {
  const facts = await generatedFacts(1);
  const mutate = () => structuredClone(facts) as unknown as Record<string, unknown>;
  const candidateAt = (root: Record<string, unknown>) => (root.representativeCandidates as Array<Record<string, unknown>>)[0]!;

  const extra = mutate();
  candidateAt(extra).rawId = 'private';
  assert.throws(() => validateFactsReport(extra), /unsupported field rawId/);

  const negative = mutate();
  candidateAt(negative).toolCalls = -1;
  assert.throws(() => validateFactsReport(negative), /non-negative safe integer/);

  const arithmetic = mutate();
  Object.assign(candidateAt(arithmetic), { inputTokens: 2, outputTokens: 3, totalTokens: 99 });
  assert.throws(() => validateFactsReport(arithmetic), /totalTokens must equal/);

  const unsafe = mutate();
  (candidateAt(unsafe).excerpts as Array<Record<string, unknown>>)[0]!.text = 'Contact private@example.com about the task.';
  assert.throws(() => validateFactsReport(unsafe), /not normalized, safely redacted/);

  const unsupportedPosition = mutate();
  (candidateAt(unsupportedPosition).excerpts as Array<Record<string, unknown>>)[0]!.position = 'turning-point';
  assert.throws(() => validateFactsReport(unsupportedPosition), /position is unsupported/);

  const excessExcerpts = mutate();
  const excerpt = (candidateAt(excessExcerpts).excerpts as Array<Record<string, unknown>>)[0]!;
  candidateAt(excessExcerpts).excerpts = Array.from({ length: 6 }, () => ({ ...excerpt }));
  assert.throws(() => validateFactsReport(excessExcerpts), /between 1 and 5 excerpts/);
});

test('validates zero, one, and three facts-bound sample cards', async () => {
  const facts = await generatedFacts(3);
  assert.equal(validateMarkdownBuffer(Buffer.from(reviewed(renderDataSummary(facts))), facts).valid, true);
  for (const count of [1, 3]) {
    const markdown = withCards(facts, facts.representativeCandidates!.slice(0, count));
    const result = validateMarkdownBuffer(Buffer.from(markdown), facts);
    assert.equal(result.valid, true, JSON.stringify(result.issues));
    assert.equal(result.metadata.sampleCount, count);
  }
});

test('rejects excess, duplicated, malformed, out-of-order, and facts-mismatched sample cards', async () => {
  const facts = await generatedFacts(4);
  const four = withCards(facts, facts.representativeCandidates!.slice(0, 4));
  assert.ok(validateMarkdownBuffer(Buffer.from(four), facts).issues.some((item) => item.code === 'TOO_MANY_SAMPLES'));

  const two = withCards(facts, facts.representativeCandidates!.slice(0, 2));
  const duplicated = two.replace('candidate-02', 'candidate-01')
    .replace('Please investigate the failing integration test. Case 2.', 'Please investigate the failing integration test. Case 1.');
  assert.ok(validateMarkdownBuffer(Buffer.from(duplicated), facts).issues.some((item) => item.code === 'DUPLICATE_SAMPLE_EVIDENCE'));

  const missing = two.replace(/^\| Model \|.*\|\n/m, '');
  assert.ok(validateMarkdownBuffer(Buffer.from(missing), facts).issues.some((item) => item.code === 'SAMPLE_METADATA_FIELD'));

  const nonconsecutive = two.replace('### Example 2.', '### Example 3.');
  assert.ok(validateMarkdownBuffer(Buffer.from(nonconsecutive), facts).issues.some((item) => item.code === 'SAMPLE_NUMBERING'));

  const mismatch = two.replace('| User turns | 1 |', '| User turns | 999 |');
  assert.ok(validateMarkdownBuffer(Buffer.from(mismatch), facts).issues.some((item) => item.code === 'SAMPLE_FACT_MISMATCH'));

  const invented = two.replace('Please investigate the failing integration test. Case 1.', 'An invented quote.');
  assert.ok(validateMarkdownBuffer(Buffer.from(invented), facts).issues.some((item) => item.code === 'SAMPLE_QUOTE_MISMATCH'));

  assert.notEqual(contentHash(Buffer.from(invented)), contentHash(Buffer.from(two)));
});

test('allows only placeholder-based manual redaction of candidate quotes', async () => {
  const facts = await generatedFacts(1, 'Please update Project Falcon on branch feature/internal for PR 1234.');
  const exact = withCards(facts, facts.representativeCandidates!);
  const redacted = exact.replace(
    'Please update Project Falcon on branch feature/internal for PR 1234. Case 1.',
    'Please update [REDACTED] on branch [REDACTED] for PR [REDACTED].',
  );
  assert.equal(validateMarkdownBuffer(Buffer.from(redacted), facts).valid, true);

  const rewritten = redacted.replace('Please update', 'Please redesign');
  assert.ok(validateMarkdownBuffer(Buffer.from(rewritten), facts).issues.some((item) => item.code === 'SAMPLE_QUOTE_MISMATCH'));

  const fullyHidden = exact.replace(
    'Please update Project Falcon on branch feature/internal for PR 1234. Case 1.',
    '[REDACTED]',
  );
  assert.ok(validateMarkdownBuffer(Buffer.from(fullyHidden), facts).issues.some((item) => item.code === 'SAMPLE_QUOTE_MISMATCH'));
});

test('does not let fences, block quotes, or unrelated sections satisfy sample structure', async () => {
  const facts = await generatedFacts(1);
  const valid = withCards(facts, facts.representativeCandidates!);
  const fieldAsQuote = valid.replace(/^\| Model \|.*\|\n/m, '')
    .replace('**Tags:**', '> | Model | unavailable |\n\n**Tags:**');
  const fieldIssues = validateMarkdownBuffer(Buffer.from(fieldAsQuote), facts).issues.map((item) => item.code);
  assert.ok(fieldIssues.includes('SAMPLE_METADATA_FIELD'));
  assert.ok(fieldIssues.includes('UNBOUND_BLOCK_QUOTE'));

  const outside = `${reviewed(renderDataSummary(facts))}\n## Other Section\n\n### Example 1. Outside section`;
  assert.ok(validateMarkdownBuffer(Buffer.from(outside), facts).issues.some((item) => item.code === 'SAMPLE_OUTSIDE_SECTION'));

  const fenced = reviewed(renderDataSummary(facts)).replace(
    'No representative samples were included.',
    '```markdown\n### Example 1. Fenced decoy\n```',
  );
  const fencedResult = validateMarkdownBuffer(Buffer.from(fenced), facts);
  assert.equal(fencedResult.metadata.sampleCount, 0);
  assert.ok(fencedResult.issues.some((item) => item.code === 'CODE_FENCE_NOT_ALLOWED'));

  const quotedHeading = reviewed(renderDataSummary(facts)).replace(
    'No representative samples were included.',
    '> ### Example 1. Quoted decoy',
  );
  const quotedResult = validateMarkdownBuffer(Buffer.from(quotedHeading), facts);
  assert.equal(quotedResult.metadata.sampleCount, 0);
  assert.ok(quotedResult.issues.some((item) => item.code === 'UNBOUND_BLOCK_QUOTE'));
});

test('shows only a role-marked English translation for a non-English candidate excerpt', async () => {
  const facts = await generatedFacts(1, '\u8bf7\u4fee\u590d\u8fd9\u4e2a\u6d4b\u8bd5\u95ee\u9898\u3002');
  const candidate = facts.representativeCandidates![0]!;
  const untranslated = reviewed(renderDataSummary(facts)).replace('No representative samples were included.', card(candidate, 1));
  assert.ok(validateMarkdownBuffer(Buffer.from(untranslated), facts).issues
    .some((item) => item.code === 'NON_ENGLISH_ORIGINAL_NOT_ALLOWED'));

  const translated = reviewed(renderDataSummary(facts)).replace(
    'No representative samples were included.',
    card(candidate, 1, 'Please fix this test problem.'),
  );
  assert.equal(validateMarkdownBuffer(Buffer.from(translated), facts).valid, true);
  assert.doesNotMatch(translated, /\u8bf7\u4fee\u590d\u8fd9\u4e2a\u6d4b\u8bd5\u95ee\u9898/);

  const bilingual = translated.replace(
    'Please fix this test problem. (user, translated)',
    '\u8bf7\u4fee\u590d\u8fd9\u4e2a\u6d4b\u8bd5\u95ee\u9898\u3002 Please fix this test problem. (user, translated)',
  );
  assert.ok(validateMarkdownBuffer(Buffer.from(bilingual), facts).issues
    .some((item) => item.code === 'SAMPLE_TRANSLATION_ENGLISH'));

  const englishFacts = await generatedFacts(1);
  const unbound = reviewed(renderDataSummary(englishFacts)).replace(
    'No representative samples were included.',
    card(englishFacts.representativeCandidates![0]!, 1, 'Please investigate the failing integration test.'),
  );
  assert.ok(validateMarkdownBuffer(Buffer.from(unbound), englishFacts).issues
    .some((item) => item.code === 'UNBOUND_SAMPLE_TRANSLATION'));
});

test('CLI writes private candidate facts without a Topic review by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-cli-samples-'));
  const output = join(root, 'facts.json');
  const reviewOutput = join(root, 'facts.topic-review.json');
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdin.end();
  const io: CliIo = { stdout, stderr, stdin };
  assert.equal(await runCli([
    'facts', '--source', `codex=${resolve('test/fixtures/codex')}`, '--output', output,
  ], io), 0);
  assert.match(stderr.read().toString(), /only the summary you have reviewed and approved will be uploaded.*stay on your device/i);
  const facts = await readFile(output, 'utf8');
  assert.match(facts, /"representativeCandidates"/);
  assert.equal(JSON.parse(facts).topicReview, undefined);
  await assert.rejects(readFile(reviewOutput), { code: 'ENOENT' });
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
});
