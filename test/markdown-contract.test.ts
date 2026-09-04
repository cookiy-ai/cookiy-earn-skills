import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { renderDataSummary, validateFactsReport } from '../src/core/data-summary.js';
import { MAX_MARKDOWN_BYTES, redactRepresentativeSamples, validateMarkdownBuffer } from '../src/core/markdown-contract.js';
import { computeFacts } from '../src/core/statistics.js';

async function fixtureFacts() {
  return computeFacts([{ source: 'codex', path: resolve('test/fixtures/codex') }], new Date('2026-09-04T00:00:00Z'));
}

function reviewed(markdown: string): string {
  return markdown.replace('privacy_reviewed: false', 'privacy_reviewed: true');
}

test('accepts the facts-bound v1 contract without a selected sample and extracts metadata', async () => {
  const facts = await fixtureFacts();
  const markdown = reviewed(renderDataSummary(facts));
  const result = validateMarkdownBuffer(Buffer.from(markdown), facts);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.deepEqual(result.metadata.sources, ['codex']);
  assert.equal(result.metadata.sampleCount, 0);
  assert.ok(markdown.indexOf('## Descriptive Statistics') < markdown.indexOf('## Representative Session Samples'));
});

test('unused candidate changes do not invalidate a report without representative samples', async () => {
  const facts = await fixtureFacts();
  const markdown = reviewed(renderDataSummary(facts));
  assert.ok(facts.representativeCandidates?.length);
  const changed = structuredClone(facts);
  changed.representativeCandidates![0]!.excerpts[0]!.text = 'Please check the updated test fixture.';
  const validatedFacts = validateFactsReport(changed);
  assert.equal(renderDataSummary(validatedFacts), renderDataSummary(facts));
  const result = validateMarkdownBuffer(Buffer.from(markdown), validatedFacts);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test('rejects samples, secrets, HTML, every Markdown resource form, and URI destinations', async () => {
  const facts = await fixtureFacts();
  const inputs = [
    '### Sample 1',
    '<script>alert(1)</script>',
    'API_KEY=not-allowed-secret',
    '![x](//example.com/x.png)',
    '[archive](./raw-session.zip)',
    '![x][tracking]\n\n[tracking]: ftp://example.com/x.png',
    's3://private-bucket/raw-session.zip',
  ];
  for (const input of inputs) {
    const result = validateMarkdownBuffer(Buffer.from(`${reviewed(renderDataSummary(facts))}\n${input}`), facts);
    assert.equal(result.valid, false, input);
  }
});

test('rejects invalid UTF-8 and the exact 16 MiB overflow boundary', () => {
  assert.ok(validateMarkdownBuffer(Buffer.from([0xc3, 0x28])).issues.some((item) => item.code === 'INVALID_UTF8'));
  const oversized = Buffer.alloc(MAX_MARKDOWN_BYTES + 1, 0x20);
  assert.ok(validateMarkdownBuffer(oversized).issues.some((item) => item.code === 'FILE_TOO_LARGE'));
});

test('accepts a reviewed report only with matching facts and unchanged generated statistics', async () => {
  const facts = await computeFacts([
    { source: 'codex', path: resolve('test/fixtures/codex') },
    { source: 'claude_code', path: resolve('test/fixtures/claude-code') },
  ], new Date('2026-09-04T00:00:00Z'));
  const markdown = reviewed(renderDataSummary(facts));
  assert.equal(validateMarkdownBuffer(Buffer.from(markdown), facts).valid, true);
  assert.doesNotMatch(markdown, /cookiy:generated-statistics|Limitations/);
  assert.ok(validateMarkdownBuffer(Buffer.from(markdown)).issues.some((item) => item.code === 'FACTS_FILE_REQUIRED'));

  const changed = markdown.replace('| Sessions | 2 |', '| Sessions | 999 |');
  assert.ok(validateMarkdownBuffer(Buffer.from(changed), facts).issues.some((item) => item.code === 'GENERATED_STATISTICS_CHANGED'));

  const changedNarrative = markdown.replace('## Executive Summary', '## Executive Summary\n\nUnexpected content');
  assert.ok(validateMarkdownBuffer(Buffer.from(changedNarrative), facts).issues
    .some((item) => item.code === 'GENERATED_CONTENT_CHANGED'));
});

test('redacts only editable Sample content and preserves fact-bound numeric metadata and statistics', async () => {
  const facts = await fixtureFacts();
  facts.overall.totalBytes = 1_234_567_890;
  facts.bySource.codex!.totalBytes = 1_234_567_890;
  const draft = renderDataSummary(facts).replace(
    'No representative samples were included.',
    `### Example 1. Call +1 (415) 555-1212

| Field | Value |
| --- | --- |
| Evidence ref | candidate-01 |
| Source | Codex |
| Model | unavailable |
| Session type | agentic |
| Total tokens | 1234567890 |
| User turns | 1 |

**Tags:** testing, debugging, tool-use

**Context:** Call +1 (415) 555-1212.

**Workflow and outcome:** unavailable

**Why it is valuable:** unavailable

**Data-governance note:** reviewed

**Representative quote:**

> User: Call +1 (415) 555-1212.`,
  );
  const result = redactRepresentativeSamples(draft);
  assert.match(result.text, /\| Source bytes \| 1234567890 \|/);
  assert.match(result.text, /\| Total tokens \| 1234567890 \|/);
  assert.doesNotMatch(result.text, /\+1 \(415\) 555-1212/);
  assert.equal(result.redactions.PHONE, 3);

  const reviewed = renderDataSummary(facts).replace('privacy_reviewed: false', 'privacy_reviewed: true');
  assert.equal(validateMarkdownBuffer(Buffer.from(reviewed), facts).valid, true);
});

test('blocks unreviewed reports, fenced headings, duplicate sections, and reordered sections', async () => {
  const facts = await fixtureFacts();
  const draft = renderDataSummary(facts);
  assert.ok(validateMarkdownBuffer(Buffer.from(draft), facts).issues.some((item) => item.code === 'PRIVACY_REVIEW_REQUIRED'));

  const fenced = `${reviewed(draft)}\n\`\`\`markdown\n## Executive Summary\n\`\`\``;
  const fencedCodes = validateMarkdownBuffer(Buffer.from(fenced), facts).issues.map((item) => item.code);
  assert.ok(fencedCodes.includes('CODE_FENCE_NOT_ALLOWED'));
  assert.ok(!fencedCodes.includes('DUPLICATE_SECTION'));

  const reordered = reviewed(draft)
    .replace('## Executive Summary', '## Temporary')
    .replace('## Key Highlights', '## Executive Summary')
    .replace('## Temporary', '## Key Highlights');
  assert.ok(validateMarkdownBuffer(Buffer.from(reordered), facts).issues.some((item) => item.code === 'SECTION_ORDER'));

  const oldSectionOrder = reviewed(draft).replace(
    /(## Descriptive Statistics\n\n[\s\S]+?)(\n\n## Representative Session Samples\n\nNo representative samples were included\.)/,
    '$2\n\n$1',
  );
  assert.ok(validateMarkdownBuffer(Buffer.from(oldSectionOrder), facts).issues.some((item) => item.code === 'SECTION_ORDER'));

  const indented = reviewed(draft).replace('## Executive Summary', '    ## Executive Summary');
  assert.ok(validateMarkdownBuffer(Buffer.from(indented), facts).issues.some((item) => item.code === 'MISSING_SECTION'));
});

test('strict facts validation rejects tampering, invalid domains, and extra data-bearing fields', async () => {
  const facts = await fixtureFacts();
  const changedCount = structuredClone(facts) as unknown as Record<string, unknown>;
  (changedCount.overall as Record<string, unknown>).sessionCount = 999;
  assert.throws(() => validateFactsReport(changedCount), /sessionCount|messageCount|sampleSize|By Source/);

  const negative = structuredClone(facts) as unknown as Record<string, unknown>;
  (negative.overall as Record<string, unknown>).toolCallCount = -1;
  assert.throws(() => validateFactsReport(negative), /non-negative safe integer/);

  const extra = { ...structuredClone(facts), representativeCandidates: [{ excerpt: 'private' }] };
  assert.throws(() => validateFactsReport(extra), /representativeCandidates.*unsupported field excerpt/);
});
