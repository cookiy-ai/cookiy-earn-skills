import { readFile } from 'node:fs/promises';
import { renderDataSummary, renderGeneratedStatistics } from './data-summary.js';
import { detectSensitiveContent, redactText, type RedactionIssue } from './redaction.js';
import type { FactsReport } from './statistics.js';

export const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024;
export const FORMAT_VERSION = 'cookiy.data-summary.v1';
export const ALLOWED_SOURCES = ['codex', 'claude_code'] as const;
export type DataSource = (typeof ALLOWED_SOURCES)[number];

export interface MarkdownMetadata {
  formatVersion?: string;
  sources: DataSource[];
  generatedAt?: string;
  privacyReviewed?: boolean;
  sampleCount: number;
}

export interface ValidationIssue extends RedactionIssue {}

export interface MarkdownValidationResult {
  valid: boolean;
  sizeBytes: number;
  metadata: MarkdownMetadata;
  issues: ValidationIssue[];
}

function issue(code: string, message: string, line = 1, column = 1): ValidationIssue {
  return { code, severity: 'error', line, column, message };
}

function parseFrontMatter(text: string): { values: Record<string, unknown>; endLine: number; issues: ValidationIssue[] } {
  const lines = text.split(/\r?\n/);
  const issues: ValidationIssue[] = [];
  if (lines[0] !== '---') return { values: {}, endLine: 0, issues: [issue('MISSING_FRONT_MATTER', 'The document must begin with YAML front matter.') ] };
  const endIndex = lines.indexOf('---', 1);
  if (endIndex < 0) return { values: {}, endLine: 0, issues: [issue('INVALID_FRONT_MATTER', 'The front matter closing delimiter is missing.') ] };

  const values: Record<string, unknown> = {};
  let activeList: string | undefined;
  for (let index = 1; index < endIndex; index += 1) {
    const line = lines[index] ?? '';
    const pair = /^([a-z0-9_]+):(?:\s*(.*))?$/.exec(line);
    if (pair) {
      const key = pair[1] ?? '';
      const rawValue = (pair[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
      if (rawValue === '') {
        values[key] = [];
        activeList = key;
      } else {
        values[key] = rawValue;
        activeList = undefined;
      }
      continue;
    }
    const item = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (item && activeList && Array.isArray(values[activeList])) {
      (values[activeList] as string[]).push((item[1] ?? '').replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (line.trim() !== '') issues.push(issue('INVALID_FRONT_MATTER', 'Only simple scalar fields and source lists are supported.', index + 1));
  }
  return { values, endLine: endIndex + 1, issues };
}

interface ScannedLine {
  text: string;
  line: number;
  start: number;
  end: number;
  fenced: boolean;
}

function scanLines(text: string): { lines: ScannedLine[]; fenceLines: number[] } {
  const lines: ScannedLine[] = [];
  const fenceLines: number[] = [];
  let offset = 0;
  let fenced = false;
  let fenceCharacter = '';
  let fenceLength = 0;
  for (const [index, raw] of text.split(/(?<=\n)/).entries()) {
    const line = raw.replace(/\r?\n$/, '');
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const before = fenced;
    if (marker) {
      fenceLines.push(index + 1);
      const sequence = marker[1]!;
      if (!fenced) {
        fenced = true;
        fenceCharacter = sequence[0]!;
        fenceLength = sequence.length;
      } else if (sequence[0] === fenceCharacter && sequence.length >= fenceLength) {
        fenced = false;
      }
    }
    lines.push({ text: line, line: index + 1, start: offset, end: offset + line.length, fenced: before || Boolean(marker) });
    offset += raw.length;
  }
  return { lines, fenceLines };
}

function headingPositions(lines: ScannedLine[], heading: string): ScannedLine[] {
  return lines.filter((line) => !line.fenced && line.text === heading);
}

function representativeSampleRange(
  lines: ScannedLine[],
  textLength: number,
): { start: number; end: number; headingLine: number } | undefined {
  const section = headingPositions(lines, '## Representative Session Samples')[0];
  if (!section) return undefined;
  const nextSection = lines.find((line) => line.line > section.line && !line.fenced && /^##\s+/.test(line.text));
  return { start: section.end, end: nextSection?.start ?? textLength, headingLine: section.line };
}

function protectSampleTables(text: string): { text: string; restore: (value: string) => string } {
  const replacements: Array<{ marker: string; value: string }> = [];
  let sequence = 0;
  const protectedText = text.replace(/^\|[^\r\n]*\|[ \t]*$/gm, (value) => {
    let marker = '';
    do {
      marker = `COOKIYPROTECTEDSAMPLETABLE${sequence}END`;
      sequence += 1;
    } while (text.includes(marker));
    replacements.push({ marker, value });
    return marker;
  });
  return {
    text: protectedText,
    restore: (value) => replacements.reduce((output, item) => output.replace(item.marker, item.value), value),
  };
}

export function redactRepresentativeSamples(text: string): ReturnType<typeof redactText> {
  const scanned = scanLines(text);
  const range = representativeSampleRange(scanned.lines, text.length);
  if (!range) return { text, redactions: {} };
  const sample = protectSampleTables(text.slice(range.start, range.end));
  const result = redactText(sample.text);
  return {
    text: `${text.slice(0, range.start)}${sample.restore(result.text)}${text.slice(range.end)}`,
    redactions: result.redactions,
  };
}

function sampleSensitiveContentIssues(text: string, lines: ScannedLine[]): ValidationIssue[] {
  const range = representativeSampleRange(lines, text.length);
  if (!range) return [];
  const sample = protectSampleTables(text.slice(range.start, range.end));
  return detectSensitiveContent(sample.text).map((item) => ({
    ...item,
    line: item.line + range.headingLine - 1,
  }));
}

function validateDocumentStructure(lines: ScannedLine[], fenceLines: number[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const requiredHeadings = [
    '# Coding Session Data Summary',
    '## Executive Summary',
    '### Why This Data Is Valuable',
    '## Key Highlights',
    '## Descriptive Statistics',
    '### Overall',
    '### By Source',
    '## Representative Session Samples',
  ];
  let previous = -1;
  for (const heading of requiredHeadings) {
    const positions = headingPositions(lines, heading);
    if (positions.length === 0) {
      issues.push(issue('MISSING_SECTION', `Missing required heading: ${heading}`));
      continue;
    }
    if (positions.length > 1) issues.push(issue('DUPLICATE_SECTION', `Required heading appears more than once: ${heading}`));
    if (positions[0]!.line <= previous) issues.push(issue('SECTION_ORDER', `Required heading is out of order: ${heading}`));
    previous = positions[0]!.line;
  }
  if (fenceLines[0] !== undefined) {
    issues.push(issue('CODE_FENCE_NOT_ALLOWED', 'Fenced code blocks are not allowed in a Data Summary.', fenceLines[0]));
  }
  return issues;
}

function validateFactsBinding(
  text: string,
  lines: ScannedLine[],
  sources: DataSource[],
  privacyReviewed: boolean,
  facts: FactsReport | undefined,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!facts) return [issue('FACTS_FILE_REQUIRED', 'A Data Summary must be validated and uploaded with its local cookiy.facts.v1 file.')];
  const expectedSources = Object.keys(facts.bySource).sort();
  if (JSON.stringify([...sources].sort()) !== JSON.stringify(expectedSources)) {
    issues.push(issue('FACTS_SOURCE_MISMATCH', 'Front-matter sources do not match the supplied facts file.'));
  }
  const placeholder = 'No representative samples were included.';
  const expected = renderDataSummary(facts).replace('privacy_reviewed: false', `privacy_reviewed: ${privacyReviewed}`);
  const placeholderAt = expected.indexOf(placeholder);
  const expectedPrefix = expected.slice(0, placeholderAt);
  const expectedSuffix = expected.slice(placeholderAt + placeholder.length);
  if (placeholderAt < 0 || !text.startsWith(expectedPrefix) || !text.endsWith(expectedSuffix)) {
    issues.push(issue('GENERATED_CONTENT_CHANGED', 'Content outside Representative Session Samples differs from the supplied facts file; render it again instead of editing it manually.'));
  }
  const statisticsHeading = headingPositions(lines, '## Descriptive Statistics')[0];
  const overallHeading = headingPositions(lines, '### Overall')[0];
  const samplesHeading = headingPositions(lines, '## Representative Session Samples')[0];
  if (!statisticsHeading || !overallHeading || !samplesHeading) {
    issues.push(issue('MISSING_GENERATED_STATISTICS', 'The deterministic statistics section is missing.'));
  } else if (overallHeading.line <= statisticsHeading.line || samplesHeading.line <= overallHeading.line) {
    issues.push(issue('GENERATED_STATISTICS_LOCATION', 'The deterministic statistics must stay inside Descriptive Statistics.'));
  } else {
    const actual = text.slice(overallHeading.start, samplesHeading.start).trimEnd();
    if (actual !== renderGeneratedStatistics(facts)) {
      issues.push(issue('GENERATED_STATISTICS_CHANGED', 'The deterministic statistics section differs from the supplied facts file; render it again instead of editing it manually.'));
    }
  }
  return issues;
}

const SAMPLE_FIELDS = ['Evidence ref', 'Source', 'Model', 'Session type', 'Total tokens', 'User turns'] as const;
const SAMPLE_LABELS = [
  'Tags', 'Context', 'Workflow and outcome', 'Why it is valuable', 'Data-governance note', 'Representative quote',
] as const;

function normalizedWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

const MANUAL_REDACTION = '[REDACTED]';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesCandidateExcerpt(candidateText: string, quoteText: string): boolean {
  const candidate = normalizedWhitespace(candidateText);
  const quote = normalizedWhitespace(quoteText);
  if (candidate === quote) return true;
  if (!quote.includes(MANUAL_REDACTION)) return false;

  const visibleText = quote.replaceAll(MANUAL_REDACTION, ' ');
  if ((visibleText.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 3) return false;

  const pattern = quote.split(MANUAL_REDACTION).map(escapeRegExp).join('.+?');
  return new RegExp(`^${pattern}$`, 'u').test(candidate);
}

function sourceDisplay(source: DataSource): string {
  return source === 'claude_code' ? 'Claude Code' : 'Codex';
}

function containsNonLatinLanguage(value: string): boolean {
  return Array.from(value).some((character) => /\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character));
}

function tableBlocks(lines: ScannedLine[]): ScannedLine[][] {
  const blocks: ScannedLine[][] = [];
  let active: ScannedLine[] = [];
  for (const line of lines) {
    if (!line.fenced && /^\|.*\|\s*$/.test(line.text)) active.push(line);
    else if (active.length > 0) {
      blocks.push(active);
      active = [];
    }
  }
  if (active.length > 0) blocks.push(active);
  return blocks;
}

function tableCells(line: string): string[] {
  return line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
}

function validateSampleCard(
  cardLines: ScannedLine[],
  candidateMap: Map<string, NonNullable<FactsReport['representativeCandidates']>[number]>,
  usedCandidates: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const heading = cardLines[0]!;
  const tables = tableBlocks(cardLines.slice(1));
  if (tables.length !== 1) {
    issues.push(issue('SAMPLE_METADATA_TABLE', 'Each sample card must contain exactly one metadata table.', heading.line));
    return issues;
  }
  const table = tables[0]!;
  const delimiter = table[1] ? tableCells(table[1].text) : [];
  if (table.length < 2 || JSON.stringify(tableCells(table[0]!.text)) !== JSON.stringify(['Field', 'Value'])
    || delimiter.length !== 2 || !delimiter.every((cell) => /^:?-{3,}:?$/.test(cell))) {
    issues.push(issue('SAMPLE_METADATA_TABLE', 'The sample metadata table must use the required Field and Value header.', table[0]?.line ?? heading.line));
    return issues;
  }
  const fields = new Map<string, string[]>();
  for (const row of table.slice(2)) {
    const cells = tableCells(row.text);
    if (cells.length !== 2) {
      issues.push(issue('SAMPLE_METADATA_TABLE', 'Sample metadata rows must contain exactly two columns.', row.line));
      continue;
    }
    const [field, value] = cells as [string, string];
    fields.set(field, [...(fields.get(field) ?? []), value]);
  }
  for (const field of SAMPLE_FIELDS) {
    if ((fields.get(field)?.length ?? 0) !== 1) {
      issues.push(issue('SAMPLE_METADATA_FIELD', `Sample metadata must contain ${field} exactly once.`, heading.line));
    }
  }
  for (const field of fields.keys()) {
    if (!SAMPLE_FIELDS.includes(field as typeof SAMPLE_FIELDS[number])) {
      issues.push(issue('SAMPLE_METADATA_FIELD', `Unsupported sample metadata field: ${field}.`, heading.line));
    }
  }
  if (issues.some((item) => item.code.startsWith('SAMPLE_METADATA'))) return issues;

  const evidenceRef = fields.get('Evidence ref')![0]!;
  const candidate = candidateMap.get(evidenceRef);
  if (!candidate) {
    issues.push(issue('SAMPLE_EVIDENCE_REF', 'Evidence ref does not exist in the supplied facts candidate pool.', heading.line));
    return issues;
  }
  if (usedCandidates.has(evidenceRef)) issues.push(issue('DUPLICATE_SAMPLE_EVIDENCE', 'A representative candidate can be used only once.', heading.line));
  usedCandidates.add(evidenceRef);
  const expected = new Map<string, string>([
    ['Source', sourceDisplay(candidate.source)],
    ['Model', candidate.models?.join(', ') ?? 'unavailable'],
    ['Session type', candidate.sessionType],
    ['Total tokens', candidate.totalTokens === undefined ? 'unavailable' : String(candidate.totalTokens)],
    ['User turns', String(candidate.userTurns)],
  ]);
  for (const [field, value] of expected) {
    if (fields.get(field)![0] !== value) issues.push(issue('SAMPLE_FACT_MISMATCH', `${field} does not match ${evidenceRef}.`, heading.line));
  }
  const otherRefs = [...cardLines.map((line) => line.text).join('\n').matchAll(/\bcandidate-\d{2}\b/g)]
    .map((match) => match[0]).filter((value) => value !== evidenceRef);
  if (otherRefs.length > 0) issues.push(issue('MIXED_SAMPLE_EVIDENCE', 'A sample card cannot refer to another candidate.', heading.line));

  for (const label of SAMPLE_LABELS) {
    const pattern = new RegExp(`^\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\*\\*(?:\\s+(.*))?$`);
    const matches = cardLines.filter((line) => !line.fenced && pattern.test(line.text));
    if (matches.length !== 1) issues.push(issue('SAMPLE_REQUIRED_CONTENT', `Sample card must contain ${label} exactly once.`, heading.line));
    else if (label !== 'Representative quote' && !normalizedWhitespace(pattern.exec(matches[0]!.text)?.[1] ?? '')) {
      issues.push(issue('SAMPLE_REQUIRED_CONTENT', `${label} cannot be empty.`, matches[0]!.line));
    }
  }
  const labelPositions = SAMPLE_LABELS.map((label) => cardLines.findIndex((line) => line.text.startsWith(`**${label}:**`)));
  if (labelPositions.some((position, index) => position < 0 || (index > 0 && position <= labelPositions[index - 1]!))) {
    issues.push(issue('SAMPLE_CONTENT_ORDER', 'Sample card content must follow the required label order.', heading.line));
  }
  const tagsLine = cardLines.find((line) => /^\*\*Tags:\*\*/.test(line.text));
  if (tagsLine) {
    const tags = tagsLine.text.replace(/^\*\*Tags:\*\*\s*/, '').split(',').map((tag) => tag.trim()).filter(Boolean);
    if (tags.length < 3 || tags.length > 6 || new Set(tags.map((tag) => tag.toLowerCase())).size !== tags.length) {
      issues.push(issue('SAMPLE_TAGS', 'Tags must contain 3–6 unique comma-separated values.', tagsLine.line));
    }
  }

  const quoteLabelIndex = cardLines.findIndex((line) => line.text === '**Representative quote:**');
  const quotes: Array<{ role: 'user' | 'assistant'; text: string; translated: boolean; line: number }> = [];
  if (quoteLabelIndex >= 0) {
    for (const line of cardLines.slice(quoteLabelIndex + 1)) {
      if (!/^>/.test(line.text)) {
        if (line.text.trim()) issues.push(issue('SAMPLE_QUOTE_FORMAT', 'Only quote lines may follow Representative quote.', line.line));
        continue;
      }
      const quote = line.text.replace(/^>\s?/, '').trim();
      if (!quote) continue;
      const parsed = /^(User|Assistant):\s+(.+)$/.exec(quote);
      if (!parsed) {
        issues.push(issue('SAMPLE_QUOTE_FORMAT', 'Quotes must begin with User: or Assistant:.', line.line));
        continue;
      }
      const role = parsed[1]!.toLowerCase() as 'user' | 'assistant';
      const translation = /\s+\((user|assistant), translated\)$/i.exec(parsed[2]!);
      if (translation && translation[1]!.toLowerCase() !== role) {
        issues.push(issue('SAMPLE_TRANSLATION_ROLE', 'The translation role marker must match the quoted role.', line.line));
      }
      quotes.push({
        role,
        text: normalizedWhitespace(translation ? parsed[2]!.slice(0, translation.index) : parsed[2]!),
        translated: Boolean(translation),
        line: line.line,
      });
    }
  }
  if (quotes.length === 0) {
    issues.push(issue('SAMPLE_QUOTE_REQUIRED', 'Each sample card needs at least one candidate-bound quote or English translation.', heading.line));
  }
  const originals = quotes.filter((quote) => !quote.translated);
  for (const quote of originals) {
    const matchingExcerpts = candidate.excerpts.filter((excerpt) =>
      excerpt.role === quote.role && matchesCandidateExcerpt(excerpt.text, quote.text));
    if (matchingExcerpts.length === 0) {
      issues.push(issue('SAMPLE_QUOTE_MISMATCH', 'Every original quote must exactly match a candidate excerpt except for sensitive spans replaced with [REDACTED].', quote.line));
    }
    if (containsNonLatinLanguage(quote.text)
      || matchingExcerpts.some((excerpt) => containsNonLatinLanguage(excerpt.text))) {
      issues.push(issue('NON_ENGLISH_ORIGINAL_NOT_ALLOWED', 'Do not include a non-English original in the report; include only its role-marked English translation.', quote.line));
    }
  }
  for (const quote of quotes.filter((item) => item.translated)) {
    if (!/[A-Za-z]/.test(quote.text) || containsNonLatinLanguage(quote.text)) {
      issues.push(issue('SAMPLE_TRANSLATION_ENGLISH', 'A translated quote must contain only an English translation, without the non-English original.', quote.line));
    }
    if (!candidate.excerpts.some((excerpt) =>
      excerpt.role === quote.role && containsNonLatinLanguage(excerpt.text))) {
      issues.push(issue('UNBOUND_SAMPLE_TRANSLATION', 'A translated quote must be bound by role to a non-English candidate excerpt.', quote.line));
    }
  }
  return issues;
}

function validateRepresentativeSamples(lines: ScannedLine[], facts: FactsReport | undefined): { count: number; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const section = headingPositions(lines, '## Representative Session Samples')[0];
  if (!section) {
    const quote = lines.find((line) => !line.fenced && /^\s{0,3}>/.test(line.text));
    if (quote) issues.push(issue('UNBOUND_BLOCK_QUOTE', 'Block quotes are allowed only as quotes inside a valid sample card.', quote.line));
    return { count: 0, issues };
  }
  const sectionStart = lines.findIndex((line) => line === section);
  const nextSectionOffset = lines.slice(sectionStart + 1).findIndex((line) => !line.fenced && /^##\s+/.test(line.text));
  const sectionEnd = nextSectionOffset < 0 ? lines.length : sectionStart + 1 + nextSectionOffset;
  const sampleSection = lines.slice(sectionStart + 1, sectionEnd);
  const unexpectedSubheading = sampleSection.find((line) => !line.fenced && /^###\s+/.test(line.text)
    && !/^###\s+(?:Example|Sample)\b/i.test(line.text));
  if (unexpectedSubheading) issues.push(issue('SAMPLE_HEADING', 'Only numbered example headings are allowed in the sample section.', unexpectedSubheading.line));
  const sampleHeadings = sampleSection.filter((line) => !line.fenced && /^###\s+(?:Example|Sample)\b/i.test(line.text));
  const outside = lines.filter((line, index) => (index <= sectionStart || index >= sectionEnd)
    && !line.fenced && /^###\s+(?:Example|Sample)\b/i.test(line.text));
  if (outside.length > 0) issues.push(issue('SAMPLE_OUTSIDE_SECTION', 'Sample cards are allowed only inside Representative Session Samples.', outside[0]!.line));
  if (sampleHeadings.length > 3) issues.push(issue('TOO_MANY_SAMPLES', 'A Data Summary can contain at most three representative samples.', sampleHeadings[3]!.line));
  if (sampleHeadings.length > 0 && !facts?.representativeCandidates) {
    issues.push(issue('SAMPLE_CANDIDATES_REQUIRED', 'Representative samples require a facts artifact containing the default candidate pool.', sampleHeadings[0]!.line));
  }
  const parsedHeadings = sampleHeadings.flatMap((line) => {
    const match = /^### Example (\d+)\.\s+(.+\S)\s*$/.exec(line.text);
    if (!match) {
      issues.push(issue('SAMPLE_HEADING', 'Sample headings must use “### Example N. Generalized title”.', line.line));
      return [];
    }
    return [{ line, number: Number(match[1]) }];
  });
  parsedHeadings.forEach((heading, index) => {
    if (heading.number !== index + 1) issues.push(issue('SAMPLE_NUMBERING', 'Sample numbering must start at 1 and remain consecutive.', heading.line.line));
  });
  const candidateMap = new Map((facts?.representativeCandidates ?? []).map((candidate) => [candidate.evidenceRef, candidate]));
  const usedCandidates = new Set<string>();
  const allowedQuoteLines = new Set<number>();
  for (const [index, heading] of parsedHeadings.entries()) {
    const start = sampleSection.findIndex((line) => line === heading.line);
    const next = parsedHeadings[index + 1];
    const end = next ? sampleSection.findIndex((line) => line === next.line) : sampleSection.length;
    const card = sampleSection.slice(start, end);
    const quoteLabelIndex = card.findIndex((line) => line.text === '**Representative quote:**');
    if (quoteLabelIndex >= 0) {
      for (const line of card.slice(quoteLabelIndex + 1)) {
        if (/^>/.test(line.text)) allowedQuoteLines.add(line.line);
      }
    }
    issues.push(...validateSampleCard(card, candidateMap, usedCandidates));
  }
  const unboundQuote = lines.find((line) => !line.fenced && /^\s{0,3}>/.test(line.text) && !allowedQuoteLines.has(line.line));
  if (unboundQuote) issues.push(issue('UNBOUND_BLOCK_QUOTE', 'Block quotes are allowed only as quotes inside a valid sample card.', unboundQuote.line));
  return { count: sampleHeadings.length, issues };
}

export function validateMarkdownBuffer(buffer: Buffer, facts?: FactsReport): MarkdownValidationResult {
  const issues: ValidationIssue[] = [];
  let text = '';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    issues.push(issue('INVALID_UTF8', 'The file must be valid UTF-8.'));
  }
  if (buffer.length > MAX_MARKDOWN_BYTES) issues.push(issue('FILE_TOO_LARGE', `The file exceeds ${MAX_MARKDOWN_BYTES} bytes.`));
  if (buffer.includes(0)) issues.push(issue('BINARY_CONTENT', 'The Markdown file cannot contain NUL bytes.'));
  const scanned = scanLines(text);

  const parsed = parseFrontMatter(text);
  issues.push(...parsed.issues);
  const formatVersion = typeof parsed.values.format_version === 'string' ? parsed.values.format_version : undefined;
  const sourceValues = Array.isArray(parsed.values.sources) ? parsed.values.sources.filter((value): value is string => typeof value === 'string') : [];
  const sources = sourceValues.filter((value): value is DataSource => ALLOWED_SOURCES.includes(value as DataSource));
  const generatedAt = typeof parsed.values.generated_at === 'string' ? parsed.values.generated_at : undefined;
  const privacyReviewed = parsed.values.privacy_reviewed === 'true';

  if (formatVersion !== FORMAT_VERSION) issues.push(issue('UNSUPPORTED_FORMAT_VERSION', `format_version must be ${FORMAT_VERSION}.`));
  if (sourceValues.length === 0) issues.push(issue('MISSING_SOURCES', 'sources must contain at least one supported source.'));
  for (const source of sourceValues) {
    if (!ALLOWED_SOURCES.includes(source as DataSource)) issues.push(issue('UNSUPPORTED_SOURCE', `Unsupported source: ${source}.`));
  }
  if (new Set(sourceValues).size !== sourceValues.length) issues.push(issue('DUPLICATE_SOURCE', 'sources must not contain duplicate values.'));
  if (!generatedAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(generatedAt) || Number.isNaN(Date.parse(generatedAt))) {
    issues.push(issue('INVALID_GENERATED_AT', 'generated_at must be a valid UTC ISO-8601 timestamp.'));
  }
  if (!privacyReviewed) {
    issues.push(issue('PRIVACY_REVIEW_REQUIRED', 'privacy_reviewed must be true after deterministic redaction and manual review.'));
  }

  issues.push(...validateDocumentStructure(scanned.lines, scanned.fenceLines));

  const sampleValidation = validateRepresentativeSamples(scanned.lines, facts);
  const sampleCount = sampleValidation.count;
  issues.push(...sampleValidation.issues);
  if (formatVersion === FORMAT_VERSION) {
    issues.push(...validateFactsBinding(text, scanned.lines, sources, privacyReviewed, facts));
  }
  if (/<\/?(?:script|iframe|object|embed|style|img|video|audio|form|svg|[a-z][a-z0-9-]*)(?:\s[^>]*)?>/i.test(text)) {
    issues.push(issue('HTML_NOT_ALLOWED', 'HTML and embedded active content are not allowed.'));
  }
  if (/!?\[[^\]\n]*\](?:\([^\n)]*\)|\[[^\]\n]*\])/i.test(text)
    || /^\s{0,3}\[[^\]\n]+\]:\s*\S+/im.test(text)
    || /<(?:https?|ftp|file|s3|mailto):[^>]+>/i.test(text)
    || /\b(?:https?|ftp|file|s3):\/\//i.test(text)
    || /(^|[\s(])\/\/[A-Za-z0-9]/m.test(text)) {
    issues.push(issue('LINK_NOT_ALLOWED', 'Links, images, and URI destinations are not allowed in a Data Summary.'));
  }
  if (/\b(?:attachment|cid):\s*\S+/i.test(text)) issues.push(issue('ATTACHMENT_NOT_ALLOWED', 'Attachments are not allowed in a Data Summary.'));
  issues.push(...sampleSensitiveContentIssues(text, scanned.lines));

  return {
    valid: issues.length === 0,
    sizeBytes: buffer.length,
    metadata: {
      ...(formatVersion ? { formatVersion } : {}),
      sources,
      ...(generatedAt ? { generatedAt } : {}),
      privacyReviewed,
      sampleCount,
    },
    issues,
  };
}

export async function validateMarkdownFile(filePath: string, facts?: FactsReport): Promise<MarkdownValidationResult> {
  return validateMarkdownBuffer(await readFile(filePath), facts);
}
