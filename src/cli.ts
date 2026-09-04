#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import process from 'node:process';
import { CookiyApiClient, CookiyApiError } from './api/client.js';
import { contentHash } from './core/content-hash.js';
import { readFactsFile, renderDataSummary } from './core/data-summary.js';
import { redactRepresentativeSamples, validateMarkdownBuffer, validateMarkdownFile } from './core/markdown-contract.js';
import { computeFacts, computeFactsWithTopicReview, type SourceInput } from './core/statistics.js';
import { applyTopicReview, readTopicReviewFile } from './core/topics.js';
import { deleteToken, readToken, saveTokenAtomic, validateTokenShape } from './platform/credentials.js';
import { credentialFilePath } from './platform/paths.js';
import { writePrivateFileAtomic } from './platform/private-file.js';

const HELP = `cookiy-earn — build and submit a redacted Coding Session Data Summary

Local-only commands (no Cookiy login or network access):
  cookiy-earn facts --source codex=<path> [--source claude_code=<path>] --output <facts.json>
  cookiy-earn render <facts.json> --output <draft.md>
  cookiy-earn redact <input.md> --output <redacted.md>
  cookiy-earn validate <summary.md> [--facts <facts.json>] [--json]
  cookiy-earn inspect <summary.md> [--facts <facts.json>] [--json]

Credential and API commands:
  cookiy-earn auth save                 Read a CLI token from hidden input or stdin, verify, then save it
  cookiy-earn auth logout               Delete only the saved Cookiy Earn credential
  cookiy-earn upload <summary.md> [--facts <facts.json>] --confirm-upload <full-sha256>
  cookiy-earn list [--json]

Upload always requires the full SHA-256 shown by inspect for that invocation. Generating or validating a file never uploads it.`;

export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
}

function ioWrite(stream: NodeJS.WritableStream, value: string): void {
  stream.write(`${value}\n`);
}

function optionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === name && args[index + 1]) values.push(args[index + 1]!);
    else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
  }
  return values;
}

function optionValue(args: string[], name: string): string | undefined {
  return optionValues(args, name).at(-1);
}

function positional(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--json') continue;
    if (arg === '--source' || arg === '--output' || arg === '--facts' || arg === '--confirm-upload' || arg === '--topic-review-output') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--source=') || arg.startsWith('--output=') || arg.startsWith('--facts=')
      || arg.startsWith('--confirm-upload=') || arg.startsWith('--topic-review-output=')) continue;
    if (!arg.startsWith('-')) result.push(arg);
  }
  return result;
}

function parseSources(args: string[]): SourceInput[] {
  return optionValues(args, '--source').map((value) => {
    const equals = value.indexOf('=');
    const source = value.slice(0, equals);
    const path = value.slice(equals + 1);
    if (equals < 1 || !path || (source !== 'codex' && source !== 'claude_code')) {
      throw new Error('--source must use codex=<path> or claude_code=<path>.');
    }
    return { source, path };
  });
}

function rejectUnknownFactsOptions(args: string[]): void {
  const valueOptions = ['--source', '--output', '--topic-review-output'];
  const booleanOptions = ['--no-topic-review'];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (valueOptions.includes(arg)) {
      index += 1;
      continue;
    }
    if (valueOptions.some((option) => arg.startsWith(`${option}=`))) continue;
    if (booleanOptions.includes(arg)) continue;
    if (arg.startsWith('-')) throw new Error(`Unknown facts option: ${arg}`);
  }
}

async function readTokenFromInput(io: CliIo): Promise<string> {
  if (!process.stdin.isTTY || io.stdin !== process.stdin) {
    let value = '';
    for await (const chunk of io.stdin) value += String(chunk);
    return value.trim();
  }
  const input = process.stdin;
  io.stderr.write('Cookiy CLI token (input hidden): ');
  input.setRawMode?.(true);
  input.resume();
  input.setEncoding('utf8');
  return await new Promise<string>((resolveInput, reject) => {
    let value = '';
    const restore = () => {
      input.setRawMode?.(false);
      input.pause();
      input.removeListener('data', onData);
    };
    const onData = (chunk: string) => {
      if (chunk === '\u0003') {
        restore();
        io.stderr.write('\n');
        reject(new Error('Credential input cancelled.'));
      } else if (chunk === '\r' || chunk === '\n') {
        restore();
        io.stderr.write('\n');
        resolveInput(value.trim());
      } else if (chunk === '\u007f') {
        value = value.slice(0, -1);
      } else {
        value += chunk;
      }
    };
    input.on('data', onData);
  });
}

