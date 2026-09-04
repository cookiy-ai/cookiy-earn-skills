import { createReadStream } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { DataSource } from './markdown-contract.js';
import {
  createRepresentativeCandidates,
  type NormalizedMessage,
  type RepresentativeCandidate,
} from './representative-samples.js';
import {
  createTopicReview,
  type TopicClassification,
  type TopicReviewArtifact,
  type TopicReviewBinding,
} from './topics.js';

export interface SourceInput {
  source: DataSource;
  path: string;
}

export interface Distribution {
  sampleSize: number;
  p50: number;
  p95: number;
  mean: number;
  max: number;
}

export interface TokenCoverage {
  sessionCount: number;
  sessionsWithInputTokens: number;
  sessionsWithOutputTokens: number;
  sessionsWithTotalTokens: number;
}

export interface MetricSet {
  fileCount: number;
  totalBytes: number;
  sessionCount: number;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  turnCount: number;
  toolCallCount: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  earliestAt?: string;
  latestAt?: string;
  activeDays: number;
  activeMonths: number;
  parsedRecordCount: number;
  recognizedRecordCount: number;
  malformedRecordCount: number;
  skippedFileCount: number;
  unsupportedFileCount: number;
  tokenArithmeticMismatchCount: number;
  tokenCoverage: TokenCoverage;
  turnsPerSession: Distribution;
  toolCallsPerSession: Distribution;
  tokensPerSession?: Distribution;
}

export interface FactsReport {
  formatVersion: 'cookiy.facts.v1';
  generatedAt: string;
  overall: MetricSet;
  bySource: Partial<Record<DataSource, MetricSet>>;
  representativeCandidates?: RepresentativeCandidate[];
  topicReview?: TopicReviewBinding;
  topicClassification?: TopicClassification;
}

interface MutableSession {
  rawId: string;
  source: DataSource;
  filePath: string;
  timestamps: number[];
  primaryMessages: NormalizedMessage[];
  fallbackMessages: NormalizedMessage[];
  messages: NormalizedMessage[];
  userMessages: string[];
  models: string[];
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  turnCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  hasInputTokens: boolean;
  hasOutputTokens: boolean;
  hasTotalTokens: boolean;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  cumulativeTotalTokens?: number;
}

interface SourceScan {
  files: Array<{ path: string; bytes: number }>;
  sessions: MutableSession[];
  parsedRecordCount: number;
  recognizedRecordCount: number;
  malformedRecordCount: number;
  skippedFileCount: number;
  unsupportedFileCount: number;
}

const SUPPORTED_EXTENSIONS = new Set(['.json', '.jsonl', '.ndjson']);
const TEXT_CONTENT_TYPES = new Set(['text', 'input_text', 'output_text']);

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function percentile(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(value * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)]!;
}

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return { sampleSize: 0, p50: 0, p95: 0, mean: 0, max: 0 };
  return {
    sampleSize: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    mean: Number((sorted.reduce((sum, item) => sum + item, 0) / sorted.length).toFixed(2)),
    max: sorted.at(-1)!,
  };
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    return Number.isNaN(new Date(millis).getTime()) ? undefined : millis;
  }
  if (typeof value === 'string') {
    const millis = Date.parse(value);
    return Number.isNaN(millis) ? undefined : millis;
  }
  return undefined;
}

function contentText(content: unknown, ignoredTypes = new Set<string>()): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    const item = object(part);
    const type = String(item?.type ?? '');
    if (!item || ignoredTypes.has(type) || (type && !TEXT_CONTENT_TYPES.has(type))) return '';
    return string(item.text) ?? string(item.input_text) ?? string(item.output_text) ?? '';
  }).filter(Boolean).join('\n');
}

