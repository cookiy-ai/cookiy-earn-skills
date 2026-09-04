import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectSensitiveContent, redactText } from '../src/core/redaction.js';

test('redacts secrets, PII, paths, session IDs, and sensitive URL parameters', () => {
  const input = [
    `Authorization: Bearer ${'a'.repeat(24)}`,
    `CLI cky_${'A'.repeat(50)}`,
    'AWS AKIAABCDEFGHIJKLMNOP',
    'email alice@example.com phone +1 (415) 555-1212',
    'path /Users/alice/My Project/file.ts and C:\\Users\\bob\\repo',
    'sessionId=abcdef1234567890',
    'PASSWORD=hunter2',
    'secret="two words here"',
    'https://example.com/callback?token=secret-value&safe=yes',
    'temp /private/tmp/raw-session.jsonl',
    'id 018f0000-0000-7000-8000-000000000001',
    'public hosts 8.8.8.8 and 2001:4860:4860:0:0:0:0:8888',
    'private host 192.168.1.2',
  ].join('\n');
  assert.ok(detectSensitiveContent(input).length >= 8);
  const result = redactText(input);
  assert.equal(detectSensitiveContent(result.text).length, 0);
  assert.ok(!result.text.includes('alice@example.com'));
  assert.ok(!result.text.includes('hunter2'));
  assert.ok(!result.text.includes('two words here'));
  assert.ok(!result.text.includes('/private/tmp'));
  assert.ok(!result.text.includes('8.8.8.8'));
  assert.ok(!result.text.includes('2001:4860'));
  assert.ok(!result.text.includes('192.168.1.2'));
  assert.match(result.text, /token=%5BREDACTED%5D/);
});

test('redacts private key blocks without exposing their content in issues', () => {
  const input = '-----BEGIN PRIVATE KEY-----\nsecret-body\n-----END PRIVATE KEY-----';
  const issues = detectSensitiveContent(input);
  assert.equal(issues[0]?.code, 'PRIVATE_KEY');
  assert.ok(!JSON.stringify(issues).includes('secret-body'));
  assert.equal(redactText(input).text, '[REDACTED_PRIVATE_KEY]');
});

test('covers common structured credentials, compressed IPv6, and cross-platform paths without treating dates as phones', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signaturevalue';
  const input = [
    '{"password":"hunter2","api_key":"generic-secret"}',
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    `token ${jwt}`,
    'DATABASE_URL=postgres://user:pass@localhost/app',
    'hosts ::1 and fe80::1',
    'files /etc/hosts and /usr/local/private.txt',
    'windows C:\\Users\\Jane Doe\\secret.txt',
    'date 2026-09-04',
  ].join('\n');
  const issues = detectSensitiveContent(input);
  for (const code of ['SECRET_ASSIGNMENT', 'BASIC_AUTH', 'JWT', 'CREDENTIAL_URI', 'IPV6', 'ABSOLUTE_LOCAL_PATH', 'WINDOWS_HOME_PATH']) {
    assert.ok(issues.some((item) => item.code === code), code);
  }
  assert.ok(!issues.some((item) => item.code === 'PHONE'));

  const result = redactText(input);
  assert.equal(detectSensitiveContent(result.text).length, 0);
  assert.ok(result.text.includes('2026-09-04'));
  assert.ok(!result.text.includes('hunter2'));
  assert.ok(!result.text.includes('generic-secret'));
  assert.ok(!result.text.includes('Jane Doe'));
});
