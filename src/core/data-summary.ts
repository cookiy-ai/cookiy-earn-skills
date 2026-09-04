import { readFile } from 'node:fs/promises';
import type { DataSource } from './markdown-contract.js';
import {
  MAX_REPRESENTATIVE_CANDIDATES,
  MAX_REPRESENTATIVE_EXCERPT_CODE_POINTS,
  MAX_REPRESENTATIVE_EXCERPTS_PER_CANDIDATE,
  normalizeRepresentativeExcerpt,
  type RepresentativeCandidate,
  type RepresentativeExcerpt,
} from './representative-samples.js';
import { detectSensitiveContent } from './redaction.js';
import type { Distribution, FactsReport, MetricSet } from './statistics.js';
import {
  TOPICS,
  validateTopicClassification,
  validateTopicReviewBinding,
} from './topics.js';

const SOURCES = ['codex', 'claude_code'] as const;
const ROOT_KEYS = new Set([
  'formatVersion', 'generatedAt', 'overall', 'bySource', 'representativeCandidates', 'topicReview', 'topicClassification',
]);
const CANDIDATE_KEYS = new Set([
  'evidenceRef', 'source', 'startedAt', 'endedAt', 'models', 'sessionType', 'messageCount', 'userTurns', 'toolCalls',
  'inputTokens', 'outputTokens', 'totalTokens', 'excerpts',
]);
const EXCERPT_KEYS = new Set(['role', 'position', 'text']);
const METRIC_KEYS = new Set([
  'fileCount', 'totalBytes', 'sessionCount', 'messageCount', 'userMessageCount', 'assistantMessageCount',
  'turnCount', 'toolCallCount', 'inputTokens', 'outputTokens', 'totalTokens', 'earliestAt', 'latestAt',
  'activeDays', 'activeMonths', 'parsedRecordCount', 'recognizedRecordCount', 'malformedRecordCount',
  'skippedFileCount', 'unsupportedFileCount', 'tokenArithmeticMismatchCount', 'tokenCoverage',
  'turnsPerSession', 'toolCallsPerSession', 'tokensPerSession',
]);
const REQUIRED_INTEGER_METRICS = [
  'fileCount', 'totalBytes', 'sessionCount', 'messageCount', 'userMessageCount', 'assistantMessageCount',
  'turnCount', 'toolCallCount', 'activeDays', 'activeMonths', 'parsedRecordCount', 'recognizedRecordCount',
  'malformedRecordCount', 'skippedFileCount', 'unsupportedFileCount', 'tokenArithmeticMismatchCount',
] as const;
const ADDITIVE_METRICS = [
  ...REQUIRED_INTEGER_METRICS.filter((key) => key !== 'activeDays' && key !== 'activeMonths'),
] as const;

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`${path} contains unsupported field ${unexpected[0]}.`);
}