async function inspect(filePath: string, factsPath?: string): Promise<Record<string, unknown>> {
  const absolute = resolve(filePath);
  const content = await readFile(absolute);
  const facts = factsPath ? await readFactsFile(resolve(factsPath)) : undefined;
  const validation = validateMarkdownBuffer(content, facts);
  return {
    path: absolute,
    sizeBytes: content.length,
    sha256: contentHash(content),
    sources: validation.metadata.sources,
    sampleCount: validation.metadata.sampleCount,
    valid: validation.valid,
    issueCount: validation.issues.length,
    ...(facts ? {
      overall: {
        sessions: facts.overall.sessionCount,
        userTurns: facts.overall.turnCount,
        toolCalls: facts.overall.toolCallCount,
        totalTokens: facts.overall.totalTokens ?? 'unavailable',
      },
    } : {}),
  };
}

function formatRecord(item: { id: string; sources: string[]; sizeBytes: number; status: string; createdAt: string }): string {
  const status = item.status === 'received' ? 'under review' : item.status;
  return `${item.id}\t${item.sources.join('+')}\t${item.sizeBytes} bytes\t${status}\t${item.createdAt}`;
}

export async function runCli(args = process.argv.slice(2), io: CliIo = process): Promise<number> {
  const [command, subcommand] = args;
  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      ioWrite(io.stdout, HELP);
      return 0;
    }

    if (command === 'facts') {
      rejectUnknownFactsOptions(args);
      const output = optionValue(args, '--output');
      if (!output) throw new Error('facts requires --output <facts.json>; raw session-derived content is never printed to stdout.');
      const noTopicReview = args.includes('--no-topic-review');
      const requestedReviewOutput = optionValue(args, '--topic-review-output');
      if (noTopicReview && requestedReviewOutput) {
        throw new Error('--no-topic-review cannot be combined with --topic-review-output.');
      }
      const absoluteOutput = resolve(output);
      // Retain explicit internal access while Topic review is hidden from the public workflow.
      const absoluteReviewOutput = requestedReviewOutput ? resolve(requestedReviewOutput) : undefined;
      if (absoluteReviewOutput && absoluteReviewOutput === absoluteOutput) {
        throw new Error('--output and --topic-review-output must use different files.');
      }
      ioWrite(io.stderr, 'Privacy notice: only the summary you have reviewed and approved will be uploaded; source sessions, unselected excerpts, and other local analysis files stay on your device.');
      if (absoluteReviewOutput) {
        ioWrite(io.stderr, 'Topic notice: the current Agent must review bounded, redacted user-message evidence for every Session; evidence and per-Session assignments remain local, and only aggregate Topic counts and shares may be uploaded.');
      }
      const result = !absoluteReviewOutput
        ? { facts: await computeFacts(parseSources(args)), topicReview: undefined }
        : await computeFactsWithTopicReview(parseSources(args));
      await Promise.all([
        writePrivateFileAtomic(absoluteOutput, `${JSON.stringify(result.facts, null, 2)}\n`),
        ...(absoluteReviewOutput && result.topicReview
          ? [writePrivateFileAtomic(absoluteReviewOutput, `${JSON.stringify(result.topicReview, null, 2)}\n`)]
          : []),
      ]);
      const facts = result.facts;
      ioWrite(io.stdout, `Wrote local facts: ${resolve(output)}`);
      if (absoluteReviewOutput) ioWrite(io.stdout, `Wrote private Topic review: ${absoluteReviewOutput}`);
      ioWrite(io.stdout, `Private representative candidates: ${facts.representativeCandidates?.length ?? 0} (maximum 8)`);
      ioWrite(io.stdout, `Sources: ${Object.keys(facts.bySource).join(', ')}; sessions: ${facts.overall.sessionCount}; files: ${facts.overall.fileCount}`);
      return 0;
    }

    if (command === 'topics' && subcommand === 'apply') {
      const [factsPath, topicReviewPath] = positional(args.slice(2));
      const output = optionValue(args, '--output');
      if (!factsPath || !topicReviewPath || !output) {
        throw new Error('topics apply requires <base-facts.json> <topic-review.json> --output <classified-facts.json>.');
      }
      const [facts, topicReview] = await Promise.all([
        readFactsFile(resolve(factsPath)),
        readTopicReviewFile(resolve(topicReviewPath)),
      ]);
      const classified = applyTopicReview(facts, topicReview);
      await writePrivateFileAtomic(resolve(output), `${JSON.stringify(classified, null, 2)}\n`);
      ioWrite(io.stdout, `Wrote local classified facts: ${resolve(output)}`);
      ioWrite(io.stdout, `Method: ${classified.topicClassification!.method}; reviewed Sessions: ${classified.topicClassification!.reviewedSessionCount}`);
      return 0;
    }

    if (command === 'render') {
      const [factsPath] = positional(args.slice(1));
      const output = optionValue(args, '--output');
      if (!factsPath || !output) throw new Error('render requires <facts.json> --output <draft.md>.');
      const facts = await readFactsFile(resolve(factsPath));
      if (facts.topicReview && !facts.topicClassification) {
        throw new Error('The explicitly requested Topic review has not been applied. Classify every Session and run topics apply, or regenerate facts with --no-topic-review.');
      }
      await writePrivateFileAtomic(resolve(output), renderDataSummary(facts));
      ioWrite(io.stdout, `Wrote local Data Summary draft: ${resolve(output)}`);
      ioWrite(io.stdout, 'Redact and manually review this draft before validation or upload.');
      return 0;
    }

    if (command === 'redact') {
      const [input] = positional(args.slice(1));
      const output = optionValue(args, '--output');
      if (!input || !output) throw new Error('redact requires <input.md> --output <redacted.md>.');
      const source = await readFile(resolve(input), 'utf8');
      const result = redactRepresentativeSamples(source);
      await writePrivateFileAtomic(resolve(output), result.text);
      ioWrite(io.stdout, `Wrote redacted Markdown: ${resolve(output)}`);
      ioWrite(io.stdout, `Redactions: ${Object.values(result.redactions).reduce((sum, count) => sum + count, 0)}`);
      return 0;
    }

    if (command === 'validate') {
      const [file] = positional(args.slice(1));
      if (!file) throw new Error('validate requires <summary.md>.');
      const factsPath = optionValue(args, '--facts');
      const facts = factsPath ? await readFactsFile(resolve(factsPath)) : undefined;
      const result = await validateMarkdownFile(resolve(file), facts);
      if (args.includes('--json')) ioWrite(io.stdout, JSON.stringify(result, null, 2));
      else {
        ioWrite(io.stdout, result.valid ? `Valid Data Summary (${result.sizeBytes} bytes).` : `Invalid Data Summary: ${result.issues.length} issue(s).`);
        for (const item of result.issues) ioWrite(io.stdout, `${item.code} at ${item.line}:${item.column} — ${item.message}`);
      }
      return result.valid ? 0 : 2;
    }

    if (command === 'inspect') {
      const [file] = positional(args.slice(1));
      if (!file) throw new Error('inspect requires <summary.md>.');
      const result = await inspect(file, optionValue(args, '--facts'));
      if (args.includes('--json')) ioWrite(io.stdout, JSON.stringify(result, null, 2));
      else Object.entries(result).forEach(([key, value]) => ioWrite(io.stdout, `${key}: ${Array.isArray(value)
        ? value.join(', ')
        : value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)}`));
      return result.valid ? 0 : 2;
    }

    if (command === 'auth' && subcommand === 'save') {
      const token = await readTokenFromInput(io);
      if (!validateTokenShape(token)) throw new Error('Cookiy CLI tokens must be exactly 54 characters and start with cky_.');
      await new CookiyApiClient().verifyToken(token);
      const savedAt = await saveTokenAtomic(token);
      ioWrite(io.stdout, `Credential verified and saved to ${savedAt}`);
      if (process.platform === 'win32') ioWrite(io.stdout, 'The plaintext file relies on your Windows user-profile ACL; it is not stored in Windows Credential Manager.');
      return 0;
    }

    if (command === 'auth' && subcommand === 'logout') {
      const deleted = await deleteToken();
      ioWrite(io.stdout, deleted ? `Deleted credential file: ${credentialFilePath()}` : 'No saved Cookiy Earn credential was found.');
      return 0;
    }

    if (command === 'upload') {
      const [file] = positional(args.slice(1));
      if (!file) throw new Error('upload requires <summary.md>.');
      const approvedHash = optionValue(args, '--confirm-upload');
      if (!approvedHash || !/^[a-f0-9]{64}$/.test(approvedHash)) throw new Error('Upload blocked: --confirm-upload requires the full SHA-256 shown by inspect.');
      const markdown = await readFile(resolve(file));
      if (contentHash(markdown) !== approvedHash) throw new Error('Upload blocked: the file has changed since consent was obtained. Inspect it and ask again.');
      const factsPath = optionValue(args, '--facts');
      const facts = factsPath ? await readFactsFile(resolve(factsPath)) : undefined;
      const validation = validateMarkdownBuffer(markdown, facts);
      if (!validation.valid) throw new Error(`Upload blocked: Markdown validation found ${validation.issues.length} issue(s).`);
      const token = await readToken();
      const result = await new CookiyApiClient().upload(markdown, token);
      ioWrite(io.stdout, JSON.stringify(result, null, 2));
      return 0;
    }

    if (command === 'list') {
      const token = await readToken();
      const result = await new CookiyApiClient().list(token);
      if (result.nextCursor) ioWrite(io.stderr, 'More submissions exist; this V1 command displays only the first page.');
      if (args.includes('--json')) ioWrite(io.stdout, JSON.stringify(result, null, 2));
      else if (result.items.length === 0) ioWrite(io.stdout, 'No Data Summary submissions found.');
      else result.items.forEach((item) => ioWrite(io.stdout, formatRecord(item)));
      return 0;
    }

    throw new Error(`Unknown command.\n\n${HELP}`);
  } catch (error) {
    const safeMessage = error instanceof CookiyApiError || error instanceof Error ? error.message : 'Unexpected error.';
    ioWrite(io.stderr, `Error: ${safeMessage}`);
    return 1;
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'cookiy-earn.js') process.exitCode = await runCli();
