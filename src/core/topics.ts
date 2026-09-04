import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { contentHash } from './content-hash.js';
import { detectSensitiveContent, redactText } from './redaction.js';
import type { FactsReport } from './statistics.js';
import type { DataSource } from './markdown-contract.js';

export const TOPICS = [
  'frontend',
  'backend',
  'devops_infra',
  'data_science_ml',
  'mobile',
  'security',
  'developer_tooling',
  'general_coding',
  'mixed',
  'other',
  'unknown',
] as const;

export type Topic = typeof TOPICS[number];

export interface TopicReviewSession {
  evidenceRef: string;
  source: DataSource;
  userEvidence: string[];
  technicalSignals?: string[];
  primaryTopic: Topic | null;
}

export interface TopicReviewArtifact {
  formatVersion: 'cookiy.topic-review.v1';
  generatedAt: string;
  populationSha256: string;
  sessionCount: number;
  sessions: TopicReviewSession[];
}

export interface TopicReviewBinding {
  formatVersion: 'cookiy.topic-review.v1';
  populationSha256: string;
  sessionCount: number;
  evidenceRefs: string[];
}

export interface TopicAssignment {
  evidenceRef: string;
  source: DataSource;
  primaryTopic: Topic;
}

export interface TopicClassification {
  method: 'agent_semantic_review_v1';
  taxonomyVersion: 'primary-topic-v1';
  populationSha256: string;
  denominator: number;
  reviewedSessionCount: number;
  assignments: TopicAssignment[];
  counts: Record<Topic, number>;
}

export interface TopicReviewInputSession {
  internalIdentity: string;
  source: DataSource;
  userMessages: string[];
}

const SOURCES = ['codex', 'claude_code'] as const;
const TOPIC_SET = new Set<string>(TOPICS);
const REVIEW_ROOT_KEYS = new Set(['formatVersion', 'generatedAt', 'populationSha256', 'sessionCount', 'sessions']);
const REVIEW_SESSION_KEYS = new Set(['evidenceRef', 'source', 'userEvidence', 'technicalSignals', 'primaryTopic']);
const BINDING_KEYS = new Set(['formatVersion', 'populationSha256', 'sessionCount', 'evidenceRefs']);
const CLASSIFICATION_KEYS = new Set([
  'method', 'taxonomyVersion', 'populationSha256', 'denominator', 'reviewedSessionCount', 'assignments', 'counts',
]);
const ASSIGNMENT_KEYS = new Set(['evidenceRef', 'source', 'primaryTopic']);
const MAX_EVIDENCE_SEGMENTS = 3;
const MAX_EVIDENCE_CODE_POINTS = 600;

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`${path} contains unsupported field ${unexpected}.`);
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative safe integer.`);
  }
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a non-empty string.`);
  return value;
}

function sha256(value: unknown, path: string): string {
  const candidate = nonEmptyString(value, path);
  if (!/^[a-f0-9]{64}$/.test(candidate)) throw new Error(`${path} must be a lowercase SHA-256.`);
  return candidate;
}

function isoTimestamp(value: unknown, path: string): string {
  const candidate = nonEmptyString(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(candidate)
    || Number.isNaN(Date.parse(candidate))) {
    throw new Error(`${path} must be a valid UTC ISO-8601 timestamp.`);
  }
  return candidate;
}

function source(value: unknown, path: string): DataSource {
  if (!SOURCES.includes(value as DataSource)) throw new Error(`${path} contains an unsupported source.`);
  return value as DataSource;
}

function topic(value: unknown, path: string): Topic {
  if (typeof value !== 'string' || !TOPIC_SET.has(value)) throw new Error(`${path} contains an unsupported Topic.`);
  return value as Topic;
}

function evidenceRef(value: unknown, path: string): string {
  const candidate = nonEmptyString(value, path);
  if (candidate.length > 128 || !/^[a-z0-9-]+$/.test(candidate)) {
    throw new Error(`${path} must be a short report-local reference.`);
  }
  return candidate;
}

