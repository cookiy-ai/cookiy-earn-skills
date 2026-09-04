import { detectSensitiveContent, redactText } from './redaction.js';
import type { DataSource } from './markdown-contract.js';

export const MAX_REPRESENTATIVE_CANDIDATES = 8;
export const MAX_REPRESENTATIVE_EXCERPT_CODE_POINTS = 280;
export const MAX_REPRESENTATIVE_EXCERPTS_PER_CANDIDATE = 5;

export interface NormalizedMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
  ordinal: number;
}

export interface RepresentativeExcerpt {
  role: 'user' | 'assistant';
  position: 'opening' | 'middle' | 'closing';
  text: string;
}

export interface RepresentativeCandidate {
  evidenceRef: string;
  source: DataSource;
  startedAt?: string;
  endedAt?: string;
  models?: string[];
  sessionType: 'agentic' | 'conversation';
  messageCount: number;
  userTurns: number;
  toolCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  excerpts: RepresentativeExcerpt[];
}

export interface RepresentativeSessionInput {
  source: DataSource;
  sourceOrder: number;
  sessionOrder: number;
  timestamps: number[];
  models: string[];
  messages: NormalizedMessage[];
  toolCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function removeFencedCode(value: string): string {
  const output: string[] = [];
  let fenced = false;
  let character = '';
  let length = 0;
  for (const line of value.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fenced && marker) {
      fenced = true;
      character = marker[0]!;
      length = marker.length;
      output.push('[REMOVED_CODE]');
      continue;
    }
    if (fenced) {
      if (marker?.[0] === character && marker.length >= length) fenced = false;
      continue;
    }
    output.push(line);
  }
  return output.join('\n');
}

function stripMarkdownResources(value: string): string {
  return removeFencedCode(value)
    .replace(/!\[([^\]\n]*)\](?:\([^\n)]*\)|\[[^\]\n]*\])/g, ' $1 ')
    .replace(/\[([^\]\n]+)\](?:\([^\n)]*\)|\[[^\]\n]*\])/g, ' $1 ')
    .replace(/^\s{0,3}\[[^\]\n]+\]:\s*\S.*$/gm, ' ')
    .replace(/<(?:https?|ftp|file|s3|mailto):[^>]+>/gi, ' [REMOVED_RESOURCE] ')
    .replace(/\b(?:https?|ftp|file|s3):\/\/[^\s<>()\[\]{}]+/gi, ' [REMOVED_RESOURCE] ')
    .replace(/(^|[\s(])\/\/[A-Za-z0-9][^\s<>()\[\]{}]*/g, '$1[REMOVED_RESOURCE]')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1');
}

function hasMeaningfulNaturalLanguage(value: string): boolean {
  const withoutPlaceholders = value.replace(/\[(?:REDACTED|REMOVED|HOME|LOCAL_PATH)[^\]]*\]/gi, ' ');
  return (withoutPlaceholders.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3;
}

export function normalizeRepresentativeExcerpt(value: string): string | undefined {
  const withoutResources = stripMarkdownResources(value);
  const withoutControls = withoutResources.replace(/\p{C}/gu, ' ');
  const redacted = redactText(withoutControls).text.replace(/\s+/gu, ' ').trim();
  if (!redacted || !hasMeaningfulNaturalLanguage(redacted)) return undefined;
  const points = Array.from(redacted);
  const truncated = points.length <= MAX_REPRESENTATIVE_EXCERPT_CODE_POINTS
    ? redacted
    : `${points.slice(0, MAX_REPRESENTATIVE_EXCERPT_CODE_POINTS - 1).join('').trimEnd()}…`;
  if (!truncated || detectSensitiveContent(truncated).length > 0) return undefined;
  return truncated;
}