function sessionFor(map: Map<string, MutableSession>, source: DataSource, filePath: string, rawId?: string): MutableSession {
  if (!rawId) {
    const fromSameFile = [...map.values()].find((session) => session.source === source && session.filePath === filePath);
    if (fromSameFile) return fromSameFile;
  }
  const id = rawId ?? filePath;
  const key = `${source}\0${id}`;
  const existing = map.get(key);
  if (existing) return existing;
  const created: MutableSession = {
    rawId: id,
    source,
    filePath,
    timestamps: [],
    primaryMessages: [],
    fallbackMessages: [],
    messages: [],
    userMessages: [],
    models: [],
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    turnCount: 0,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    hasInputTokens: false,
    hasOutputTokens: false,
    hasTotalTokens: false,
  };
  map.set(key, created);
  return created;
}

function addMessageCandidate(
  session: MutableSession,
  role: unknown,
  content: unknown,
  ordinal: number,
  timestampMillis: number | undefined,
  fallback = false,
): boolean {
  const text = contentText(content).trim();
  if ((role !== 'user' && role !== 'assistant') || !text) return false;
  (fallback ? session.fallbackMessages : session.primaryMessages).push({
    role,
    text,
    ...(timestampMillis !== undefined ? { timestamp: new Date(timestampMillis).toISOString() } : {}),
    ordinal,
  });
  return true;
}

function finalizeMessages(session: MutableSession): void {
  // Codex response_item messages are canonical per role. event_msg messages fill
  // only a missing role, preventing dual-record inflation without losing mixed logs.
  const messages = session.source === 'codex'
    ? (['user', 'assistant'] as const).flatMap((role) => {
      const primary = session.primaryMessages.filter((item) => item.role === role);
      return primary.length > 0 ? primary : session.fallbackMessages.filter((item) => item.role === role);
    })
    : session.primaryMessages;
  session.messages = messages.sort((left, right) => left.ordinal - right.ordinal);
  session.messageCount = session.messages.length;
  session.userMessageCount = session.messages.filter((message) => message.role === 'user').length;
  session.assistantMessageCount = session.messages.filter((message) => message.role === 'assistant').length;
  session.turnCount = session.userMessageCount;
  session.userMessages = session.messages.filter((message) => message.role === 'user').map((message) => message.text);
}

function addModel(session: MutableSession, ...values: unknown[]): void {
  for (const value of values) {
    const model = string(value);
    if (model && !session.models.includes(model)) session.models.push(model);
  }
}

function addUsage(session: MutableSession, usage: Record<string, unknown> | undefined, cumulative = false): boolean {
  if (!usage) return false;
  const input = numeric(usage.input_tokens ?? usage.inputTokens);
  const output = numeric(usage.output_tokens ?? usage.outputTokens);
  const total = numeric(usage.total_tokens ?? usage.totalTokens);
  if (input !== undefined) {
    if (cumulative) session.cumulativeInputTokens = Math.max(session.cumulativeInputTokens ?? 0, input);
    else session.inputTokens += input;
    session.hasInputTokens = true;
  }
  if (output !== undefined) {
    if (cumulative) session.cumulativeOutputTokens = Math.max(session.cumulativeOutputTokens ?? 0, output);
    else session.outputTokens += output;
    session.hasOutputTokens = true;
  }
  if (total !== undefined) {
    if (cumulative) session.cumulativeTotalTokens = Math.max(session.cumulativeTotalTokens ?? 0, total);
    else session.totalTokens += total;
    session.hasTotalTokens = true;
  }
  return input !== undefined || output !== undefined || total !== undefined;
}

