import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { renderDataSummary } from '../src/core/data-summary.js';
import { computeFacts } from '../src/core/statistics.js';

const fixtures = resolve('test/fixtures');

test('computes consistent overall and per-source facts from Codex and Claude Code', async () => {
  const facts = await computeFacts([
    { source: 'codex', path: resolve(fixtures, 'codex') },
    { source: 'claude_code', path: resolve(fixtures, 'claude-code') },
  ], new Date('2026-09-04T00:00:00Z'));

  assert.equal(facts.overall.fileCount, 2);
  assert.equal(facts.overall.sessionCount, 2);
  assert.equal(facts.overall.messageCount, 4);
  assert.equal(facts.overall.turnCount, 2);
  assert.equal(facts.overall.toolCallCount, 2);
  assert.equal(facts.overall.inputTokens, 300);
  assert.equal(facts.overall.outputTokens, 120);
  assert.equal(facts.overall.totalTokens, 420);
  assert.equal(facts.formatVersion, 'cookiy.facts.v1');
  assert.equal(facts.overall.parsedRecordCount, 7);
  assert.equal(facts.overall.recognizedRecordCount, 7);
  assert.equal(facts.overall.tokenCoverage.sessionsWithTotalTokens, 2);
  assert.deepEqual(facts.overall.turnsPerSession, { sampleSize: 2, p50: 1, p95: 1, mean: 1, max: 1 });
  assert.deepEqual(facts.overall.tokensPerSession, { sampleSize: 2, p50: 140, p95: 280, mean: 210, max: 280 });
  assert.equal(facts.overall.activeMonths, 2);
  assert.equal(facts.overall.messageCount, facts.bySource.codex!.messageCount + facts.bySource.claude_code!.messageCount);
  assert.equal(facts.bySource.codex!.malformedRecordCount, 1);
  assert.ok(!JSON.stringify(facts).includes('alice@example.com'));
  assert.ok(!JSON.stringify(facts).includes('super-secret-value'));
  assert.ok(!JSON.stringify(facts).includes('codex-raw-session-123456'));
  assert.ok(!('classifications' in facts));
  assert.equal(facts.representativeCandidates?.length, 2);
});

test('omits token metrics when a source does not provide them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-no-usage-'));
  const file = join(root, 'session.jsonl');
  await writeFile(file, '{"type":"user","sessionId":"local-session","timestamp":"2026-08-01T00:00:00Z","message":{"role":"user","content":"Write a test"}}\n');
  const facts = await computeFacts([{ source: 'claude_code', path: file }]);
  assert.equal(facts.bySource.claude_code!.totalTokens, undefined);
  assert.equal(facts.bySource.claude_code!.inputTokens, undefined);
  assert.equal(facts.overall.totalTokens, undefined);
  assert.equal(facts.overall.tokensPerSession, undefined);
  assert.equal(facts.overall.tokenCoverage.sessionsWithTotalTokens, 0);
});

test('reports token totals for available Sessions while retaining only bounded redacted candidate dialogue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-classification-'));
  const file = join(root, 'session.jsonl');
  await writeFile(file, [
    JSON.stringify({ type: 'user', sessionId: 'first', timestamp: '2026-08-01T00:00:00Z', message: { role: 'user', content: "That's wrong. Don't deploy it; fix the Docker test instead." } }),
    JSON.stringify({ type: 'assistant', sessionId: 'first', timestamp: '2026-08-01T00:01:00Z', message: { role: 'assistant', content: 'Fixed.', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 99 } } }),
    JSON.stringify({ type: 'user', sessionId: 'second', timestamp: '2026-08-02T00:00:00Z', message: { role: 'user', content: 'Write documentation.' } }),
  ].join('\n'));
  const facts = await computeFacts([{ source: 'claude_code', path: file }]);
  assert.equal(facts.overall.inputTokens, 10);
  assert.equal(facts.overall.outputTokens, 5);
  assert.equal(facts.overall.totalTokens, 15);
  assert.equal(facts.overall.tokensPerSession?.sampleSize, 1);
  assert.equal(facts.overall.tokenArithmeticMismatchCount, 1);
  const report = renderDataSummary(facts);
  assert.match(report, /Available-session token data totals 15 tokens across 1 of 2 Sessions/);
  assert.match(report, /\| Total tokens \(available Sessions\) \| 15 \|/);
  assert.match(report, /\| Sessions with total tokens \| 1 \/ 2 \|/);
  assert.match(JSON.stringify(facts), /That's wrong/);
  assert.doesNotMatch(JSON.stringify(facts), /local-session|"rawId"/);
});

