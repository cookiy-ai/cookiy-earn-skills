import { isIP } from 'node:net';

export type RedactionSeverity = 'error' | 'warning';

export interface RedactionIssue {
  code: string;
  severity: RedactionSeverity;
  line: number;
  column: number;
  message: string;
}

interface Rule {
  code: string;
  message: string;
  pattern: RegExp;
  replacement: string | ((substring: string, ...args: string[]) => string);
}

const RULES: Rule[] = [
  {
    code: 'PRIVATE_KEY',
    message: 'Private key material is not allowed.',
    pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    code: 'CLI_TOKEN',
    message: 'A Cookiy CLI token is not allowed.',
    pattern: /\bcky_[A-Za-z0-9_-]{50}\b/g,
    replacement: '[REDACTED_CLI_TOKEN]',
  },
  {
    code: 'BEARER_TOKEN',
    message: 'A bearer credential is not allowed.',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
    replacement: 'Bearer [REDACTED_TOKEN]',
  },
  {
    code: 'BASIC_AUTH',
    message: 'A Basic Authorization credential is not allowed.',
    pattern: /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi,
    replacement: 'Basic [REDACTED_TOKEN]',
  },
  {
    code: 'JWT',
    message: 'A JSON Web Token is not allowed.',
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    replacement: '[REDACTED_JWT]',
  },
  {
    code: 'CLOUD_CREDENTIAL',
    message: 'A cloud credential is not allowed.',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: '[REDACTED_CLOUD_CREDENTIAL]',
  },
  {
    code: 'API_KEY',
    message: 'An API key is not allowed.',
    pattern: /\b(?:sk-(?:(?:proj|ant)-)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|npm_[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{16,})\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    code: 'COOKIE',
    message: 'Cookie values are not allowed.',
    pattern: /\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+/gi,
    replacement: 'Cookie: [REDACTED]',
  },
  {
    code: 'SECRET_ASSIGNMENT',
    message: 'A password, token, secret, or environment value is not allowed.',
    pattern: /(["'])(password|passwd|api[_-]?key|secret|access[_-]?token)\1\s*:\s*(["'])(?!\[REDACTED\])[^\r\n]*?\3/gi,
    replacement: (_match, keyQuote, name, valueQuote) => `${keyQuote}${name}${keyQuote}:${valueQuote}[REDACTED]${valueQuote}`,
  },
  {
    code: 'SECRET_ASSIGNMENT',
    message: 'A password, token, secret, or environment value is not allowed.',
    pattern: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE)|password|passwd|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*(["'])(?!\[REDACTED\])[^\r\n]*?\2/gi,
    replacement: (_match, name) => `${name}=[REDACTED]`,
  },
  {
    code: 'SECRET_ASSIGNMENT',
    message: 'A password, token, secret, or environment value is not allowed.',
    pattern: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE)|password|passwd|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*(["']?)(?!\[REDACTED\])[^\s,"'`;]+\2/gi,
    replacement: (_match, name) => `${name}=[REDACTED]`,
  },
  {
    code: 'CREDENTIAL_URI',
    message: 'Credentials embedded in a URI are not allowed.',
    pattern: /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s/@:]+:[^\s/@]+@[^\s)\]}>]+/gi,
    replacement: '[REDACTED_CREDENTIAL_URI]',
  },
  {
    code: 'EMAIL',
    message: 'Email addresses must be removed.',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: '[REDACTED_EMAIL]',
  },
  {
    code: 'IPV4',
    message: 'IPv4 addresses must be removed.',
    pattern: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g,
    replacement: '[REDACTED_IP]',
  },
  {
    code: 'HOME_PATH',
    message: 'User home directories and usernames must be masked.',
    pattern: /(?:\/[Uu]sers|\/home)\/[^/\s`"']+(?=\/|\b)/g,
    replacement: '[HOME]',
  },
  {
    code: 'WINDOWS_HOME_PATH',
    message: 'Windows user home directories and usernames must be masked.',
    pattern: /\b[A-Za-z]:\\Users\\[^\r\n`"'<>|]+/gi,
    replacement: '[HOME]',
  },
  {
    code: 'ABSOLUTE_LOCAL_PATH',
    message: 'Original absolute local paths must be masked.',
    pattern: /(?<![A-Za-z0-9])(?:\/(?:private|tmp|var|opt|workspace|mnt|Volumes|srv|root|etc|usr)\/[^\s`"']+|[A-Za-z]:\\(?!Users\\)[^\r\n`"'<>|]+)/g,
    replacement: '[LOCAL_PATH]',
  },
  {
    code: 'SESSION_ID',
    message: 'Raw local session identifiers must be removed.',
    pattern: /\b((?:session(?:_?id)?|conversation(?:_?id)?)\s*[:=]\s*)[A-Za-z0-9_-]{8,}/gi,
    replacement: (_match, prefix) => `${prefix}[REDACTED_SESSION_ID]`,
  },
  {
    code: 'RAW_UUID',
    message: 'Raw identifiers must be pseudonymized.',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    replacement: '[REDACTED_ID]',
  },
];

const SENSITIVE_QUERY = /^(?:access_?token|api_?key|auth|authorization|code|credential|key|password|secret|signature|sig|token)$/i;
const IPV6_CANDIDATE = /(?<![A-Za-z0-9:])(?:[A-Fa-f0-9]{0,4}:){2,7}[A-Fa-f0-9]{0,4}(?![A-Za-z0-9:])/g;
const PHONE_CANDIDATE = /(?<![\w])(?:\+?\d[\d ().-]{6,}\d)(?![\w])/g;

function validPhoneCandidate(value: string): boolean {
  return (value.match(/\d/g)?.length ?? 0) >= 10 && !/^\d{4}-\d{2}-\d{2}$/.test(value);
}

function locationAt(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  const lines = before.split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

export function detectSensitiveContent(text: string): RedactionIssue[] {
  const issues: RedactionIssue[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const location = locationAt(text, match.index ?? 0);
      issues.push({ code: rule.code, severity: 'error', ...location, message: rule.message });
    }
  }

  for (const match of text.matchAll(IPV6_CANDIDATE)) {
    if (isIP(match[0]) !== 6) continue;
    const location = locationAt(text, match.index ?? 0);
    issues.push({ code: 'IPV6', severity: 'error', ...location, message: 'IPv6 addresses must be removed.' });
  }
  for (const match of text.matchAll(PHONE_CANDIDATE)) {
    if (!validPhoneCandidate(match[0])) continue;
    const location = locationAt(text, match.index ?? 0);
    issues.push({ code: 'PHONE', severity: 'error', ...location, message: 'Phone numbers must be removed.' });
  }

  const urlPattern = /(?:https?|ftp|s3):\/\/[^\s<>"')\]]+/gi;
  for (const match of text.matchAll(urlPattern)) {
    try {
      const url = new URL(match[0]);
      if ([...url.searchParams.entries()].some(([key, value]) => SENSITIVE_QUERY.test(key) && value !== '[REDACTED]')) {
        const location = locationAt(text, match.index ?? 0);
        issues.push({
          code: 'SENSITIVE_URL_QUERY',
          severity: 'error',
          ...location,
          message: 'A URL contains a sensitive query parameter.',
        });
      }
    } catch {
      // Malformed URLs are handled by Markdown validation when relevant.
    }
  }
  return issues.sort((a, b) => a.line - b.line || a.column - b.column || a.code.localeCompare(b.code));
}

function redactSensitiveUrls(text: string): string {
  return text.replace(/(?:https?|ftp|s3):\/\/[^\s<>"')\]]+/gi, (value) => {
    try {
      const url = new URL(value);
      let changed = false;
      for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_QUERY.test(key)) {
          url.searchParams.set(key, '[REDACTED]');
          changed = true;
        }
      }
      return changed ? url.toString() : value;
    } catch {
      return value;
    }
  });
}

export function redactText(text: string): { text: string; redactions: Record<string, number> } {
  let output = text;
  const redactions: Record<string, number> = {};
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const count = [...output.matchAll(rule.pattern)].length;
    if (count > 0) {
      redactions[rule.code] = count;
      output = output.replace(rule.pattern, rule.replacement as never);
    }
  }
  output = output.replace(IPV6_CANDIDATE, (value) => {
    if (isIP(value) !== 6) return value;
    redactions.IPV6 = (redactions.IPV6 ?? 0) + 1;
    return '[REDACTED_IP]';
  });
  output = output.replace(PHONE_CANDIDATE, (value) => {
    if (!validPhoneCandidate(value)) return value;
    redactions.PHONE = (redactions.PHONE ?? 0) + 1;
    return '[REDACTED_PHONE]';
  });
  const beforeUrls = output;
  output = redactSensitiveUrls(output);
  if (output !== beforeUrls) redactions.SENSITIVE_URL_QUERY = 1;
  return { text: output, redactions };
}