function excerptsFor(messages: NormalizedMessage[]): RepresentativeExcerpt[] {
  const users = messages.filter((message) => message.role === 'user');
  const opening = users[0];
  if (!opening) return [];
  const closing = users.at(-1)!;
  const messageIndexes = new Map(messages.map((message, index) => [message, index]));
  const assistantAfter = (ordinal: number) => messages
    .find((message) => message.role === 'assistant' && message.ordinal > ordinal);
  const middle = users.slice(1, -1).flatMap((message) => {
    const normalized = normalizeRepresentativeExcerpt(message.text);
    if (!normalized) return [];
    const index = messageIndexes.get(message)!;
    const previous = messages[index - 1];
    const next = messages[index + 1];
    const before = previous?.role === 'assistant' ? previous : undefined;
    const after = next?.role === 'assistant' ? next : undefined;
    return [{
      message,
      before,
      after,
      completeness: Number(before !== undefined) + Number(after !== undefined),
      length: codePointLength(normalized),
    }];
  }).sort((left, right) => right.completeness - left.completeness
    || right.length - left.length
    || left.message.ordinal - right.message.ordinal)[0];

  const chosen: Array<{ message: NormalizedMessage; position: RepresentativeExcerpt['position'] }> = [
    { message: opening, position: 'opening' },
  ];
  if (middle) {
    if (middle.before) chosen.push({ message: middle.before, position: 'middle' });
    chosen.push({ message: middle.message, position: 'middle' });
    if (middle.after) chosen.push({ message: middle.after, position: 'middle' });
    const terminal = assistantAfter(closing.ordinal) ?? closing;
    chosen.push({ message: terminal, position: 'closing' });
  } else {
    const openingAssistant = assistantAfter(opening.ordinal);
    if (openingAssistant) chosen.push({ message: openingAssistant, position: 'opening' });
    if (closing.ordinal !== opening.ordinal) {
      chosen.push({ message: closing, position: 'closing' });
      const closingAssistant = assistantAfter(closing.ordinal);
      if (closingAssistant) chosen.push({ message: closingAssistant, position: 'closing' });
    }
  }

  const seen = new Set<string>();
  return chosen.flatMap(({ message, position }) => {
    const key = `${message.role}:${message.ordinal}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const text = normalizeRepresentativeExcerpt(message.text);
    return text ? [{ role: message.role, position, text }] : [];
  });
}

interface EligibleSession extends RepresentativeSessionInput {
  excerpts: RepresentativeExcerpt[];
  userTurns: number;
  assistantMessages: number;
}

function activityScore(session: EligibleSession): number {
  return Math.min(session.userTurns, 20) * 3
    + Math.min(session.assistantMessages, 20) * 2
    + Math.min(session.toolCalls, 20);
}

function elapsedDuration(session: EligibleSession): number {
  if (session.timestamps.length < 2) return 0;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const value of session.timestamps) {
    earliest = Math.min(earliest, value);
    latest = Math.max(latest, value);
  }
  return latest - earliest;
}

function byMetric(metric: (session: EligibleSession) => number) {
  return (left: EligibleSession, right: EligibleSession): number => metric(right) - metric(left)
    || left.sourceOrder - right.sourceOrder
    || left.sessionOrder - right.sessionOrder;
}

function selectRepresentativeSessions(sessions: EligibleSession[]): EligibleSession[] {
  const selected: EligibleSession[] = [];
  const remaining = new Set(sessions);
  const add = (session: EligibleSession | undefined) => {
    if (!session || !remaining.has(session) || selected.length >= MAX_REPRESENTATIVE_CANDIDATES) return;
    selected.push(session);
    remaining.delete(session);
  };

  for (const source of [...new Set(sessions
    .sort((left, right) => left.sourceOrder - right.sourceOrder || left.sessionOrder - right.sessionOrder)
    .map((session) => session.source))]) {
    add([...remaining].filter((session) => session.source === source).sort(byMetric(activityScore))[0]);
  }
  add([...remaining].sort(byMetric((session) => session.userTurns))[0]);
  const longestElapsed = [...remaining].sort(byMetric(elapsedDuration))[0];
  if (longestElapsed && elapsedDuration(longestElapsed) > 0) add(longestElapsed);
  add([...remaining].sort(byMetric((session) => session.toolCalls))[0]);
  for (const session of [...remaining].sort(byMetric(activityScore))) add(session);
  return selected;
}

function safeModels(models: string[]): string[] | undefined {
  const values = [...new Set(models)]
    .map((model) => model.replace(/\p{C}/gu, '').trim())
    .filter((model) => model.length > 0 && codePointLength(model) <= 120 && !/[|\r\n]/.test(model)
      && detectSensitiveContent(model).length === 0);
  return values.length > 0 ? values : undefined;
}

export function createRepresentativeCandidates(sessions: RepresentativeSessionInput[]): RepresentativeCandidate[] {
  const eligible = sessions.flatMap((session): EligibleSession[] => {
    const messages = [...session.messages].sort((left, right) => left.ordinal - right.ordinal);
    const userTurns = messages.filter((message) => message.role === 'user').length;
    const assistantMessages = messages.filter((message) => message.role === 'assistant').length;
    const excerpts = excerptsFor(messages);
    if (userTurns === 0 || !excerpts.some((excerpt) => excerpt.role === 'user')) return [];
    return [{ ...session, messages, excerpts, userTurns, assistantMessages }];
  });

  return selectRepresentativeSessions(eligible).map((session, index) => {
    const timestamps = [...session.timestamps].sort((left, right) => left - right);
    const models = safeModels(session.models);
    return {
      evidenceRef: `candidate-${String(index + 1).padStart(2, '0')}`,
      source: session.source,
      ...(timestamps[0] !== undefined ? { startedAt: new Date(timestamps[0]).toISOString() } : {}),
      ...(timestamps.at(-1) !== undefined ? { endedAt: new Date(timestamps.at(-1)!).toISOString() } : {}),
      ...(models ? { models } : {}),
      sessionType: session.toolCalls > 0 ? 'agentic' : 'conversation',
      messageCount: session.messages.length,
      userTurns: session.userTurns,
      toolCalls: session.toolCalls,
      ...(session.inputTokens !== undefined ? { inputTokens: session.inputTokens } : {}),
      ...(session.outputTokens !== undefined ? { outputTokens: session.outputTokens } : {}),
      ...(session.totalTokens !== undefined ? { totalTokens: session.totalTokens } : {}),
      excerpts: session.excerpts,
    };
  });
}