function processCodexRecord(
  record: Record<string, unknown>,
  filePath: string,
  sessions: Map<string, MutableSession>,
  ordinal: number,
): boolean {
  const payload = object(record.payload);
  const supported = record.type === 'session_meta'
    || (record.type === 'response_item' && payload !== undefined)
    || (record.type === 'event_msg' && payload !== undefined);
  if (!supported) return false;

  const sessionId = string(record.session_id) ?? string(record.sessionId) ?? (record.type === 'session_meta' ? string(payload?.id) : undefined);
  const session = sessionFor(sessions, 'codex', filePath, sessionId);
  const time = timestamp(record.timestamp ?? record.created_at ?? payload?.timestamp);
  if (time !== undefined) session.timestamps.push(time);
  addModel(session, record.model, payload?.model, object(payload?.model_info)?.model);
  let recognized = record.type === 'session_meta';

  if (record.type === 'response_item' && payload) {
    if (payload.type === 'message') recognized = addMessageCandidate(session, payload.role, payload.content, ordinal, time) || recognized;
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call' || payload.type === 'local_shell_call') {
      session.toolCallCount += 1;
      recognized = true;
    }
  }
  if (record.type === 'event_msg' && payload) {
    if (payload.type === 'user_message') recognized = addMessageCandidate(session, 'user', string(payload.message) ?? payload.content, ordinal, time, true) || recognized;
    if (payload.type === 'agent_message') recognized = addMessageCandidate(session, 'assistant', string(payload.message) ?? payload.content, ordinal, time, true) || recognized;
    if (payload.type === 'token_count') {
      const info = object(payload.info);
      recognized = addUsage(session, object(info?.total_token_usage), true) || recognized;
    }
  }
  return addUsage(session, object(payload?.usage) ?? object(record.usage)) || recognized;
}

function processClaudeRecord(
  record: Record<string, unknown>,
  filePath: string,
  sessions: Map<string, MutableSession>,
  ordinal: number,
): boolean {
  // V1 intentionally excludes sidechains/subagents rather than guessing whether
  // their internally generated prompts are human turns.
  if (record.isSidechain === true || record.is_sidechain === true
    || typeof record.agentId === 'string' || typeof record.agent_id === 'string'
    || typeof record.parentToolUseID === 'string' || typeof record.parent_tool_use_id === 'string'
    || record.isMeta === true || record.is_meta === true
    || ['system', 'summary', 'progress', 'queue-operation'].includes(String(record.type ?? ''))) return false;
  const message = object(record.message);
  const role = record.type === 'user' || record.type === 'assistant' ? record.type : message?.role;
  if (role !== 'user' && role !== 'assistant') return false;

  const sessionId = string(record.sessionId) ?? string(record.session_id);
  const session = sessionFor(sessions, 'claude_code', filePath, sessionId);
  const time = timestamp(record.timestamp ?? record.createdAt ?? message?.timestamp);
  if (time !== undefined) session.timestamps.push(time);
  addModel(session, record.model, message?.model);
  const content = message?.content ?? record.content;
  const ignoredTypes = role === 'user'
    ? new Set(['tool_result'])
    : new Set(['thinking', 'redacted_thinking', 'tool_use', 'tool_result']);
  const hasMessage = addMessageCandidate(session, role, contentText(content, ignoredTypes), ordinal, time);
  const blocks = Array.isArray(content) ? content : [];
  const toolCalls = role === 'assistant'
    ? blocks.filter((block) => object(block)?.type === 'tool_use').length
    : 0;
  session.toolCallCount += toolCalls;
  const hasUsage = addUsage(session, object(message?.usage) ?? object(record.usage));
  // A tool_result-only record is recognized as Claude data but is not a human turn.
  return hasMessage || toolCalls > 0 || hasUsage || (role === 'user' && blocks.some((block) => object(block)?.type === 'tool_result'));
}

interface CollectedFiles {
  files: Array<{ path: string; bytes: number }>;
  unsupportedFileCount: number;
}

async function collectFiles(inputPath: string): Promise<CollectedFiles> {
  const absolute = resolve(inputPath);
  const info = await stat(absolute);
  if (info.isFile()) return SUPPORTED_EXTENSIONS.has(extname(absolute).toLowerCase())
    ? { files: [{ path: absolute, bytes: info.size }], unsupportedFileCount: 0 }
    : { files: [], unsupportedFileCount: 1 };
  if (!info.isDirectory()) return { files: [], unsupportedFileCount: 0 };
  const output: Array<{ path: string; bytes: number }> = [];
  let unsupportedFileCount = 0;
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const child = resolve(absolute, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(child);
      output.push(...nested.files);
      unsupportedFileCount += nested.unsupportedFileCount;
    } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      const childStat = await stat(child);
      output.push({ path: child, bytes: childStat.size });
    } else if (entry.isFile()) unsupportedFileCount += 1;
  }
  return { files: output, unsupportedFileCount };
}