function unique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${path} must contain unique values.`);
}

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function codePointLength(value: string): number {
  return [...value].length;
}

export function normalizeTopicEvidence(value: string): string {
  const normalized = value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return redactText(normalized).text.trim();
}

function limitedEvidence(messages: string[]): string[] {
  return messages
    .map(normalizeTopicEvidence)
    .filter(Boolean)
    .slice(0, MAX_EVIDENCE_SEGMENTS)
    .map((value) => [...value].slice(0, MAX_EVIDENCE_CODE_POINTS).join('').trim());
}

function canonicalPopulation(nonce: string, sessions: TopicReviewInputSession[]): string {
  const members = sessions
    .map((session) => `${session.source}\0${session.internalIdentity}`)
    .sort((left, right) => left.localeCompare(right));
  return JSON.stringify({ nonce, members });
}

export function createTopicReview(
  sessions: TopicReviewInputSession[],
  generatedAt: string,
): { binding: TopicReviewBinding; review: TopicReviewArtifact } {
  if (sessions.length === 0) throw new Error('A Topic review requires at least one Session.');
  const nonce = randomBytes(32).toString('hex');
  const prefix = contentHash(nonce).slice(0, 12);
  const populationSha256 = contentHash(canonicalPopulation(nonce, sessions));
  const reviewSessions = sessions.map((session, index): TopicReviewSession => {
    const userEvidence = limitedEvidence(session.userMessages);
    const issues = userEvidence.flatMap((value) => detectSensitiveContent(value));
    if (issues.length > 0) throw new Error(`Topic review evidence still contains high-risk sensitive content (${issues[0]!.code}).`);
    return {
      evidenceRef: `topic-${prefix}-${String(index + 1).padStart(6, '0')}`,
      source: session.source,
      userEvidence,
      primaryTopic: null,
    };
  });
  const evidenceRefs = reviewSessions.map((session) => session.evidenceRef);
  return {
    binding: {
      formatVersion: 'cookiy.topic-review.v1',
      populationSha256,
      sessionCount: reviewSessions.length,
      evidenceRefs,
    },
    review: {
      formatVersion: 'cookiy.topic-review.v1',
      generatedAt,
      populationSha256,
      sessionCount: reviewSessions.length,
      sessions: reviewSessions,
    },
  };
}

function validateEvidence(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_SEGMENTS) {
    throw new Error(`${path} must contain at most ${MAX_EVIDENCE_SEGMENTS} evidence segments.`);
  }
  return value.map((item, index) => {
    const candidate = nonEmptyString(item, `${path}[${index}]`);
    if (codePointLength(candidate) > MAX_EVIDENCE_CODE_POINTS) {
      throw new Error(`${path}[${index}] must contain at most ${MAX_EVIDENCE_CODE_POINTS} Unicode code points.`);
    }
    if (normalizeTopicEvidence(candidate) !== candidate) throw new Error(`${path}[${index}] is not normalized and redacted.`);
    const issue = detectSensitiveContent(candidate)[0];
    if (issue) throw new Error(`${path}[${index}] contains high-risk sensitive content (${issue.code}).`);
    return candidate;
  });
}

function validateTechnicalSignals(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) throw new Error(`${path} must contain at most 32 technical signals.`);
  const signals = value.map((item, index) => {
    const candidate = nonEmptyString(item, `${path}[${index}]`);
    if (candidate.length > 64 || !/^[a-z0-9_.:+-]+$/.test(candidate)) {
      throw new Error(`${path}[${index}] must be a low-risk normalized technical category.`);
    }
    return candidate;
  });
  unique(signals, path);
  return signals;
}

export function validateTopicReviewArtifact(value: unknown): TopicReviewArtifact {
  const root = object(value, 'topicReview');
  assertOnlyKeys(root, REVIEW_ROOT_KEYS, 'topicReview');
  if (root.formatVersion !== 'cookiy.topic-review.v1') {
    throw new Error('topicReview.formatVersion must be cookiy.topic-review.v1.');
  }
  const generatedAt = isoTimestamp(root.generatedAt, 'topicReview.generatedAt');
  const populationSha256 = sha256(root.populationSha256, 'topicReview.populationSha256');
  const sessionCount = nonNegativeInteger(root.sessionCount, 'topicReview.sessionCount');
  if (sessionCount === 0) throw new Error('topicReview.sessionCount must be greater than zero.');
  if (!Array.isArray(root.sessions)) throw new Error('topicReview.sessions must be an array.');
  const sessions = root.sessions.map((item, index): TopicReviewSession => {
    const path = `topicReview.sessions[${index}]`;
    const session = object(item, path);
    assertOnlyKeys(session, REVIEW_SESSION_KEYS, path);
    const technicalSignals = validateTechnicalSignals(session.technicalSignals, `${path}.technicalSignals`);
    const primaryTopic = session.primaryTopic === null ? null : topic(session.primaryTopic, `${path}.primaryTopic`);
    return {
      evidenceRef: evidenceRef(session.evidenceRef, `${path}.evidenceRef`),
      source: source(session.source, `${path}.source`),
      userEvidence: validateEvidence(session.userEvidence, `${path}.userEvidence`),
      ...(technicalSignals ? { technicalSignals } : {}),
      primaryTopic,
    };
  });
  if (sessions.length !== sessionCount) throw new Error('topicReview.sessions length must equal sessionCount.');
  unique(sessions.map((session) => session.evidenceRef), 'topicReview.sessions evidenceRef values');
  return { formatVersion: 'cookiy.topic-review.v1', generatedAt, populationSha256, sessionCount, sessions };
}

export async function readTopicReviewFile(filePath: string): Promise<TopicReviewArtifact> {
  return validateTopicReviewArtifact(JSON.parse(await readFile(filePath, 'utf8')) as unknown);
}

export function validateTopicReviewBinding(value: unknown, expectedSessionCount: number): TopicReviewBinding {
  const binding = object(value, 'facts.topicReview');
  assertOnlyKeys(binding, BINDING_KEYS, 'facts.topicReview');
  if (binding.formatVersion !== 'cookiy.topic-review.v1') {
    throw new Error('facts.topicReview.formatVersion must be cookiy.topic-review.v1.');
  }
  const populationSha256 = sha256(binding.populationSha256, 'facts.topicReview.populationSha256');
  const sessionCount = nonNegativeInteger(binding.sessionCount, 'facts.topicReview.sessionCount');
  if (sessionCount !== expectedSessionCount) throw new Error('facts.topicReview.sessionCount must equal facts.overall.sessionCount.');
  if (!Array.isArray(binding.evidenceRefs)) throw new Error('facts.topicReview.evidenceRefs must be an array.');
  const evidenceRefs = binding.evidenceRefs.map((item, index) => evidenceRef(item, `facts.topicReview.evidenceRefs[${index}]`));
  if (evidenceRefs.length !== sessionCount) throw new Error('facts.topicReview.evidenceRefs length must equal sessionCount.');
  unique(evidenceRefs, 'facts.topicReview.evidenceRefs');
  return { formatVersion: 'cookiy.topic-review.v1', populationSha256, sessionCount, evidenceRefs };
}

function emptyCounts(): Record<Topic, number> {
  return Object.fromEntries(TOPICS.map((item) => [item, 0])) as Record<Topic, number>;
}

export function applyTopicReview(baseFacts: FactsReport, review: TopicReviewArtifact): FactsReport {
  const binding = baseFacts.topicReview;
  if (!binding) throw new Error('Base facts do not contain a Topic review binding.');
  if (baseFacts.topicClassification) throw new Error('Base facts already contain Topic classification.');
  if (review.generatedAt !== baseFacts.generatedAt) throw new Error('Topic review generatedAt does not match base facts.');
  if (review.populationSha256 !== binding.populationSha256) throw new Error('Topic review populationSha256 does not match base facts.');
  if (review.sessionCount !== binding.sessionCount) throw new Error('Topic review sessionCount does not match base facts.');
  const refs = review.sessions.map((session) => session.evidenceRef);
  if (!sameValues(refs, binding.evidenceRefs)) throw new Error('Topic review evidenceRef sequence does not match base facts.');
  const incomplete = review.sessions.find((session) => session.primaryTopic === null);
  if (incomplete) throw new Error(`Topic review is incomplete at ${incomplete.evidenceRef}.`);

  const assignments = review.sessions.map((session): TopicAssignment => ({
    evidenceRef: session.evidenceRef,
    source: session.source,
    primaryTopic: session.primaryTopic!,
  }));
  const counts = emptyCounts();
  for (const assignment of assignments) counts[assignment.primaryTopic] += 1;
  return {
    ...baseFacts,
    topicClassification: {
      method: 'agent_semantic_review_v1',
      taxonomyVersion: 'primary-topic-v1',
      populationSha256: binding.populationSha256,
      denominator: binding.sessionCount,
      reviewedSessionCount: assignments.length,
      assignments,
      counts,
    },
  };
}

export function validateTopicClassification(
  value: unknown,
  binding: TopicReviewBinding,
  expectedSessionCount: number,
  sourceSessionCounts: Partial<Record<DataSource, number>>,
): TopicClassification {
  const classification = object(value, 'facts.topicClassification');
  assertOnlyKeys(classification, CLASSIFICATION_KEYS, 'facts.topicClassification');
  if (classification.method !== 'agent_semantic_review_v1') {
    throw new Error('facts.topicClassification.method must be agent_semantic_review_v1.');
  }
  if (classification.taxonomyVersion !== 'primary-topic-v1') {
    throw new Error('facts.topicClassification.taxonomyVersion must be primary-topic-v1.');
  }
  const populationSha256 = sha256(classification.populationSha256, 'facts.topicClassification.populationSha256');
  if (populationSha256 !== binding.populationSha256) {
    throw new Error('facts.topicClassification.populationSha256 must match facts.topicReview.');
  }
  const denominator = nonNegativeInteger(classification.denominator, 'facts.topicClassification.denominator');
  const reviewedSessionCount = nonNegativeInteger(
    classification.reviewedSessionCount,
    'facts.topicClassification.reviewedSessionCount',
  );
  if (denominator !== expectedSessionCount) throw new Error('facts.topicClassification.denominator must equal facts.overall.sessionCount.');
  if (reviewedSessionCount !== denominator) throw new Error('facts.topicClassification.reviewedSessionCount must equal denominator.');
  if (!Array.isArray(classification.assignments)) throw new Error('facts.topicClassification.assignments must be an array.');
  const assignments = classification.assignments.map((item, index): TopicAssignment => {
    const path = `facts.topicClassification.assignments[${index}]`;
    const assignment = object(item, path);
    assertOnlyKeys(assignment, ASSIGNMENT_KEYS, path);
    return {
      evidenceRef: evidenceRef(assignment.evidenceRef, `${path}.evidenceRef`),
      source: source(assignment.source, `${path}.source`),
      primaryTopic: topic(assignment.primaryTopic, `${path}.primaryTopic`),
    };
  });
  if (assignments.length !== denominator) throw new Error('facts.topicClassification.assignments length must equal denominator.');
  const assignmentRefs = assignments.map((assignment) => assignment.evidenceRef);
  unique(assignmentRefs, 'facts.topicClassification.assignments evidenceRef values');
  if (!sameValues(assignmentRefs, binding.evidenceRefs)) {
    throw new Error('facts.topicClassification assignment references must match facts.topicReview.');
  }
  for (const sourceName of SOURCES) {
    const actual = assignments.filter((assignment) => assignment.source === sourceName).length;
    const expected = sourceSessionCounts[sourceName] ?? 0;
    if (actual !== expected) throw new Error(`facts.topicClassification ${sourceName} assignment count must match facts.bySource.`);
  }

  const rawCounts = object(classification.counts, 'facts.topicClassification.counts');
  assertOnlyKeys(rawCounts, new Set<string>(TOPICS), 'facts.topicClassification.counts');
  if (Object.keys(rawCounts).length !== TOPICS.length) {
    throw new Error('facts.topicClassification.counts must contain every Topic.');
  }
  const counts = emptyCounts();
  for (const topicName of TOPICS) counts[topicName] = nonNegativeInteger(rawCounts[topicName], `facts.topicClassification.counts.${topicName}`);
  const derived = emptyCounts();
  for (const assignment of assignments) derived[assignment.primaryTopic] += 1;
  for (const topicName of TOPICS) {
    if (counts[topicName] !== derived[topicName]) throw new Error('facts.topicClassification.counts must be derived from assignments.');
  }
  if (Object.values(counts).reduce((sum, count) => sum + count, 0) !== denominator) {
    throw new Error('facts.topicClassification counts must sum to denominator.');
  }
  return {
    method: 'agent_semantic_review_v1',
    taxonomyVersion: 'primary-topic-v1',
    populationSha256,
    denominator,
    reviewedSessionCount,
    assignments,
    counts,
  };
}