function integer(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${path} must be a non-negative safe integer.`);
  return value;
}

function optionalInteger(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : integer(value, path);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(`${path} must be a non-empty trimmed string.`);
  }
  return value;
}

function isoTimestamp(value: unknown, path: string): string {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || Number.isNaN(Date.parse(value))) {
    throw new Error(`${path} must be a valid UTC ISO-8601 timestamp.`);
  }
  return value;
}

function validateDistribution(value: unknown, path: string, expectedSampleSize: number, expectedSum?: number): Distribution {
  const item = object(value, path);
  assertOnlyKeys(item, new Set(['sampleSize', 'p50', 'p95', 'mean', 'max']), path);
  const sampleSize = integer(item.sampleSize, `${path}.sampleSize`);
  if (sampleSize !== expectedSampleSize) throw new Error(`${path}.sampleSize must equal ${expectedSampleSize}.`);
  const values = ['p50', 'p95', 'mean', 'max'].map((key) => {
    const candidate = item[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) throw new Error(`${path}.${key} must be a non-negative finite number.`);
    return candidate;
  });
  const [p50, p95, mean, max] = values as [number, number, number, number];
  if (![p50, p95, max].every(Number.isSafeInteger)) throw new Error(`${path} percentiles and max must be safe integers.`);
  if (sampleSize === 0 && values.some((candidate) => candidate !== 0)) throw new Error(`${path} must contain zero values when sampleSize is zero.`);
  if (p50 > p95 || p95 > max || mean > max) throw new Error(`${path} percentiles and mean are inconsistent with max.`);
  if (expectedSum !== undefined && Math.abs(mean * sampleSize - expectedSum) > sampleSize * 0.005 + Number.EPSILON) {
    throw new Error(`${path}.mean is inconsistent with the aggregate total.`);
  }
  return { sampleSize, p50, p95, mean, max };
}

function validateMetricSet(value: unknown, path: string): MetricSet {
  const metrics = object(value, path);
  assertOnlyKeys(metrics, METRIC_KEYS, path);
  for (const key of REQUIRED_INTEGER_METRICS) integer(metrics[key], `${path}.${key}`);
  const sessionCount = metrics.sessionCount as number;
  if (sessionCount > 0 && metrics.fileCount === 0) throw new Error(`${path}.fileCount must be positive when Sessions are present.`);
  if (sessionCount > 0 && metrics.recognizedRecordCount === 0) throw new Error(`${path}.recognizedRecordCount must be positive when Sessions are present.`);
  if (metrics.messageCount !== (metrics.userMessageCount as number) + (metrics.assistantMessageCount as number)) {
    throw new Error(`${path}.messageCount must equal userMessageCount + assistantMessageCount.`);
  }
  if (metrics.turnCount !== metrics.userMessageCount) throw new Error(`${path}.turnCount must equal userMessageCount.`);
  if ((metrics.recognizedRecordCount as number) > (metrics.parsedRecordCount as number)) {
    throw new Error(`${path}.recognizedRecordCount cannot exceed parsedRecordCount.`);
  }

  const inputTokens = optionalInteger(metrics.inputTokens, `${path}.inputTokens`);
  const outputTokens = optionalInteger(metrics.outputTokens, `${path}.outputTokens`);
  const totalTokens = optionalInteger(metrics.totalTokens, `${path}.totalTokens`);
  if ([inputTokens, outputTokens, totalTokens].some((item) => item !== undefined)
    && [inputTokens, outputTokens, totalTokens].some((item) => item === undefined)) {
    throw new Error(`${path} token totals must either all be present or all be omitted.`);
  }
  if (inputTokens !== undefined && outputTokens !== undefined && totalTokens !== inputTokens + outputTokens) {
    throw new Error(`${path}.totalTokens must equal inputTokens + outputTokens.`);
  }

  const coverage = object(metrics.tokenCoverage, `${path}.tokenCoverage`);
  assertOnlyKeys(coverage, new Set(['sessionCount', 'sessionsWithInputTokens', 'sessionsWithOutputTokens', 'sessionsWithTotalTokens']), `${path}.tokenCoverage`);
  const coverageSessionCount = integer(coverage.sessionCount, `${path}.tokenCoverage.sessionCount`);
  const sessionsWithInputTokens = integer(coverage.sessionsWithInputTokens, `${path}.tokenCoverage.sessionsWithInputTokens`);
  const sessionsWithOutputTokens = integer(coverage.sessionsWithOutputTokens, `${path}.tokenCoverage.sessionsWithOutputTokens`);
  const sessionsWithTotalTokens = integer(coverage.sessionsWithTotalTokens, `${path}.tokenCoverage.sessionsWithTotalTokens`);
  if (coverageSessionCount !== sessionCount) throw new Error(`${path}.tokenCoverage.sessionCount must equal sessionCount.`);
  if ([sessionsWithInputTokens, sessionsWithOutputTokens, sessionsWithTotalTokens].some((count) => count > sessionCount)) {
    throw new Error(`${path}.tokenCoverage counts cannot exceed sessionCount.`);
  }
  if (sessionsWithTotalTokens > sessionsWithInputTokens || sessionsWithTotalTokens > sessionsWithOutputTokens) {
    throw new Error(`${path}.tokenCoverage total-token count cannot exceed input- or output-token coverage.`);
  }
  const hasAvailableTokens = sessionsWithTotalTokens > 0;
  if ((totalTokens !== undefined) !== hasAvailableTokens) {
    throw new Error(`${path} aggregate token presence must match available total-token coverage.`);
  }

  const earliestAt = metrics.earliestAt === undefined ? undefined : isoTimestamp(metrics.earliestAt, `${path}.earliestAt`);
  const latestAt = metrics.latestAt === undefined ? undefined : isoTimestamp(metrics.latestAt, `${path}.latestAt`);
  if ((earliestAt === undefined) !== (latestAt === undefined)) throw new Error(`${path} must provide both earliestAt and latestAt, or neither.`);
  if (earliestAt && latestAt && Date.parse(earliestAt) > Date.parse(latestAt)) throw new Error(`${path}.earliestAt cannot be later than latestAt.`);
  if (!earliestAt && (metrics.activeDays !== 0 || metrics.activeMonths !== 0)) throw new Error(`${path} active time counts require a time range.`);
  if (earliestAt && (metrics.activeDays === 0 || metrics.activeMonths === 0)) throw new Error(`${path} time ranges require positive active time counts.`);
  if ((metrics.activeMonths as number) > (metrics.activeDays as number)) throw new Error(`${path}.activeMonths cannot exceed activeDays.`);

  validateDistribution(metrics.turnsPerSession, `${path}.turnsPerSession`, sessionCount, metrics.turnCount as number);
  validateDistribution(metrics.toolCallsPerSession, `${path}.toolCallsPerSession`, sessionCount, metrics.toolCallCount as number);
  if (sessionsWithTotalTokens === 0) {
    if (metrics.tokensPerSession !== undefined) throw new Error(`${path}.tokensPerSession must be omitted without total-token samples.`);
  } else {
    validateDistribution(metrics.tokensPerSession, `${path}.tokensPerSession`, sessionsWithTotalTokens, totalTokens);
  }
  return metrics as unknown as MetricSet;
}

function sum(metrics: MetricSet[], key: typeof ADDITIVE_METRICS[number]): number {
  return metrics.reduce((total, item) => total + item[key], 0);
}

function validateRepresentativeCandidates(
  value: unknown,
  bySource: Partial<Record<DataSource, MetricSet>>,
): RepresentativeCandidate[] {
  if (!Array.isArray(value)) throw new Error('facts.representativeCandidates must be an array.');
  if (value.length > MAX_REPRESENTATIVE_CANDIDATES) {
    throw new Error(`facts.representativeCandidates cannot contain more than ${MAX_REPRESENTATIVE_CANDIDATES} candidates.`);
  }
  const seen = new Set<string>();
  return value.map((rawCandidate, index): RepresentativeCandidate => {
    const path = `facts.representativeCandidates[${index}]`;
    const candidate = object(rawCandidate, path);
    assertOnlyKeys(candidate, CANDIDATE_KEYS, path);
    const evidenceRef = requiredString(candidate.evidenceRef, `${path}.evidenceRef`);
    if (evidenceRef !== `candidate-${String(index + 1).padStart(2, '0')}`) {
      throw new Error(`${path}.evidenceRef must be the report-local sequential candidate reference.`);
    }
    if (seen.has(evidenceRef)) throw new Error('facts.representativeCandidates evidenceRef values must be unique.');
    seen.add(evidenceRef);
    if (!SOURCES.includes(candidate.source as DataSource) || !bySource[candidate.source as DataSource]) {
      throw new Error(`${path}.source must name a source present in facts.bySource.`);
    }
    const source = candidate.source as DataSource;
    const startedAt = candidate.startedAt === undefined ? undefined : isoTimestamp(candidate.startedAt, `${path}.startedAt`);
    const endedAt = candidate.endedAt === undefined ? undefined : isoTimestamp(candidate.endedAt, `${path}.endedAt`);
    if (startedAt && endedAt && Date.parse(startedAt) > Date.parse(endedAt)) {
      throw new Error(`${path}.startedAt cannot be later than endedAt.`);
    }
    let models: string[] | undefined;
    if (candidate.models !== undefined) {
      if (!Array.isArray(candidate.models) || candidate.models.length === 0) throw new Error(`${path}.models must be a non-empty array.`);
      models = candidate.models.map((model, modelIndex) => {
        const parsed = requiredString(model, `${path}.models[${modelIndex}]`);
        if (Array.from(parsed).length > 120 || /[|\r\n]/.test(parsed) || detectSensitiveContent(parsed).length > 0) {
          throw new Error(`${path}.models[${modelIndex}] is unsafe or too long.`);
        }
        return parsed;
      });
      if (new Set(models).size !== models.length) throw new Error(`${path}.models must contain unique values.`);
    }
    if (candidate.sessionType !== 'agentic' && candidate.sessionType !== 'conversation') {
      throw new Error(`${path}.sessionType must be agentic or conversation.`);
    }
    const sessionType = candidate.sessionType;
    const messageCount = integer(candidate.messageCount, `${path}.messageCount`);
    const userTurns = integer(candidate.userTurns, `${path}.userTurns`);
    const toolCalls = integer(candidate.toolCalls, `${path}.toolCalls`);
    if (userTurns === 0 || userTurns > messageCount) throw new Error(`${path}.userTurns must be positive and cannot exceed messageCount.`);
    if ((toolCalls > 0) !== (sessionType === 'agentic')) throw new Error(`${path}.sessionType must agree with toolCalls.`);
    const sourceMetrics = bySource[source]!;
    if (messageCount > sourceMetrics.messageCount || userTurns > sourceMetrics.turnCount || toolCalls > sourceMetrics.toolCallCount) {
      throw new Error(`${path} metrics cannot exceed the corresponding source aggregates.`);
    }
    const inputTokens = optionalInteger(candidate.inputTokens, `${path}.inputTokens`);
    const outputTokens = optionalInteger(candidate.outputTokens, `${path}.outputTokens`);
    const totalTokens = optionalInteger(candidate.totalTokens, `${path}.totalTokens`);
    if (inputTokens !== undefined && outputTokens !== undefined && totalTokens !== undefined
      && totalTokens !== inputTokens + outputTokens) {
      throw new Error(`${path}.totalTokens must equal inputTokens + outputTokens when token fields are complete.`);
    }
    if (!Array.isArray(candidate.excerpts)
      || candidate.excerpts.length < 1
      || candidate.excerpts.length > MAX_REPRESENTATIVE_EXCERPTS_PER_CANDIDATE) {
      throw new Error(`${path}.excerpts must contain between 1 and ${MAX_REPRESENTATIVE_EXCERPTS_PER_CANDIDATE} excerpts.`);
    }
    const excerpts = candidate.excerpts.map((rawExcerpt, excerptIndex): RepresentativeExcerpt => {
      const excerptPath = `${path}.excerpts[${excerptIndex}]`;
      const excerpt = object(rawExcerpt, excerptPath);
      assertOnlyKeys(excerpt, EXCERPT_KEYS, excerptPath);
      if (excerpt.role !== 'user' && excerpt.role !== 'assistant') throw new Error(`${excerptPath}.role is unsupported.`);
      if (excerpt.position !== 'opening' && excerpt.position !== 'middle' && excerpt.position !== 'closing') {
        throw new Error(`${excerptPath}.position is unsupported.`);
      }
      const text = requiredString(excerpt.text, `${excerptPath}.text`);
      if (Array.from(text).length > MAX_REPRESENTATIVE_EXCERPT_CODE_POINTS) {
        throw new Error(`${excerptPath}.text exceeds ${MAX_REPRESENTATIVE_EXCERPT_CODE_POINTS} Unicode code points.`);
      }
      if (normalizeRepresentativeExcerpt(text) !== text || detectSensitiveContent(text).length > 0) {
        throw new Error(`${excerptPath}.text is not normalized, safely redacted, or meaningful.`);
      }
      return { role: excerpt.role, position: excerpt.position, text };
    });
    if (!excerpts.some((excerpt) => excerpt.role === 'user')) throw new Error(`${path}.excerpts must retain human user evidence.`);
    return {
      evidenceRef,
      source,
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      ...(models ? { models } : {}),
      sessionType,
      messageCount,
      userTurns,
      toolCalls,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      excerpts,
    };
  });
}

export function validateFactsReport(value: unknown): FactsReport {
  const root = object(value, 'facts');
  assertOnlyKeys(root, ROOT_KEYS, 'facts');
  if (root.formatVersion !== 'cookiy.facts.v1') throw new Error('facts.formatVersion must be cookiy.facts.v1.');
  const generatedAt = isoTimestamp(root.generatedAt, 'facts.generatedAt');
  const overall = validateMetricSet(root.overall, 'facts.overall');
  if (overall.sessionCount === 0) throw new Error('facts.overall.sessionCount must be greater than zero.');

  const rawBySource = object(root.bySource, 'facts.bySource');
  const sourceNames = Object.keys(rawBySource);
  if (sourceNames.length === 0) throw new Error('facts.bySource must contain at least one source.');
  if (sourceNames.some((source) => !SOURCES.includes(source as DataSource))) throw new Error('facts.bySource contains an unsupported source.');
  const bySource: Partial<Record<DataSource, MetricSet>> = {};
  for (const source of sourceNames as DataSource[]) {
    const metrics = validateMetricSet(rawBySource[source], `facts.bySource.${source}`);
    if (metrics.sessionCount === 0) throw new Error(`facts.bySource.${source}.sessionCount must be greater than zero.`);
    bySource[source] = metrics;
  }
  const sourceMetrics = Object.values(bySource) as MetricSet[];

  for (const key of ADDITIVE_METRICS) {
    if (overall[key] !== sum(sourceMetrics, key)) throw new Error(`facts.overall.${key} must equal the By Source sum.`);
  }
  for (const key of ['sessionCount', 'sessionsWithInputTokens', 'sessionsWithOutputTokens', 'sessionsWithTotalTokens'] as const) {
    const expected = sourceMetrics.reduce((total, item) => total + item.tokenCoverage[key], 0);
    if (overall.tokenCoverage[key] !== expected) throw new Error(`facts.overall.tokenCoverage.${key} must equal the By Source sum.`);
  }
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const expected = overall.tokenCoverage.sessionsWithTotalTokens > 0
      ? sourceMetrics.reduce((total, metrics) => total + (metrics[key] ?? 0), 0)
      : undefined;
    if (overall[key] !== expected) throw new Error(`facts.overall.${key} must match available By Source coverage.`);
  }
  const earliest = sourceMetrics.map((metrics) => metrics.earliestAt).filter((item): item is string => item !== undefined).sort()[0];
  const latest = sourceMetrics.map((metrics) => metrics.latestAt).filter((item): item is string => item !== undefined).sort().at(-1);
  if (overall.earliestAt !== earliest || overall.latestAt !== latest) throw new Error('facts.overall time range must match By Source ranges.');

  const topicReview = root.topicReview === undefined
    ? undefined
    : validateTopicReviewBinding(root.topicReview, overall.sessionCount);
  if (root.topicClassification !== undefined && !topicReview) {
    throw new Error('facts.topicClassification requires facts.topicReview.');
  }
  const topicClassification = root.topicClassification === undefined || !topicReview
    ? undefined
    : validateTopicClassification(
      root.topicClassification,
      topicReview,
      overall.sessionCount,
      Object.fromEntries(Object.entries(bySource).map(([source, metrics]) => [source, metrics.sessionCount])),
    );
  const representativeCandidates = root.representativeCandidates === undefined
    ? undefined
    : validateRepresentativeCandidates(root.representativeCandidates, bySource);

  return {
    formatVersion: 'cookiy.facts.v1',
    generatedAt,
    overall,
    bySource,
    ...(representativeCandidates ? { representativeCandidates } : {}),
    ...(topicReview ? { topicReview } : {}),
    ...(topicClassification ? { topicClassification } : {}),
  };
}

export async function readFactsFile(filePath: string): Promise<FactsReport> {
  return validateFactsReport(JSON.parse(await readFile(filePath, 'utf8')) as unknown);
}

function display(value: number | string | undefined): string {
  return value === undefined ? 'unavailable' : String(value);
}

function distributionRow(label: string, item: Distribution | undefined): string {
  if (!item || item.sampleSize === 0) return `| ${label} | 0 | unavailable | unavailable | unavailable | unavailable |`;
  return `| ${label} | ${item.sampleSize} | ${item.p50} | ${item.p95} | ${item.mean} | ${item.max} |`;
}

function metricSections(metrics: MetricSet, headingLevel: 4 | 5): string {
  const heading = '#'.repeat(headingLevel);
  return `${heading} Population and Scale

| Metric | Value |
| --- | ---: |
| Source files | ${metrics.fileCount} |
| Source bytes | ${metrics.totalBytes} |
| Sessions | ${metrics.sessionCount} |
| Messages | ${metrics.messageCount} |
| User turns | ${metrics.turnCount} |
| Tool calls | ${metrics.toolCallCount} |
| Input tokens (available Sessions) | ${display(metrics.inputTokens)} |
| Output tokens (available Sessions) | ${display(metrics.outputTokens)} |
| Total tokens (available Sessions) | ${display(metrics.totalTokens)} |

${heading} Data Range and Coverage

| Metric | Value |
| --- | ---: |
| Earliest activity | ${display(metrics.earliestAt)} |
| Latest activity | ${display(metrics.latestAt)} |
| Active days | ${metrics.activeDays} |
| Active months | ${metrics.activeMonths} |
| Parsed JSON records | ${metrics.parsedRecordCount} |
| Recognized source records | ${metrics.recognizedRecordCount} |
| Malformed records | ${metrics.malformedRecordCount} |
| Skipped supported files | ${metrics.skippedFileCount} |
| Unsupported files | ${metrics.unsupportedFileCount} |
| Token arithmetic mismatches | ${metrics.tokenArithmeticMismatchCount} |
| Sessions with input tokens | ${metrics.tokenCoverage.sessionsWithInputTokens} / ${metrics.tokenCoverage.sessionCount} |
| Sessions with output tokens | ${metrics.tokenCoverage.sessionsWithOutputTokens} / ${metrics.tokenCoverage.sessionCount} |
| Sessions with total tokens | ${metrics.tokenCoverage.sessionsWithTotalTokens} / ${metrics.tokenCoverage.sessionCount} |

${heading} Core Session Metrics

| Metric | Sample size | p50 | p95 | Mean | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
${distributionRow('Turns per session', metrics.turnsPerSession)}
${distributionRow('Tool calls per session', metrics.toolCallsPerSession)}
${distributionRow('Tokens per session', metrics.tokensPerSession)}`;
}

function sourceName(source: string): string {
  return source === 'claude_code' ? 'Claude Code' : 'Codex';
}

function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function renderKeyHighlights(facts: FactsReport): string {
  const sourceCount = Object.keys(facts.bySource).length;
  return [
    `- **Coverage:** ${counted(facts.overall.sessionCount, 'main session')} from ${counted(sourceCount, 'source')} across ${counted(facts.overall.fileCount, 'source file')}.`,
    `- **Interaction volume:** ${counted(facts.overall.turnCount, 'human user turn')} and ${counted(facts.overall.assistantMessageCount, 'assistant message')}; median user turns per Session: ${facts.overall.turnsPerSession.p50}.`,
    `- **Tool use:** ${counted(facts.overall.toolCallCount, 'recorded tool call')}; median per Session: ${facts.overall.toolCallsPerSession.p50}, maximum: ${facts.overall.toolCallsPerSession.max}.`,
  ].join('\n');
}

export function renderGeneratedStatistics(facts: FactsReport): string {
  const sources = Object.entries(facts.bySource).map(([source, metrics]) =>
    `#### ${sourceName(source)}\n\n${metricSections(metrics, 5)}`).join('\n\n');
  const topicSection = facts.topicClassification ? `

#### Primary Topic Distribution

Method: \`agent_semantic_review_v1\`. Taxonomy: \`primary-topic-v1\`.
Denominator: all ${facts.topicClassification.denominator} included Sessions. All Sessions were reviewed by the current Agent.

| Primary topic | Sessions | Share |
| --- | ---: | ---: |
${TOPICS.map((topic) => {
    const count = facts.topicClassification!.counts[topic];
    const share = ((count / facts.topicClassification!.denominator) * 100).toFixed(2);
    return `| ${topic} | ${count} | ${share}% |`;
  }).join('\n')}` : '';
  return `### Overall

${metricSections(facts.overall, 4)}

### By Source

${sources}${topicSection}`;
}