interface ParseCounts {
  parsed: number;
  recognized: number;
  malformed: number;
}

async function parseJsonLines(filePath: string, onRecord: (record: Record<string, unknown>) => boolean): Promise<ParseCounts> {
  let malformed = 0;
  let parsedCount = 0;
  let recognizedCount = 0;
  const lines = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const record = object(parsed);
      if (record) {
        parsedCount += 1;
        if (onRecord(record)) recognizedCount += 1;
      } else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { parsed: parsedCount, recognized: recognizedCount, malformed };
}

async function parseJson(filePath: string, onRecord: (record: Record<string, unknown>) => boolean): Promise<ParseCounts> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    let malformed = 0;
    let parsedCount = 0;
    let recognizedCount = 0;
    for (const value of records) {
      const record = object(value);
      if (record) {
        parsedCount += 1;
        if (onRecord(record)) recognizedCount += 1;
      } else malformed += 1;
    }
    return { parsed: parsedCount, recognized: recognizedCount, malformed };
  } catch {
    return { parsed: 0, recognized: 0, malformed: 1 };
  }
}

function activityCount(sessions: Map<string, MutableSession>): number {
  return [...sessions.values()].reduce((sum, session) =>
    sum + session.primaryMessages.length + session.fallbackMessages.length + session.toolCallCount, 0);
}

async function scanSource(
  source: DataSource,
  files: Array<{ path: string; bytes: number }>,
  unsupportedFileCount: number,
): Promise<SourceScan> {
  const sessions = new Map<string, MutableSession>();
  let parsedRecordCount = 0;
  let recognizedRecordCount = 0;
  let malformedRecordCount = 0;
  let skippedFileCount = 0;
  let ordinal = 0;
  for (const file of files) {
    const beforeMeaningful = activityCount(sessions);
    const process = (record: Record<string, unknown>) => {
      ordinal += 1;
      return source === 'codex'
        ? processCodexRecord(record, file.path, sessions, ordinal)
        : processClaudeRecord(record, file.path, sessions, ordinal);
    };
    const counts = extname(file.path).toLowerCase() === '.json'
      ? await parseJson(file.path, process)
      : await parseJsonLines(file.path, process);
    parsedRecordCount += counts.parsed;
    recognizedRecordCount += counts.recognized;
    malformedRecordCount += counts.malformed;
    if (activityCount(sessions) === beforeMeaningful) skippedFileCount += 1;
  }
  const finalized = [...sessions.values()];
  finalized.forEach(finalizeMessages);
  return {
    files,
    // A V1 Session must contain at least one semantic human turn.
    sessions: finalized.filter((session) => session.turnCount > 0),
    parsedRecordCount,
    recognizedRecordCount,
    malformedRecordCount,
    skippedFileCount,
    unsupportedFileCount,
  };
}

function sessionInputTokens(session: MutableSession): number | undefined {
  return session.hasInputTokens ? session.cumulativeInputTokens ?? session.inputTokens : undefined;
}

function sessionOutputTokens(session: MutableSession): number | undefined {
  return session.hasOutputTokens ? session.cumulativeOutputTokens ?? session.outputTokens : undefined;
}

function sessionTotalTokens(session: MutableSession): number | undefined {
  const input = sessionInputTokens(session);
  const output = sessionOutputTokens(session);
  if (input !== undefined && output !== undefined) return input + output;
  return undefined;
}

function hasTokenArithmeticMismatch(session: MutableSession): boolean {
  const normalized = sessionTotalTokens(session);
  if (normalized === undefined) return false;
  const reported = session.cumulativeTotalTokens !== undefined
    ? session.cumulativeTotalTokens
    : session.hasTotalTokens ? session.totalTokens : undefined;
  return reported !== undefined && reported !== normalized;
}

