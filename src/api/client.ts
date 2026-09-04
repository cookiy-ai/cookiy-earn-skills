import { contentHash } from '../core/content-hash.js';
import type { CookiyIdentity, DataSummaryRecord, ListDataSummariesResponse } from './types.js';

export const PRODUCTION_API_URL = 'https://cash-panel-api.cookiy.ai/api';

export class CookiyApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'CookiyApiError';
  }
}

export interface ClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
}

function cleanBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Cookiy API URLs cannot contain credentials, a query, or a fragment.');
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Cookiy API URLs must use HTTP or HTTPS.');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  const cleaned = parsed.toString().replace(/\/$/, '');
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (!loopback && cleaned !== PRODUCTION_API_URL) {
    throw new Error('Cookiy API URLs must target the production service or a loopback test server.');
  }
  return cleaned;
}

function record(value: unknown, includeDuplicate = false): DataSummaryRecord {
  const input = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (typeof input.id !== 'string' || input.id.length === 0
    || !Array.isArray(input.sources) || input.sources.length === 0
    || input.sources.some((source) => source !== 'codex' && source !== 'claude_code')
    || typeof input.sizeBytes !== 'number' || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0
    || typeof input.status !== 'string' || input.status.length === 0
    || typeof input.createdAt !== 'string' || Number.isNaN(Date.parse(input.createdAt))) {
    throw new CookiyApiError('Cookiy returned an invalid response.', undefined, 'INVALID_RESPONSE');
  }
  const sources = input.sources as Array<'codex' | 'claude_code'>;
  return {
    id: input.id,
    sources,
    sizeBytes: input.sizeBytes,
    status: input.status,
    createdAt: input.createdAt,
    ...(includeDuplicate && typeof input.duplicate === 'boolean' ? { duplicate: input.duplicate } : {}),
  };
}

async function responseError(response: Response): Promise<CookiyApiError> {
  let code: string | undefined;
  try {
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(body.code)) code = body.code;
  } catch {
    // Never echo an arbitrary server response because it could reflect a credential or content.
  }
  const retryable = response.status >= 500;
  let guidance: string;
  if (response.status === 401) {
    guidance = 'Please save your Cookiy login token again by running `node <skill-directory>/scripts/cookiy-earn.js auth save`.';
  } else if (response.status === 403) {
    guidance = 'Access denied. Check that your Cookiy account has permission, or contact Cookiy support.';
  } else if (retryable) {
    guidance = 'Cookiy is temporarily unavailable. Please try again later.';
  } else if (response.status === 429) {
    guidance = 'Too many requests to Cookiy. Please wait and try again later.';
  } else if (response.status === 413) {
    guidance = 'The summary is too large. Shorten it, validate it, and review and approve the updated file before uploading again.';
  } else if (response.status === 422) {
    guidance = 'Cookiy could not accept this summary. Run `validate` with its local facts file and fix any issues, then review and approve the updated file before uploading again.';
  } else {
    guidance = 'Cookiy could not complete the request. Check the command and its inputs; if the problem persists, contact Cookiy support.';
  }
  return new CookiyApiError(`${guidance} (HTTP ${response.status}${code ? `; ${code}` : ''})`, response.status, code, retryable);
}

export class CookiyApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = cleanBaseUrl(options.baseUrl ?? process.env.COOKIY_API_URL ?? PRODUCTION_API_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retries = options.retries ?? 2;
  }

  private async request(path: string, init: RequestInit, retry = false): Promise<Response> {
    const attempts = retry ? this.retries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
        if (response.ok) return response;
        const error = await responseError(response);
        if (!error.retryable || attempt === attempts - 1) throw error;
      } catch (error) {
        if (error instanceof CookiyApiError && (!error.retryable || attempt === attempts - 1)) throw error;
        if (attempt === attempts - 1) {
          throw new CookiyApiError(
            error instanceof DOMException && error.name === 'TimeoutError'
              ? 'Cookiy took too long to respond. Please try again later. (TIMEOUT)'
              : 'Could not reach Cookiy. Check your internet connection and try again. (NETWORK_ERROR)',
            undefined,
            error instanceof DOMException && error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR',
            true,
          );
        }
      }
    }
    throw new CookiyApiError('Could not reach Cookiy. Check your internet connection and try again. (NETWORK_ERROR)', undefined, 'NETWORK_ERROR', true);
  }

  async verifyToken(token: string): Promise<CookiyIdentity> {
    const response = await this.request('/auth/cli-token/me', { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json() as unknown;
    return body !== null && typeof body === 'object' ? body as CookiyIdentity : {};
  }

  async upload(markdown: Uint8Array, token: string): Promise<DataSummaryRecord> {
    const form = new FormData();
    const blobBytes = Uint8Array.from(markdown);
    form.append('file', new Blob([blobBytes.buffer], { type: 'text/markdown; charset=utf-8' }), 'summary.md');
    const response = await this.request('/data-summaries', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': contentHash(markdown),
      },
      body: form,
    }, true);
    return record(await response.json(), true);
  }

  async list(token: string): Promise<ListDataSummariesResponse> {
    const response = await this.request('/data-summaries', { headers: { Authorization: `Bearer ${token}` } }, true);
    const body = await response.json() as unknown;
    const container = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
    const rawItems = Array.isArray(body) ? body : Array.isArray(container?.items) ? container.items : Array.isArray(container?.data) ? container.data : undefined;
    if (!rawItems) throw new CookiyApiError('Cookiy returned an invalid response.', undefined, 'INVALID_RESPONSE');
    return {
      items: rawItems.map((item) => record(item)),
      ...(typeof container?.nextCursor === 'string' ? { nextCursor: container.nextCursor } : {}),
    };
  }
}
