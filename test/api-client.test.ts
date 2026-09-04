import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { CookiyApiClient, CookiyApiError } from '../src/api/client.js';
import { contentHash } from '../src/core/content-hash.js';

const token = `cky_${'A'.repeat(50)}`;
const responseRecord = {
  id: '018f0000-0000-7000-8000-000000000001',
  sources: ['codex'],
  sizeBytes: 123,
  status: 'received',
  createdAt: '2026-09-04T00:00:00Z',
};

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('verifies tokens without leaking them into output data', async () => {
  await withServer((request, response) => {
    assert.equal(request.url, '/auth/cli-token/me');
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.setHeader('content-type', 'application/json');
    response.end('{"userId":"user-1"}');
  }, async (baseUrl) => {
    assert.deepEqual(await new CookiyApiClient({ baseUrl }).verifyToken(token), { userId: 'user-1' });
  });
});

test('uploads exactly one multipart Markdown file and returns only public fields', async () => {
  const markdown = Buffer.from('# summary');
  await withServer((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/data-summaries');
    assert.match(String(request.headers['content-type'] ?? ''), /^multipart\/form-data; boundary=/);
    assert.match(String(request.headers['idempotency-key'] ?? ''), /^[a-f0-9]{64}$/);
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      assert.equal((body.match(/Content-Disposition: form-data;/g) ?? []).length, 1);
      assert.match(body, /name="file"; filename="summary.md"/);
      assert.doesNotMatch(body, /name="(?:facts|topicReview|assignments|userEvidence)"/);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ...responseRecord, duplicate: false, objectKey: 'must-not-escape', contentHash: 'must-not-escape' }));
    });
  }, async (baseUrl) => {
    const result = await new CookiyApiClient({ baseUrl }).upload(markdown, token);
    assert.deepEqual(result, { ...responseRecord, duplicate: false });
    assert.ok(!JSON.stringify(result).includes('objectKey'));
  });
});

test('uses stable content idempotency: same content maps to the same ID and different content does not', async () => {
  const first = Buffer.from('# same content');
  const same = Buffer.from('# same content');
  const different = Buffer.from('# different content');
  const ids = new Map<string, string>();
  await withServer((request, response) => {
    const hash = String(request.headers['idempotency-key']);
    const id = ids.get(hash) ?? `id-${ids.size + 1}`;
    const duplicate = ids.has(hash);
    ids.set(hash, id);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ...responseRecord, id, duplicate }));
  }, async (baseUrl) => {
    const client = new CookiyApiClient({ baseUrl });
    const [a, b, c] = await Promise.all([client.upload(first, token), client.upload(same, token), client.upload(different, token)]);
    assert.equal(a.id, b.id);
    assert.notEqual(a.id, c.id);
    assert.equal(contentHash(first), contentHash(same));
  });
});

test('lists only public fields and retries a 5xx once', async () => {
  let calls = 0;
  await withServer((_request, response) => {
    calls += 1;
    if (calls === 1) {
      response.statusCode = 503;
      response.end('{"code":"OBJECT_STORAGE_UNAVAILABLE"}');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ items: [{ ...responseRecord, objectKey: 'hidden', contentHash: 'hidden' }] }));
  }, async (baseUrl) => {
    const result = await new CookiyApiClient({ baseUrl, retries: 1 }).list(token);
    assert.equal(calls, 2);
    assert.deepEqual(result.items, [responseRecord]);
  });
});

test('does not retry authentication errors and sanitizes reflected bodies', async () => {
  let calls = 0;
  await withServer((_request, response) => {
    calls += 1;
    response.statusCode = 401;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ code: 'INVALID_CLI_TOKEN', message: token }));
  }, async (baseUrl) => {
    await assert.rejects(
      () => new CookiyApiClient({ baseUrl, retries: 3 }).list(token),
      (error) => error instanceof CookiyApiError && error.status === 401 && error.code === 'INVALID_CLI_TOKEN'
        && /save.*login token again.*auth save.*HTTP 401/.test(error.message) && !error.message.includes(token),
    );
    assert.equal(calls, 1);
  });
});

test('gives retry guidance after exhausting service retries without exposing response content', async () => {
  let calls = 0;
  const client = new CookiyApiClient({
    retries: 1,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: 'OBJECT_STORAGE_UNAVAILABLE', message: token }), { status: 503 });
    },
  });
  await assert.rejects(() => client.list(token), (error) => {
    assert.ok(error instanceof CookiyApiError);
    assert.equal(error.status, 503);
    assert.equal(error.code, 'OBJECT_STORAGE_UNAVAILABLE');
    assert.equal(error.retryable, true);
    assert.match(error.message, /temporarily unavailable.*try again later.*HTTP 503; OBJECT_STORAGE_UNAVAILABLE/);
    assert.ok(!error.message.includes(token));
    return true;
  });
  assert.equal(calls, 2);
});

for (const [status, code] of [[413, 'FILE_TOO_LARGE'], [422, 'INVALID_MARKDOWN']] as const) {
  test(`does not retry ${status} ${code}`, async () => {
    let calls = 0;
    await withServer((_request, response) => {
      calls += 1;
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ code }));
    }, async (baseUrl) => {
      await assert.rejects(
        () => new CookiyApiClient({ baseUrl, retries: 3 }).list(token),
        (error) => error instanceof CookiyApiError && error.status === status && error.code === code && !error.retryable,
      );
      assert.equal(calls, 1);
    });
  });
}

test('reports timeouts as retryable errors', async () => {
  await withServer((_request, _response) => undefined, async (baseUrl) => {
    await assert.rejects(
      () => new CookiyApiClient({ baseUrl, timeoutMs: 10, retries: 0 }).list(token),
      (error) => error instanceof CookiyApiError && error.code === 'TIMEOUT' && error.retryable,
    );
  });
});

test('rejects unsafe API destinations and accepts bracketed IPv6 loopback', () => {
  assert.throws(() => new CookiyApiClient({ baseUrl: 'ftp://localhost/api' }), /HTTP or HTTPS/);
  assert.throws(() => new CookiyApiClient({ baseUrl: 'https://user:pass@cash-panel-api.cookiy.ai/api' }), /cannot contain credentials/);
  assert.throws(() => new CookiyApiClient({ baseUrl: 'https://example.com/api' }), /production service or a loopback/);
  assert.doesNotThrow(() => new CookiyApiClient({ baseUrl: 'http://[::1]:8080/api' }));
});

test('fails closed on malformed list containers', async () => {
  await withServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"unexpected":true}');
  }, async (baseUrl) => {
    await assert.rejects(
      () => new CookiyApiClient({ baseUrl }).list(token),
      (error) => error instanceof CookiyApiError && error.code === 'INVALID_RESPONSE',
    );
  });
});

test('fails closed on malformed public submission records', async () => {
  await withServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"items":[{"id":"one","sources":["unexpected"],"sizeBytes":-1,"status":"received","createdAt":"not-a-date"}]}');
  }, async (baseUrl) => {
    await assert.rejects(
      () => new CookiyApiClient({ baseUrl }).list(token),
      (error) => error instanceof CookiyApiError && error.code === 'INVALID_RESPONSE',
    );
  });
});