function metricSet(scan: SourceScan): MetricSet {
  const timestamps = scan.sessions.flatMap((session) => session.timestamps).sort((a, b) => a - b);
  const days = new Set(timestamps.map((value) => new Date(value).toISOString().slice(0, 10)));
  const months = new Set(timestamps.map((value) => new Date(value).toISOString().slice(0, 7)));
  const sessionsWithInput = scan.sessions.filter((session) => session.hasInputTokens);
  const sessionsWithOutput = scan.sessions.filter((session) => session.hasOutputTokens);
  const sessionsWithCompleteTokens = scan.sessions.flatMap((session) => {
    const input = sessionInputTokens(session);
    const output = sessionOutputTokens(session);
    return input === undefined || output === undefined ? [] : [{ input, output, total: input + output }];
  });
  const inputTokens = sessionsWithCompleteTokens.reduce((sum, session) => sum + session.input, 0);
  const outputTokens = sessionsWithCompleteTokens.reduce((sum, session) => sum + session.output, 0);
  const totalTokens = sessionsWithCompleteTokens.reduce((sum, session) => sum + session.total, 0);
  return {
    fileCount: scan.files.length,
    totalBytes: scan.files.reduce((sum, file) => sum + file.bytes, 0),
    sessionCount: scan.sessions.length,
    messageCount: scan.sessions.reduce((sum, session) => sum + session.messageCount, 0),
    userMessageCount: scan.sessions.reduce((sum, session) => sum + session.userMessageCount, 0),
    assistantMessageCount: scan.sessions.reduce((sum, session) => sum + session.assistantMessageCount, 0),
    turnCount: scan.sessions.reduce((sum, session) => sum + session.turnCount, 0),
    toolCallCount: scan.sessions.reduce((sum, session) => sum + session.toolCallCount, 0),
    ...(sessionsWithCompleteTokens.length > 0 ? { inputTokens, outputTokens, totalTokens } : {}),
    ...(timestamps[0] !== undefined ? { earliestAt: new Date(timestamps[0]).toISOString() } : {}),
    ...(timestamps.at(-1) !== undefined ? { latestAt: new Date(timestamps.at(-1)!).toISOString() } : {}),
    activeDays: days.size,
    activeMonths: months.size,
    parsedRecordCount: scan.parsedRecordCount,
    recognizedRecordCount: scan.recognizedRecordCount,
    malformedRecordCount: scan.malformedRecordCount,
    skippedFileCount: scan.skippedFileCount,
    unsupportedFileCount: scan.unsupportedFileCount,
    tokenArithmeticMismatchCount: scan.sessions.filter(hasTokenArithmeticMismatch).length,
    tokenCoverage: {
      sessionCount: scan.sessions.length,
      sessionsWithInputTokens: sessionsWithInput.length,
      sessionsWithOutputTokens: sessionsWithOutput.length,
      sessionsWithTotalTokens: sessionsWithCompleteTokens.length,
    },
    turnsPerSession: distribution(scan.sessions.map((session) => session.turnCount)),
    toolCallsPerSession: distribution(scan.sessions.map((session) => session.toolCallCount)),
    ...(sessionsWithCompleteTokens.length > 0
      ? { tokensPerSession: distribution(sessionsWithCompleteTokens.map((session) => session.total)) }
      : {}),
  };
}

async function deduplicatedScans(inputs: SourceInput[]): Promise<SourceScan[]> {
  const collected = await Promise.all(inputs.map(async (input) => ({ input, collected: await collectFiles(input.path) })));
  const scans: SourceScan[] = [];
  for (const source of [...new Set(inputs.map((input) => input.source))]) {
    const entries = collected.filter((entry) => entry.input.source === source);
    const canonicalFiles = new Map<string, { path: string; bytes: number }>();
    for (const file of entries.flatMap((entry) => entry.collected.files)) {
      const canonicalPath = await realpath(file.path);
      if (!canonicalFiles.has(canonicalPath)) canonicalFiles.set(canonicalPath, { path: canonicalPath, bytes: file.bytes });
    }
    scans.push(await scanSource(
      source,
      [...canonicalFiles.values()].sort((left, right) => left.path.localeCompare(right.path)),
      entries.reduce((sum, entry) => sum + entry.collected.unsupportedFileCount, 0),
    ));
  }
  return scans;
}