export function renderDataSummary(facts: FactsReport): string {
  const sources = Object.keys(facts.bySource);
  const sourceList = sources.map((source) => `  - ${source}`).join('\n');
  const samplePrivacy = facts.representativeCandidates === undefined
    ? 'No dialogue excerpts or representative samples are included.'
    : 'Only manually selected, facts-bound, redacted representative excerpts may be included; the candidate pool remains local.';
  const topicPrivacy = facts.topicClassification
    ? `${samplePrivacy} Only aggregate Primary Topic counts and shares are included; per-Session Topic evidence and assignments remain local.`
    : `${samplePrivacy} Topic labels, behavioral classifications, local paths, and raw Session identifiers are not included.`;
  const tokenSummary = facts.overall.totalTokens === undefined
    ? 'Total-token data is unavailable.'
    : `Available-session token data totals ${facts.overall.totalTokens} tokens across ${facts.overall.tokenCoverage.sessionsWithTotalTokens} of ${facts.overall.sessionCount} Sessions.`;
  return `---
format_version: cookiy.data-summary.v1
privacy_reviewed: false
sources:
${sourceList}
generated_at: ${facts.generatedAt}
---

# Coding Session Data Summary

## Executive Summary

This report summarizes ${counted(facts.overall.sessionCount, 'coding session')} from ${sources.map(sourceName).join(' and ')}, covering ${display(facts.overall.earliestAt)} through ${display(facts.overall.latestAt)}. ${tokenSummary}

### Why This Data Is Valuable

- **Scale and realism:** The source sessions have ${counted(facts.overall.turnCount, 'human user turn')} in total.
- **Tool-use statistics:** The source sessions have ${counted(facts.overall.toolCallCount, 'recorded tool call')}; this report includes aggregate counts, not execution traces.
- **Privacy-minimized scope:** ${topicPrivacy}

## Key Highlights

${renderKeyHighlights(facts)}

## Descriptive Statistics

${renderGeneratedStatistics(facts)}

## Representative Session Samples

No representative samples were included.
`;
}