test('rejects duplicate paths but allows multiple distinct paths for one source', async () => {
  await assert.rejects(() => computeFacts([
    { source: 'codex', path: resolve(fixtures, 'codex') },
    { source: 'codex', path: resolve(fixtures, 'codex') },
  ]), /path .*provided more than once/);

  const root = await mkdtemp(join(tmpdir(), 'cookiy-multiple-roots-'));
  const a = join(root, 'a.jsonl');
  const b = join(root, 'b.jsonl');
  await writeFile(a, '{"type":"user","sessionId":"a-session","message":{"role":"user","content":"First task"}}\n');
  await writeFile(b, '{"type":"user","sessionId":"b-session","message":{"role":"user","content":"Second task"}}\n');
  const facts = await computeFacts([{ source: 'claude_code', path: a }, { source: 'claude_code', path: b }]);
  assert.equal(facts.bySource.claude_code!.fileCount, 2);
  assert.equal(facts.bySource.claude_code!.sessionCount, 2);
});

test('uses Codex response_item messages instead of duplicate event_msg messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-codex-dual-'));
  const file = join(root, 'session.jsonl');
  await writeFile(file, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'dual-session' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the test.' }] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Fix the test.' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Fixed.' } }),
  ].join('\n'));
  const facts = await computeFacts([{ source: 'codex', path: file }]);
  assert.equal(facts.overall.sessionCount, 1);
  assert.equal(facts.overall.messageCount, 2);
  assert.equal(facts.overall.turnCount, 1);
});

test('uses Codex event messages only to fill a role missing from response_item data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-codex-mixed-'));
  const file = join(root, 'session.jsonl');
  await writeFile(file, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'mixed-session' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Keep this fallback user turn.' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Canonical response.' }] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Duplicate response.' } }),
  ].join('\n'));
  const facts = await computeFacts([{ source: 'codex', path: file }]);
  assert.equal(facts.overall.messageCount, 2);
  assert.equal(facts.overall.turnCount, 1);
  assert.equal(facts.overall.assistantMessageCount, 1);
});

test('excludes Claude tool results, metadata, sidechains, and subagent prompts from human turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-claude-semantic-'));
  const file = join(root, 'session.jsonl');
  await writeFile(file, [
    JSON.stringify({ type: 'user', sessionId: 'main', message: { role: 'user', content: 'Fix the API.' } }),
    JSON.stringify({ type: 'assistant', sessionId: 'main', message: { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', name: 'Read' }] } }),
    JSON.stringify({ type: 'user', sessionId: 'main', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: 'raw output' }] } }),
    JSON.stringify({ type: 'user', sessionId: 'side', isSidechain: true, agentId: 'agent-one', message: { role: 'user', content: 'Internal subagent prompt.' } }),
  ].join('\n'));
  const facts = await computeFacts([{ source: 'claude_code', path: file }]);
  assert.equal(facts.overall.sessionCount, 1);
  assert.equal(facts.overall.messageCount, 2);
  assert.equal(facts.overall.turnCount, 1);
  assert.equal(facts.overall.toolCallCount, 1);
  assert.equal(facts.overall.parsedRecordCount, 4);
  assert.equal(facts.overall.recognizedRecordCount, 3);
});

test('deduplicates a file included through overlapping input roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-overlap-'));
  const nested = join(root, 'nested');
  await mkdir(nested);
  const file = join(nested, 'session.jsonl');
  await writeFile(file, JSON.stringify({ type: 'user', sessionId: 'one', message: { role: 'user', content: 'One task.' } }));
  const facts = await computeFacts([
    { source: 'claude_code', path: root },
    { source: 'claude_code', path: file },
  ]);
  assert.equal(facts.overall.fileCount, 1);
  assert.equal(facts.overall.sessionCount, 1);
  assert.equal(facts.overall.turnCount, 1);
});

test('rejects inputs with no recognized main Session containing a human turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cookiy-empty-'));
  const unsupported = join(root, 'notes.txt');
  const unknown = join(root, 'unknown.jsonl');
  await writeFile(unsupported, 'not session data');
  await writeFile(unknown, '{"kind":"unrecognized"}\n');
  await assert.rejects(() => computeFacts([{ source: 'codex', path: unsupported }]), /No supported main-session records/);
  await assert.rejects(() => computeFacts([{ source: 'codex', path: unknown }]), /No supported main-session records/);
});