async function computeScans(inputs: SourceInput[]): Promise<{ scans: SourceScan[]; sourceOrder: DataSource[] }> {
  if (inputs.length === 0) throw new Error('At least one explicit source path is required.');
  const seen = new Set<string>();
  for (const input of inputs) {
    const key = `${input.source}\0${resolve(input.path)}`;
    if (seen.has(key)) throw new Error(`Source path ${input.source}=${resolve(input.path)} was provided more than once.`);
    seen.add(key);
  }

  const scans = await deduplicatedScans(inputs);
  const sourceOrder = [...new Set(inputs.map((input) => input.source))];
  const emptySourceIndex = scans.findIndex((scan) => scan.sessions.length === 0);
  if (emptySourceIndex >= 0) {
    throw new Error(`No supported main-session records with a human user turn were found for ${sourceOrder[emptySourceIndex]}.`);
  }
  if (scans.every((scan) => scan.sessions.length === 0)) {
    throw new Error('No supported main-session records with a human user turn were found.');
  }
  return { scans, sourceOrder };
}

function factsFromScans(
  scans: SourceScan[],
  sourceOrder: DataSource[],
  now: Date,
): FactsReport {
  const bySource: Partial<Record<DataSource, MetricSet>> = {};
  sourceOrder.forEach((source, index) => {
    bySource[source] = metricSet(scans[index]!);
  });
  const combinedScan: SourceScan = {
    files: scans.flatMap((scan) => scan.files),
    sessions: scans.flatMap((scan) => scan.sessions),
    parsedRecordCount: scans.reduce((sum, scan) => sum + scan.parsedRecordCount, 0),
    recognizedRecordCount: scans.reduce((sum, scan) => sum + scan.recognizedRecordCount, 0),
    malformedRecordCount: scans.reduce((sum, scan) => sum + scan.malformedRecordCount, 0),
    skippedFileCount: scans.reduce((sum, scan) => sum + scan.skippedFileCount, 0),
    unsupportedFileCount: scans.reduce((sum, scan) => sum + scan.unsupportedFileCount, 0),
  };
  const representativeCandidates = createRepresentativeCandidates(
    scans.flatMap((scan, sourceIndex) => scan.sessions.map((session, sessionIndex) => {
      const inputTokens = sessionInputTokens(session);
      const outputTokens = sessionOutputTokens(session);
      const totalTokens = sessionTotalTokens(session);
      return {
        source: session.source,
        sourceOrder: sourceIndex,
        sessionOrder: sessionIndex,
        timestamps: session.timestamps,
        models: session.models,
        messages: session.messages,
        toolCalls: session.toolCallCount,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
      };
    })),
  );
  return {
    formatVersion: 'cookiy.facts.v1',
    generatedAt: now.toISOString(),
    overall: metricSet(combinedScan),
    bySource,
    ...(representativeCandidates ? { representativeCandidates } : {}),
  };
}

export async function computeFacts(
  inputs: SourceInput[],
  now = new Date(),
): Promise<FactsReport> {
  const { scans, sourceOrder } = await computeScans(inputs);
  return factsFromScans(scans, sourceOrder, now);
}

export async function computeFactsWithTopicReview(
  inputs: SourceInput[],
  now = new Date(),
): Promise<{ facts: FactsReport; topicReview: TopicReviewArtifact }> {
  const { scans, sourceOrder } = await computeScans(inputs);
  const facts = factsFromScans(scans, sourceOrder, now);
  const sessions = scans.flatMap((scan) => scan.sessions).map((session) => ({
    internalIdentity: session.rawId,
    source: session.source,
    userMessages: session.userMessages,
  }));
  const { binding, review } = createTopicReview(sessions, facts.generatedAt);
  return { facts: { ...facts, topicReview: binding }, topicReview: review };
}
