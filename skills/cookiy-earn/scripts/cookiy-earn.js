#!/usr/bin/env node

// src/cli.ts
import { readFile as readFile6 } from "node:fs/promises";
import { basename, resolve as resolve2 } from "node:path";
import process2 from "node:process";

// src/core/content-hash.ts
import { createHash } from "node:crypto";
function contentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

// src/api/client.ts
var PRODUCTION_API_URL = "https://cash-panel-api.cookiy.ai/api";
var CookiyApiError = class extends Error {
  constructor(message, status, code, retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.name = "CookiyApiError";
  }
};
function cleanBaseUrl(value) {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Cookiy API URLs cannot contain credentials, a query, or a fragment.");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Cookiy API URLs must use HTTP or HTTPS.");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  const cleaned = parsed.toString().replace(/\/$/, "");
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (!loopback && cleaned !== PRODUCTION_API_URL) {
    throw new Error("Cookiy API URLs must target the production service or a loopback test server.");
  }
  return cleaned;
}
function record(value, includeDuplicate = false) {
  const input = value !== null && typeof value === "object" ? value : {};
  if (typeof input.id !== "string" || input.id.length === 0 || !Array.isArray(input.sources) || input.sources.length === 0 || input.sources.some((source2) => source2 !== "codex" && source2 !== "claude_code") || typeof input.sizeBytes !== "number" || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || typeof input.status !== "string" || input.status.length === 0 || typeof input.createdAt !== "string" || Number.isNaN(Date.parse(input.createdAt))) {
    throw new CookiyApiError("Cookiy returned an invalid response.", void 0, "INVALID_RESPONSE");
  }
  const sources = input.sources;
  return {
    id: input.id,
    sources,
    sizeBytes: input.sizeBytes,
    status: input.status,
    createdAt: input.createdAt,
    ...includeDuplicate && typeof input.duplicate === "boolean" ? { duplicate: input.duplicate } : {}
  };
}
async function responseError(response) {
  let code;
  try {
    const body = await response.json();
    if (typeof body.code === "string" && /^[A-Z0-9_]{2,64}$/.test(body.code)) code = body.code;
  } catch {
  }
  const retryable = response.status >= 500;
  let guidance;
  if (response.status === 401) {
    guidance = "Please save your Cookiy login token again by running `node <skill-directory>/scripts/cookiy-earn.js auth save`.";
  } else if (response.status === 403) {
    guidance = "Access denied. Check that your Cookiy account has permission, or contact Cookiy support.";
  } else if (retryable) {
    guidance = "Cookiy is temporarily unavailable. Please try again later.";
  } else if (response.status === 429) {
    guidance = "Too many requests to Cookiy. Please wait and try again later.";
  } else if (response.status === 413) {
    guidance = "The summary is too large. Shorten it, validate it, and review and approve the updated file before uploading again.";
  } else if (response.status === 422) {
    guidance = "Cookiy could not accept this summary. Run `validate` with its local facts file and fix any issues, then review and approve the updated file before uploading again.";
  } else {
    guidance = "Cookiy could not complete the request. Check the command and its inputs; if the problem persists, contact Cookiy support.";
  }
  return new CookiyApiError(`${guidance} (HTTP ${response.status}${code ? `; ${code}` : ""})`, response.status, code, retryable);
}
var CookiyApiClient = class {
  baseUrl;
  fetchImpl;
  timeoutMs;
  retries;
  constructor(options = {}) {
    this.baseUrl = cleanBaseUrl(options.baseUrl ?? process.env.COOKIY_API_URL ?? PRODUCTION_API_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 2e4;
    this.retries = options.retries ?? 2;
  }
  async request(path2, init, retry = false) {
    const attempts = retry ? this.retries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path2}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
        if (response.ok) return response;
        const error = await responseError(response);
        if (!error.retryable || attempt === attempts - 1) throw error;
      } catch (error) {
        if (error instanceof CookiyApiError && (!error.retryable || attempt === attempts - 1)) throw error;
        if (attempt === attempts - 1) {
          throw new CookiyApiError(
            error instanceof DOMException && error.name === "TimeoutError" ? "Cookiy took too long to respond. Please try again later. (TIMEOUT)" : "Could not reach Cookiy. Check your internet connection and try again. (NETWORK_ERROR)",
            void 0,
            error instanceof DOMException && error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR",
            true
          );
        }
      }
    }
    throw new CookiyApiError("Could not reach Cookiy. Check your internet connection and try again. (NETWORK_ERROR)", void 0, "NETWORK_ERROR", true);
  }
  async verifyToken(token) {
    const response = await this.request("/auth/cli-token/me", { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();
    return body !== null && typeof body === "object" ? body : {};
  }
  async upload(markdown, token) {
    const form = new FormData();
    const blobBytes = Uint8Array.from(markdown);
    form.append("file", new Blob([blobBytes.buffer], { type: "text/markdown; charset=utf-8" }), "summary.md");
    const response = await this.request("/data-summaries", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": contentHash(markdown)
      },
      body: form
    }, true);
    return record(await response.json(), true);
  }
  async list(token) {
    const response = await this.request("/data-summaries", { headers: { Authorization: `Bearer ${token}` } }, true);
    const body = await response.json();
    const container = body !== null && typeof body === "object" && !Array.isArray(body) ? body : void 0;
    const rawItems = Array.isArray(body) ? body : Array.isArray(container?.items) ? container.items : Array.isArray(container?.data) ? container.data : void 0;
    if (!rawItems) throw new CookiyApiError("Cookiy returned an invalid response.", void 0, "INVALID_RESPONSE");
    return {
      items: rawItems.map((item) => record(item)),
      ...typeof container?.nextCursor === "string" ? { nextCursor: container.nextCursor } : {}
    };
  }
};

// src/core/data-summary.ts
import { readFile as readFile2 } from "node:fs/promises";

// src/core/redaction.ts
import { isIP } from "node:net";
var RULES = [
  {
    code: "PRIVATE_KEY",
    message: "Private key material is not allowed.",
    pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]"
  },
  {
    code: "CLI_TOKEN",
    message: "A Cookiy CLI token is not allowed.",
    pattern: /\bcky_[A-Za-z0-9_-]{50}\b/g,
    replacement: "[REDACTED_CLI_TOKEN]"
  },
  {
    code: "BEARER_TOKEN",
    message: "A bearer credential is not allowed.",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
    replacement: "Bearer [REDACTED_TOKEN]"
  },
  {
    code: "BASIC_AUTH",
    message: "A Basic Authorization credential is not allowed.",
    pattern: /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi,
    replacement: "Basic [REDACTED_TOKEN]"
  },
  {
    code: "JWT",
    message: "A JSON Web Token is not allowed.",
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    replacement: "[REDACTED_JWT]"
  },
  {
    code: "CLOUD_CREDENTIAL",
    message: "A cloud credential is not allowed.",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: "[REDACTED_CLOUD_CREDENTIAL]"
  },
  {
    code: "API_KEY",
    message: "An API key is not allowed.",
    pattern: /\b(?:sk-(?:(?:proj|ant)-)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|npm_[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{16,})\b/g,
    replacement: "[REDACTED_API_KEY]"
  },
  {
    code: "COOKIE",
    message: "Cookie values are not allowed.",
    pattern: /\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+/gi,
    replacement: "Cookie: [REDACTED]"
  },
  {
    code: "SECRET_ASSIGNMENT",
    message: "A password, token, secret, or environment value is not allowed.",
    pattern: /(["'])(password|passwd|api[_-]?key|secret|access[_-]?token)\1\s*:\s*(["'])(?!\[REDACTED\])[^\r\n]*?\3/gi,
    replacement: (_match, keyQuote, name, valueQuote) => `${keyQuote}${name}${keyQuote}:${valueQuote}[REDACTED]${valueQuote}`
  },
  {
    code: "SECRET_ASSIGNMENT",
    message: "A password, token, secret, or environment value is not allowed.",
    pattern: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE)|password|passwd|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*(["'])(?!\[REDACTED\])[^\r\n]*?\2/gi,
    replacement: (_match, name) => `${name}=[REDACTED]`
  },
  {
    code: "SECRET_ASSIGNMENT",
    message: "A password, token, secret, or environment value is not allowed.",
    pattern: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE)|password|passwd|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*(["']?)(?!\[REDACTED\])[^\s,"'`;]+\2/gi,
    replacement: (_match, name) => `${name}=[REDACTED]`
  },
  {
    code: "CREDENTIAL_URI",
    message: "Credentials embedded in a URI are not allowed.",
    pattern: /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s/@:]+:[^\s/@]+@[^\s)\]}>]+/gi,
    replacement: "[REDACTED_CREDENTIAL_URI]"
  },
  {
    code: "EMAIL",
    message: "Email addresses must be removed.",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[REDACTED_EMAIL]"
  },
  {
    code: "IPV4",
    message: "IPv4 addresses must be removed.",
    pattern: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g,
    replacement: "[REDACTED_IP]"
  },
  {
    code: "HOME_PATH",
    message: "User home directories and usernames must be masked.",
    pattern: /(?:\/[Uu]sers|\/home)\/[^/\s`"']+(?=\/|\b)/g,
    replacement: "[HOME]"
  },
  {
    code: "WINDOWS_HOME_PATH",
    message: "Windows user home directories and usernames must be masked.",
    pattern: /\b[A-Za-z]:\\Users\\[^\r\n`"'<>|]+/gi,
    replacement: "[HOME]"
  },
  {
    code: "ABSOLUTE_LOCAL_PATH",
    message: "Original absolute local paths must be masked.",
    pattern: /(?<![A-Za-z0-9])(?:\/(?:private|tmp|var|opt|workspace|mnt|Volumes|srv|root|etc|usr)\/[^\s`"']+|[A-Za-z]:\\(?!Users\\)[^\r\n`"'<>|]+)/g,
    replacement: "[LOCAL_PATH]"
  },
  {
    code: "SESSION_ID",
    message: "Raw local session identifiers must be removed.",
    pattern: /\b((?:session(?:_?id)?|conversation(?:_?id)?)\s*[:=]\s*)[A-Za-z0-9_-]{8,}/gi,
    replacement: (_match, prefix) => `${prefix}[REDACTED_SESSION_ID]`
  },
  {
    code: "RAW_UUID",
    message: "Raw identifiers must be pseudonymized.",
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    replacement: "[REDACTED_ID]"
  }
];
var SENSITIVE_QUERY = /^(?:access_?token|api_?key|auth|authorization|code|credential|key|password|secret|signature|sig|token)$/i;
var IPV6_CANDIDATE = /(?<![A-Za-z0-9:])(?:[A-Fa-f0-9]{0,4}:){2,7}[A-Fa-f0-9]{0,4}(?![A-Za-z0-9:])/g;
var PHONE_CANDIDATE = /(?<![\w])(?:\+?\d[\d ().-]{6,}\d)(?![\w])/g;
function validPhoneCandidate(value) {
  return (value.match(/\d/g)?.length ?? 0) >= 10 && !/^\d{4}-\d{2}-\d{2}$/.test(value);
}
function locationAt(text, index) {
  const before = text.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}
function detectSensitiveContent(text) {
  const issues = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const location = locationAt(text, match.index ?? 0);
      issues.push({ code: rule.code, severity: "error", ...location, message: rule.message });
    }
  }
  for (const match of text.matchAll(IPV6_CANDIDATE)) {
    if (isIP(match[0]) !== 6) continue;
    const location = locationAt(text, match.index ?? 0);
    issues.push({ code: "IPV6", severity: "error", ...location, message: "IPv6 addresses must be removed." });
  }
  for (const match of text.matchAll(PHONE_CANDIDATE)) {
    if (!validPhoneCandidate(match[0])) continue;
    const location = locationAt(text, match.index ?? 0);
    issues.push({ code: "PHONE", severity: "error", ...location, message: "Phone numbers must be removed." });
  }
  const urlPattern = /(?:https?|ftp|s3):\/\/[^\s<>"')\]]+/gi;
  for (const match of text.matchAll(urlPattern)) {
    try {
      const url = new URL(match[0]);
      if ([...url.searchParams.entries()].some(([key, value]) => SENSITIVE_QUERY.test(key) && value !== "[REDACTED]")) {
        const location = locationAt(text, match.index ?? 0);
        issues.push({
          code: "SENSITIVE_URL_QUERY",
          severity: "error",
          ...location,
          message: "A URL contains a sensitive query parameter."
        });
      }
    } catch {
    }
  }
  return issues.sort((a, b) => a.line - b.line || a.column - b.column || a.code.localeCompare(b.code));
}
function redactSensitiveUrls(text) {
  return text.replace(/(?:https?|ftp|s3):\/\/[^\s<>"')\]]+/gi, (value) => {
    try {
      const url = new URL(value);
      let changed = false;
      for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_QUERY.test(key)) {
          url.searchParams.set(key, "[REDACTED]");
          changed = true;
        }
      }
      return changed ? url.toString() : value;
    } catch {
      return value;
    }
  });
}
function redactText(text) {
  let output = text;
  const redactions = {};
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const count = [...output.matchAll(rule.pattern)].length;
    if (count > 0) {
      redactions[rule.code] = count;
      output = output.replace(rule.pattern, rule.replacement);
    }
  }
  output = output.replace(IPV6_CANDIDATE, (value) => {
    if (isIP(value) !== 6) return value;
    redactions.IPV6 = (redactions.IPV6 ?? 0) + 1;
    return "[REDACTED_IP]";
  });
  output = output.replace(PHONE_CANDIDATE, (value) => {
    if (!validPhoneCandidate(value)) return value;
    redactions.PHONE = (redactions.PHONE ?? 0) + 1;
    return "[REDACTED_PHONE]";
  });
  const beforeUrls = output;
  output = redactSensitiveUrls(output);
  if (output !== beforeUrls) redactions.SENSITIVE_URL_QUERY = 1;
  return { text: output, redactions };
}

// src/core/representative-samples.ts
var MAX_REPRESENTATIVE_CANDIDATES = 8;
var MAX_REPRESENTATIVE_EXCERPT_CODE_POINTS = 280;
var MAX_REPRESENTATIVE_EXCERPTS_PER_CANDIDATE = 5;
function codePointLength(value) {
  return Array.from(value).length;
}
function removeFencedCode(value) {
  const output = [];
  let fenced = false;
  let character = "";
  let length = 0;
  for (const line of value.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fenced && marker) {
      fenced = true;
      character = marker[0];
      length = marker.length;
      output.push("[REMOVED_CODE]");
      continue;
    }
    if (fenced) {
      if (marker?.[0] === character && marker.length >= length) fenced = false;
      continue;
    }
    output.push(line);
  }
  return output.join("\n");
}
function stripMarkdownResources(value) {
  return removeFencedCode(value).replace(/!\[([^\]\n]*)\](?:\([^\n)]*\)|\[[^\]\n]*\])/g, " $1 ").replace(/\[([^\]\n]+)\](?:\([^\n)]*\)|\[[^\]\n]*\])/g, " $1 ").replace(/^\s{0,3}\[[^\]\n]+\]:\s*\S.*$/gm, " ").replace(/<(?:https?|ftp|file|s3|mailto):[^>]+>/gi, " [REMOVED_RESOURCE] ").replace(/\b(?:https?|ftp|file|s3):\/\/[^\s<>()\[\]{}]+/gi, " [REMOVED_RESOURCE] ").replace(/(^|[\s(])\/\/[A-Za-z0-9][^\s<>()\[\]{}]*/g, "$1[REMOVED_RESOURCE]").replace(/<\/?[A-Za-z][^>]*>/g, " ").replace(/`([^`\n]+)`/g, "$1");
}
function hasMeaningfulNaturalLanguage(value) {
  const withoutPlaceholders = value.replace(/\[(?:REDACTED|REMOVED|HOME|LOCAL_PATH)[^\]]*\]/gi, " ");
  return (withoutPlaceholders.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3;
}
function normalizeRepresentativeExcerpt(value) {
  const withoutResources = stripMarkdownResources(value);
  const withoutControls = withoutResources.replace(new RegExp("\\p{C}", "gu"), " ");
  const redacted = redactText(withoutControls).text.replace(/\s+/gu, " ").trim();
  if (!redacted || !hasMeaningfulNaturalLanguage(redacted)) return void 0;
  const points = Array.from(redacted);
  const truncated = points.length <= MAX_REPRESENTATIVE_EXCERPT_CODE_POINTS ? redacted : `${points.slice(0, MAX_REPRESENTATIVE_EXCERPT_CODE_POINTS - 1).join("").trimEnd()}…`;
  if (!truncated || detectSensitiveContent(truncated).length > 0) return void 0;
  return truncated;
}
function excerptsFor(messages) {
  const users = messages.filter((message) => message.role === "user");
  const opening = users[0];
  if (!opening) return [];
  const closing = users.at(-1);
  const messageIndexes = new Map(messages.map((message, index) => [message, index]));
  const assistantAfter = (ordinal) => messages.find((message) => message.role === "assistant" && message.ordinal > ordinal);
  const middle = users.slice(1, -1).flatMap((message) => {
    const normalized = normalizeRepresentativeExcerpt(message.text);
    if (!normalized) return [];
    const index = messageIndexes.get(message);
    const previous = messages[index - 1];
    const next = messages[index + 1];
    const before = previous?.role === "assistant" ? previous : void 0;
    const after = next?.role === "assistant" ? next : void 0;
    return [{
      message,
      before,
      after,
      completeness: Number(before !== void 0) + Number(after !== void 0),
      length: codePointLength(normalized)
    }];
  }).sort((left, right) => right.completeness - left.completeness || right.length - left.length || left.message.ordinal - right.message.ordinal)[0];
  const chosen = [
    { message: opening, position: "opening" }
  ];
  if (middle) {
    if (middle.before) chosen.push({ message: middle.before, position: "middle" });
    chosen.push({ message: middle.message, position: "middle" });
    if (middle.after) chosen.push({ message: middle.after, position: "middle" });
    const terminal = assistantAfter(closing.ordinal) ?? closing;
    chosen.push({ message: terminal, position: "closing" });
  } else {
    const openingAssistant = assistantAfter(opening.ordinal);
    if (openingAssistant) chosen.push({ message: openingAssistant, position: "opening" });
    if (closing.ordinal !== opening.ordinal) {
      chosen.push({ message: closing, position: "closing" });
      const closingAssistant = assistantAfter(closing.ordinal);
      if (closingAssistant) chosen.push({ message: closingAssistant, position: "closing" });
    }
  }
  const seen = /* @__PURE__ */ new Set();
  return chosen.flatMap(({ message, position }) => {
    const key = `${message.role}:${message.ordinal}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const text = normalizeRepresentativeExcerpt(message.text);
    return text ? [{ role: message.role, position, text }] : [];
  });
}
function activityScore(session) {
  return Math.min(session.userTurns, 20) * 3 + Math.min(session.assistantMessages, 20) * 2 + Math.min(session.toolCalls, 20);
}
function elapsedDuration(session) {
  if (session.timestamps.length < 2) return 0;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const value of session.timestamps) {
    earliest = Math.min(earliest, value);
    latest = Math.max(latest, value);
  }
  return latest - earliest;
}
function byMetric(metric) {
  return (left, right) => metric(right) - metric(left) || left.sourceOrder - right.sourceOrder || left.sessionOrder - right.sessionOrder;
}
function selectRepresentativeSessions(sessions) {
  const selected = [];
  const remaining = new Set(sessions);
  const add = (session) => {
    if (!session || !remaining.has(session) || selected.length >= MAX_REPRESENTATIVE_CANDIDATES) return;
    selected.push(session);
    remaining.delete(session);
  };
  for (const source2 of [...new Set(sessions.sort((left, right) => left.sourceOrder - right.sourceOrder || left.sessionOrder - right.sessionOrder).map((session) => session.source))]) {
    add([...remaining].filter((session) => session.source === source2).sort(byMetric(activityScore))[0]);
  }
  add([...remaining].sort(byMetric((session) => session.userTurns))[0]);
  const longestElapsed = [...remaining].sort(byMetric(elapsedDuration))[0];
  if (longestElapsed && elapsedDuration(longestElapsed) > 0) add(longestElapsed);
  add([...remaining].sort(byMetric((session) => session.toolCalls))[0]);
  for (const session of [...remaining].sort(byMetric(activityScore))) add(session);
  return selected;
}
function safeModels(models) {
  const values = [...new Set(models)].map((model) => model.replace(new RegExp("\\p{C}", "gu"), "").trim()).filter((model) => model.length > 0 && codePointLength(model) <= 120 && !/[|\r\n]/.test(model) && detectSensitiveContent(model).length === 0);
  return values.length > 0 ? values : void 0;
}
function createRepresentativeCandidates(sessions) {
  const eligible = sessions.flatMap((session) => {
    const messages = [...session.messages].sort((left, right) => left.ordinal - right.ordinal);
    const userTurns = messages.filter((message) => message.role === "user").length;
    const assistantMessages = messages.filter((message) => message.role === "assistant").length;
    const excerpts = excerptsFor(messages);
    if (userTurns === 0 || !excerpts.some((excerpt) => excerpt.role === "user")) return [];
    return [{ ...session, messages, excerpts, userTurns, assistantMessages }];
  });
  return selectRepresentativeSessions(eligible).map((session, index) => {
    const timestamps = [...session.timestamps].sort((left, right) => left - right);
    const models = safeModels(session.models);
    return {
      evidenceRef: `candidate-${String(index + 1).padStart(2, "0")}`,
      source: session.source,
      ...timestamps[0] !== void 0 ? { startedAt: new Date(timestamps[0]).toISOString() } : {},
      ...timestamps.at(-1) !== void 0 ? { endedAt: new Date(timestamps.at(-1)).toISOString() } : {},
      ...models ? { models } : {},
      sessionType: session.toolCalls > 0 ? "agentic" : "conversation",
      messageCount: session.messages.length,
      userTurns: session.userTurns,
      toolCalls: session.toolCalls,
      ...session.inputTokens !== void 0 ? { inputTokens: session.inputTokens } : {},
      ...session.outputTokens !== void 0 ? { outputTokens: session.outputTokens } : {},
      ...session.totalTokens !== void 0 ? { totalTokens: session.totalTokens } : {},
      excerpts: session.excerpts
    };
  });
}

// src/core/topics.ts
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
var TOPICS = [
  "frontend",
  "backend",
  "devops_infra",
  "data_science_ml",
  "mobile",
  "security",
  "developer_tooling",
  "general_coding",
  "mixed",
  "other",
  "unknown"
];
var SOURCES = ["codex", "claude_code"];
var TOPIC_SET = new Set(TOPICS);
var REVIEW_ROOT_KEYS = /* @__PURE__ */ new Set(["formatVersion", "generatedAt", "populationSha256", "sessionCount", "sessions"]);
var REVIEW_SESSION_KEYS = /* @__PURE__ */ new Set(["evidenceRef", "source", "userEvidence", "technicalSignals", "primaryTopic"]);
var BINDING_KEYS = /* @__PURE__ */ new Set(["formatVersion", "populationSha256", "sessionCount", "evidenceRefs"]);
var CLASSIFICATION_KEYS = /* @__PURE__ */ new Set([
  "method",
  "taxonomyVersion",
  "populationSha256",
  "denominator",
  "reviewedSessionCount",
  "assignments",
  "counts"
]);
var ASSIGNMENT_KEYS = /* @__PURE__ */ new Set(["evidenceRef", "source", "primaryTopic"]);
var MAX_EVIDENCE_SEGMENTS = 3;
var MAX_EVIDENCE_CODE_POINTS = 600;
function object(value, path2) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path2} must be an object.`);
  return value;
}
function assertOnlyKeys(value, allowed, path2) {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`${path2} contains unsupported field ${unexpected}.`);
}
function nonNegativeInteger(value, path2) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path2} must be a non-negative safe integer.`);
  }
  return value;
}
function nonEmptyString(value, path2) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path2} must be a non-empty string.`);
  return value;
}
function sha256(value, path2) {
  const candidate = nonEmptyString(value, path2);
  if (!/^[a-f0-9]{64}$/.test(candidate)) throw new Error(`${path2} must be a lowercase SHA-256.`);
  return candidate;
}
function isoTimestamp(value, path2) {
  const candidate = nonEmptyString(value, path2);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(candidate) || Number.isNaN(Date.parse(candidate))) {
    throw new Error(`${path2} must be a valid UTC ISO-8601 timestamp.`);
  }
  return candidate;
}
function source(value, path2) {
  if (!SOURCES.includes(value)) throw new Error(`${path2} contains an unsupported source.`);
  return value;
}
function topic(value, path2) {
  if (typeof value !== "string" || !TOPIC_SET.has(value)) throw new Error(`${path2} contains an unsupported Topic.`);
  return value;
}
function evidenceRef(value, path2) {
  const candidate = nonEmptyString(value, path2);
  if (candidate.length > 128 || !/^[a-z0-9-]+$/.test(candidate)) {
    throw new Error(`${path2} must be a short report-local reference.`);
  }
  return candidate;
}
function unique(values, path2) {
  if (new Set(values).size !== values.length) throw new Error(`${path2} must contain unique values.`);
}
function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function codePointLength2(value) {
  return [...value].length;
}
function normalizeTopicEvidence(value) {
  const normalized = value.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/gu, " ").trim();
  return redactText(normalized).text.trim();
}
function limitedEvidence(messages) {
  return messages.map(normalizeTopicEvidence).filter(Boolean).slice(0, MAX_EVIDENCE_SEGMENTS).map((value) => [...value].slice(0, MAX_EVIDENCE_CODE_POINTS).join("").trim());
}
function canonicalPopulation(nonce, sessions) {
  const members = sessions.map((session) => `${session.source}\0${session.internalIdentity}`).sort((left, right) => left.localeCompare(right));
  return JSON.stringify({ nonce, members });
}
function createTopicReview(sessions, generatedAt) {
  if (sessions.length === 0) throw new Error("A Topic review requires at least one Session.");
  const nonce = randomBytes(32).toString("hex");
  const prefix = contentHash(nonce).slice(0, 12);
  const populationSha256 = contentHash(canonicalPopulation(nonce, sessions));
  const reviewSessions = sessions.map((session, index) => {
    const userEvidence = limitedEvidence(session.userMessages);
    const issues = userEvidence.flatMap((value) => detectSensitiveContent(value));
    if (issues.length > 0) throw new Error(`Topic review evidence still contains high-risk sensitive content (${issues[0].code}).`);
    return {
      evidenceRef: `topic-${prefix}-${String(index + 1).padStart(6, "0")}`,
      source: session.source,
      userEvidence,
      primaryTopic: null
    };
  });
  const evidenceRefs = reviewSessions.map((session) => session.evidenceRef);
  return {
    binding: {
      formatVersion: "cookiy.topic-review.v1",
      populationSha256,
      sessionCount: reviewSessions.length,
      evidenceRefs
    },
    review: {
      formatVersion: "cookiy.topic-review.v1",
      generatedAt,
      populationSha256,
      sessionCount: reviewSessions.length,
      sessions: reviewSessions
    }
  };
}
function validateEvidence(value, path2) {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_SEGMENTS) {
    throw new Error(`${path2} must contain at most ${MAX_EVIDENCE_SEGMENTS} evidence segments.`);
  }
  return value.map((item, index) => {
    const candidate = nonEmptyString(item, `${path2}[${index}]`);
    if (codePointLength2(candidate) > MAX_EVIDENCE_CODE_POINTS) {
      throw new Error(`${path2}[${index}] must contain at most ${MAX_EVIDENCE_CODE_POINTS} Unicode code points.`);
    }
    if (normalizeTopicEvidence(candidate) !== candidate) throw new Error(`${path2}[${index}] is not normalized and redacted.`);
    const issue2 = detectSensitiveContent(candidate)[0];
    if (issue2) throw new Error(`${path2}[${index}] contains high-risk sensitive content (${issue2.code}).`);
    return candidate;
  });
}
function validateTechnicalSignals(value, path2) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value) || value.length > 32) throw new Error(`${path2} must contain at most 32 technical signals.`);
  const signals = value.map((item, index) => {
    const candidate = nonEmptyString(item, `${path2}[${index}]`);
    if (candidate.length > 64 || !/^[a-z0-9_.:+-]+$/.test(candidate)) {
      throw new Error(`${path2}[${index}] must be a low-risk normalized technical category.`);
    }
    return candidate;
  });
  unique(signals, path2);
  return signals;
}
function validateTopicReviewArtifact(value) {
  const root = object(value, "topicReview");
  assertOnlyKeys(root, REVIEW_ROOT_KEYS, "topicReview");
  if (root.formatVersion !== "cookiy.topic-review.v1") {
    throw new Error("topicReview.formatVersion must be cookiy.topic-review.v1.");
  }
  const generatedAt = isoTimestamp(root.generatedAt, "topicReview.generatedAt");
  const populationSha256 = sha256(root.populationSha256, "topicReview.populationSha256");
  const sessionCount = nonNegativeInteger(root.sessionCount, "topicReview.sessionCount");
  if (sessionCount === 0) throw new Error("topicReview.sessionCount must be greater than zero.");
  if (!Array.isArray(root.sessions)) throw new Error("topicReview.sessions must be an array.");
  const sessions = root.sessions.map((item, index) => {
    const path2 = `topicReview.sessions[${index}]`;
    const session = object(item, path2);
    assertOnlyKeys(session, REVIEW_SESSION_KEYS, path2);
    const technicalSignals = validateTechnicalSignals(session.technicalSignals, `${path2}.technicalSignals`);
    const primaryTopic = session.primaryTopic === null ? null : topic(session.primaryTopic, `${path2}.primaryTopic`);
    return {
      evidenceRef: evidenceRef(session.evidenceRef, `${path2}.evidenceRef`),
      source: source(session.source, `${path2}.source`),
      userEvidence: validateEvidence(session.userEvidence, `${path2}.userEvidence`),
      ...technicalSignals ? { technicalSignals } : {},
      primaryTopic
    };
  });
  if (sessions.length !== sessionCount) throw new Error("topicReview.sessions length must equal sessionCount.");
  unique(sessions.map((session) => session.evidenceRef), "topicReview.sessions evidenceRef values");
  return { formatVersion: "cookiy.topic-review.v1", generatedAt, populationSha256, sessionCount, sessions };
}
async function readTopicReviewFile(filePath) {
  return validateTopicReviewArtifact(JSON.parse(await readFile(filePath, "utf8")));
}
function validateTopicReviewBinding(value, expectedSessionCount) {
  const binding = object(value, "facts.topicReview");
  assertOnlyKeys(binding, BINDING_KEYS, "facts.topicReview");
  if (binding.formatVersion !== "cookiy.topic-review.v1") {
    throw new Error("facts.topicReview.formatVersion must be cookiy.topic-review.v1.");
  }
  const populationSha256 = sha256(binding.populationSha256, "facts.topicReview.populationSha256");
  const sessionCount = nonNegativeInteger(binding.sessionCount, "facts.topicReview.sessionCount");
  if (sessionCount !== expectedSessionCount) throw new Error("facts.topicReview.sessionCount must equal facts.overall.sessionCount.");
  if (!Array.isArray(binding.evidenceRefs)) throw new Error("facts.topicReview.evidenceRefs must be an array.");
  const evidenceRefs = binding.evidenceRefs.map((item, index) => evidenceRef(item, `facts.topicReview.evidenceRefs[${index}]`));
  if (evidenceRefs.length !== sessionCount) throw new Error("facts.topicReview.evidenceRefs length must equal sessionCount.");
  unique(evidenceRefs, "facts.topicReview.evidenceRefs");
  return { formatVersion: "cookiy.topic-review.v1", populationSha256, sessionCount, evidenceRefs };
}
function emptyCounts() {
  return Object.fromEntries(TOPICS.map((item) => [item, 0]));
}
function applyTopicReview(baseFacts, review) {
  const binding = baseFacts.topicReview;
  if (!binding) throw new Error("Base facts do not contain a Topic review binding.");
  if (baseFacts.topicClassification) throw new Error("Base facts already contain Topic classification.");
  if (review.generatedAt !== baseFacts.generatedAt) throw new Error("Topic review generatedAt does not match base facts.");
  if (review.populationSha256 !== binding.populationSha256) throw new Error("Topic review populationSha256 does not match base facts.");
  if (review.sessionCount !== binding.sessionCount) throw new Error("Topic review sessionCount does not match base facts.");
  const refs = review.sessions.map((session) => session.evidenceRef);
  if (!sameValues(refs, binding.evidenceRefs)) throw new Error("Topic review evidenceRef sequence does not match base facts.");
  const incomplete = review.sessions.find((session) => session.primaryTopic === null);
  if (incomplete) throw new Error(`Topic review is incomplete at ${incomplete.evidenceRef}.`);
  const assignments = review.sessions.map((session) => ({
    evidenceRef: session.evidenceRef,
    source: session.source,
    primaryTopic: session.primaryTopic
  }));
  const counts = emptyCounts();
  for (const assignment of assignments) counts[assignment.primaryTopic] += 1;
  return {
    ...baseFacts,
    topicClassification: {
      method: "agent_semantic_review_v1",
      taxonomyVersion: "primary-topic-v1",
      populationSha256: binding.populationSha256,
      denominator: binding.sessionCount,
      reviewedSessionCount: assignments.length,
      assignments,
      counts
    }
  };
}
function validateTopicClassification(value, binding, expectedSessionCount, sourceSessionCounts) {
  const classification = object(value, "facts.topicClassification");
  assertOnlyKeys(classification, CLASSIFICATION_KEYS, "facts.topicClassification");
  if (classification.method !== "agent_semantic_review_v1") {
    throw new Error("facts.topicClassification.method must be agent_semantic_review_v1.");
  }
  if (classification.taxonomyVersion !== "primary-topic-v1") {
    throw new Error("facts.topicClassification.taxonomyVersion must be primary-topic-v1.");
  }
  const populationSha256 = sha256(classification.populationSha256, "facts.topicClassification.populationSha256");
  if (populationSha256 !== binding.populationSha256) {
    throw new Error("facts.topicClassification.populationSha256 must match facts.topicReview.");
  }
  const denominator = nonNegativeInteger(classification.denominator, "facts.topicClassification.denominator");
  const reviewedSessionCount = nonNegativeInteger(
    classification.reviewedSessionCount,
    "facts.topicClassification.reviewedSessionCount"
  );
  if (denominator !== expectedSessionCount) throw new Error("facts.topicClassification.denominator must equal facts.overall.sessionCount.");
  if (reviewedSessionCount !== denominator) throw new Error("facts.topicClassification.reviewedSessionCount must equal denominator.");
  if (!Array.isArray(classification.assignments)) throw new Error("facts.topicClassification.assignments must be an array.");
  const assignments = classification.assignments.map((item, index) => {
    const path2 = `facts.topicClassification.assignments[${index}]`;
    const assignment = object(item, path2);
    assertOnlyKeys(assignment, ASSIGNMENT_KEYS, path2);
    return {
      evidenceRef: evidenceRef(assignment.evidenceRef, `${path2}.evidenceRef`),
      source: source(assignment.source, `${path2}.source`),
      primaryTopic: topic(assignment.primaryTopic, `${path2}.primaryTopic`)
    };
  });
  if (assignments.length !== denominator) throw new Error("facts.topicClassification.assignments length must equal denominator.");
  const assignmentRefs = assignments.map((assignment) => assignment.evidenceRef);
  unique(assignmentRefs, "facts.topicClassification.assignments evidenceRef values");
  if (!sameValues(assignmentRefs, binding.evidenceRefs)) {
    throw new Error("facts.topicClassification assignment references must match facts.topicReview.");
  }
  for (const sourceName2 of SOURCES) {
    const actual = assignments.filter((assignment) => assignment.source === sourceName2).length;
    const expected = sourceSessionCounts[sourceName2] ?? 0;
    if (actual !== expected) throw new Error(`facts.topicClassification ${sourceName2} assignment count must match facts.bySource.`);
  }
  const rawCounts = object(classification.counts, "facts.topicClassification.counts");
  assertOnlyKeys(rawCounts, new Set(TOPICS), "facts.topicClassification.counts");
  if (Object.keys(rawCounts).length !== TOPICS.length) {
    throw new Error("facts.topicClassification.counts must contain every Topic.");
  }
  const counts = emptyCounts();
  for (const topicName of TOPICS) counts[topicName] = nonNegativeInteger(rawCounts[topicName], `facts.topicClassification.counts.${topicName}`);
  const derived = emptyCounts();
  for (const assignment of assignments) derived[assignment.primaryTopic] += 1;
  for (const topicName of TOPICS) {
    if (counts[topicName] !== derived[topicName]) throw new Error("facts.topicClassification.counts must be derived from assignments.");
  }
  if (Object.values(counts).reduce((sum2, count) => sum2 + count, 0) !== denominator) {
    throw new Error("facts.topicClassification counts must sum to denominator.");
  }
  return {
    method: "agent_semantic_review_v1",
    taxonomyVersion: "primary-topic-v1",
    populationSha256,
    denominator,
    reviewedSessionCount,
    assignments,
    counts
  };
}

// src/core/data-summary.ts
var SOURCES2 = ["codex", "claude_code"];
var ROOT_KEYS = /* @__PURE__ */ new Set([
  "formatVersion",
  "generatedAt",
  "overall",
  "bySource",
  "representativeCandidates",
  "topicReview",
  "topicClassification"
]);
var CANDIDATE_KEYS = /* @__PURE__ */ new Set([
  "evidenceRef",
  "source",
  "startedAt",
  "endedAt",
  "models",
  "sessionType",
  "messageCount",
  "userTurns",
  "toolCalls",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "excerpts"
]);
var EXCERPT_KEYS = /* @__PURE__ */ new Set(["role", "position", "text"]);
var METRIC_KEYS = /* @__PURE__ */ new Set([
  "fileCount",
  "totalBytes",
  "sessionCount",
  "messageCount",
  "userMessageCount",
  "assistantMessageCount",
  "turnCount",
  "toolCallCount",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "earliestAt",
  "latestAt",
  "activeDays",
  "activeMonths",
  "parsedRecordCount",
  "recognizedRecordCount",
  "malformedRecordCount",
  "skippedFileCount",
  "unsupportedFileCount",
  "tokenArithmeticMismatchCount",
  "tokenCoverage",
  "turnsPerSession",
  "toolCallsPerSession",
  "tokensPerSession"
]);
var REQUIRED_INTEGER_METRICS = [
  "fileCount",
  "totalBytes",
  "sessionCount",
  "messageCount",
  "userMessageCount",
  "assistantMessageCount",
  "turnCount",
  "toolCallCount",
  "activeDays",
  "activeMonths",
  "parsedRecordCount",
  "recognizedRecordCount",
  "malformedRecordCount",
  "skippedFileCount",
  "unsupportedFileCount",
  "tokenArithmeticMismatchCount"
];
var ADDITIVE_METRICS = [
  ...REQUIRED_INTEGER_METRICS.filter((key) => key !== "activeDays" && key !== "activeMonths")
];
function object2(value, path2) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path2} must be an object.`);
  return value;
}
function assertOnlyKeys2(value, allowed, path2) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`${path2} contains unsupported field ${unexpected[0]}.`);
}
function integer(value, path2) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${path2} must be a non-negative safe integer.`);
  return value;
}
function optionalInteger(value, path2) {
  return value === void 0 ? void 0 : integer(value, path2);
}
function requiredString(value, path2) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${path2} must be a non-empty trimmed string.`);
  }
  return value;
}
function isoTimestamp2(value, path2) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${path2} must be a valid UTC ISO-8601 timestamp.`);
  }
  return value;
}
function validateDistribution(value, path2, expectedSampleSize, expectedSum) {
  const item = object2(value, path2);
  assertOnlyKeys2(item, /* @__PURE__ */ new Set(["sampleSize", "p50", "p95", "mean", "max"]), path2);
  const sampleSize = integer(item.sampleSize, `${path2}.sampleSize`);
  if (sampleSize !== expectedSampleSize) throw new Error(`${path2}.sampleSize must equal ${expectedSampleSize}.`);
  const values = ["p50", "p95", "mean", "max"].map((key) => {
    const candidate = item[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) throw new Error(`${path2}.${key} must be a non-negative finite number.`);
    return candidate;
  });
  const [p50, p95, mean, max] = values;
  if (![p50, p95, max].every(Number.isSafeInteger)) throw new Error(`${path2} percentiles and max must be safe integers.`);
  if (sampleSize === 0 && values.some((candidate) => candidate !== 0)) throw new Error(`${path2} must contain zero values when sampleSize is zero.`);
  if (p50 > p95 || p95 > max || mean > max) throw new Error(`${path2} percentiles and mean are inconsistent with max.`);
  if (expectedSum !== void 0 && Math.abs(mean * sampleSize - expectedSum) > sampleSize * 5e-3 + Number.EPSILON) {
    throw new Error(`${path2}.mean is inconsistent with the aggregate total.`);
  }
  return { sampleSize, p50, p95, mean, max };
}
function validateMetricSet(value, path2) {
  const metrics = object2(value, path2);
  assertOnlyKeys2(metrics, METRIC_KEYS, path2);
  for (const key of REQUIRED_INTEGER_METRICS) integer(metrics[key], `${path2}.${key}`);
  const sessionCount = metrics.sessionCount;
  if (sessionCount > 0 && metrics.fileCount === 0) throw new Error(`${path2}.fileCount must be positive when Sessions are present.`);
  if (sessionCount > 0 && metrics.recognizedRecordCount === 0) throw new Error(`${path2}.recognizedRecordCount must be positive when Sessions are present.`);
  if (metrics.messageCount !== metrics.userMessageCount + metrics.assistantMessageCount) {
    throw new Error(`${path2}.messageCount must equal userMessageCount + assistantMessageCount.`);
  }
  if (metrics.turnCount !== metrics.userMessageCount) throw new Error(`${path2}.turnCount must equal userMessageCount.`);
  if (metrics.recognizedRecordCount > metrics.parsedRecordCount) {
    throw new Error(`${path2}.recognizedRecordCount cannot exceed parsedRecordCount.`);
  }
  const inputTokens = optionalInteger(metrics.inputTokens, `${path2}.inputTokens`);
  const outputTokens = optionalInteger(metrics.outputTokens, `${path2}.outputTokens`);
  const totalTokens = optionalInteger(metrics.totalTokens, `${path2}.totalTokens`);
  if ([inputTokens, outputTokens, totalTokens].some((item) => item !== void 0) && [inputTokens, outputTokens, totalTokens].some((item) => item === void 0)) {
    throw new Error(`${path2} token totals must either all be present or all be omitted.`);
  }
  if (inputTokens !== void 0 && outputTokens !== void 0 && totalTokens !== inputTokens + outputTokens) {
    throw new Error(`${path2}.totalTokens must equal inputTokens + outputTokens.`);
  }
  const coverage = object2(metrics.tokenCoverage, `${path2}.tokenCoverage`);
  assertOnlyKeys2(coverage, /* @__PURE__ */ new Set(["sessionCount", "sessionsWithInputTokens", "sessionsWithOutputTokens", "sessionsWithTotalTokens"]), `${path2}.tokenCoverage`);
  const coverageSessionCount = integer(coverage.sessionCount, `${path2}.tokenCoverage.sessionCount`);
  const sessionsWithInputTokens = integer(coverage.sessionsWithInputTokens, `${path2}.tokenCoverage.sessionsWithInputTokens`);
  const sessionsWithOutputTokens = integer(coverage.sessionsWithOutputTokens, `${path2}.tokenCoverage.sessionsWithOutputTokens`);
  const sessionsWithTotalTokens = integer(coverage.sessionsWithTotalTokens, `${path2}.tokenCoverage.sessionsWithTotalTokens`);
  if (coverageSessionCount !== sessionCount) throw new Error(`${path2}.tokenCoverage.sessionCount must equal sessionCount.`);
  if ([sessionsWithInputTokens, sessionsWithOutputTokens, sessionsWithTotalTokens].some((count) => count > sessionCount)) {
    throw new Error(`${path2}.tokenCoverage counts cannot exceed sessionCount.`);
  }
  if (sessionsWithTotalTokens > sessionsWithInputTokens || sessionsWithTotalTokens > sessionsWithOutputTokens) {
    throw new Error(`${path2}.tokenCoverage total-token count cannot exceed input- or output-token coverage.`);
  }
  const hasAvailableTokens = sessionsWithTotalTokens > 0;
  if (totalTokens !== void 0 !== hasAvailableTokens) {
    throw new Error(`${path2} aggregate token presence must match available total-token coverage.`);
  }
  const earliestAt = metrics.earliestAt === void 0 ? void 0 : isoTimestamp2(metrics.earliestAt, `${path2}.earliestAt`);
  const latestAt = metrics.latestAt === void 0 ? void 0 : isoTimestamp2(metrics.latestAt, `${path2}.latestAt`);
  if (earliestAt === void 0 !== (latestAt === void 0)) throw new Error(`${path2} must provide both earliestAt and latestAt, or neither.`);
  if (earliestAt && latestAt && Date.parse(earliestAt) > Date.parse(latestAt)) throw new Error(`${path2}.earliestAt cannot be later than latestAt.`);
  if (!earliestAt && (metrics.activeDays !== 0 || metrics.activeMonths !== 0)) throw new Error(`${path2} active time counts require a time range.`);
  if (earliestAt && (metrics.activeDays === 0 || metrics.activeMonths === 0)) throw new Error(`${path2} time ranges require positive active time counts.`);
  if (metrics.activeMonths > metrics.activeDays) throw new Error(`${path2}.activeMonths cannot exceed activeDays.`);
  validateDistribution(metrics.turnsPerSession, `${path2}.turnsPerSession`, sessionCount, metrics.turnCount);
  validateDistribution(metrics.toolCallsPerSession, `${path2}.toolCallsPerSession`, sessionCount, metrics.toolCallCount);
  if (sessionsWithTotalTokens === 0) {
    if (metrics.tokensPerSession !== void 0) throw new Error(`${path2}.tokensPerSession must be omitted without total-token samples.`);
  } else {
    validateDistribution(metrics.tokensPerSession, `${path2}.tokensPerSession`, sessionsWithTotalTokens, totalTokens);
  }
  return metrics;
}
function sum(metrics, key) {
  return metrics.reduce((total, item) => total + item[key], 0);
}
function validateRepresentativeCandidates(value, bySource) {
  if (!Array.isArray(value)) throw new Error("facts.representativeCandidates must be an array.");
  if (value.length > MAX_REPRESENTATIVE_CANDIDATES) {
    throw new Error(`facts.representativeCandidates cannot contain more than ${MAX_REPRESENTATIVE_CANDIDATES} candidates.`);
  }
  const seen = /* @__PURE__ */ new Set();
  return value.map((rawCandidate, index) => {
    const path2 = `facts.representativeCandidates[${index}]`;
    const candidate = object2(rawCandidate, path2);
    assertOnlyKeys2(candidate, CANDIDATE_KEYS, path2);
    const evidenceRef2 = requiredString(candidate.evidenceRef, `${path2}.evidenceRef`);
    if (evidenceRef2 !== `candidate-${String(index + 1).padStart(2, "0")}`) {
      throw new Error(`${path2}.evidenceRef must be the report-local sequential candidate reference.`);
    }
    if (seen.has(evidenceRef2)) throw new Error("facts.representativeCandidates evidenceRef values must be unique.");
    seen.add(evidenceRef2);
    if (!SOURCES2.includes(candidate.source) || !bySource[candidate.source]) {
      throw new Error(`${path2}.source must name a source present in facts.bySource.`);
    }
    const source2 = candidate.source;
    const startedAt = candidate.startedAt === void 0 ? void 0 : isoTimestamp2(candidate.startedAt, `${path2}.startedAt`);
    const endedAt = candidate.endedAt === void 0 ? void 0 : isoTimestamp2(candidate.endedAt, `${path2}.endedAt`);
    if (startedAt && endedAt && Date.parse(startedAt) > Date.parse(endedAt)) {
      throw new Error(`${path2}.startedAt cannot be later than endedAt.`);
    }
    let models;
    if (candidate.models !== void 0) {
      if (!Array.isArray(candidate.models) || candidate.models.length === 0) throw new Error(`${path2}.models must be a non-empty array.`);
      models = candidate.models.map((model, modelIndex) => {
        const parsed = requiredString(model, `${path2}.models[${modelIndex}]`);
        if (Array.from(parsed).length > 120 || /[|\r\n]/.test(parsed) || detectSensitiveContent(parsed).length > 0) {
          throw new Error(`${path2}.models[${modelIndex}] is unsafe or too long.`);
        }
        return parsed;
      });
      if (new Set(models).size !== models.length) throw new Error(`${path2}.models must contain unique values.`);
    }
    if (candidate.sessionType !== "agentic" && candidate.sessionType !== "conversation") {
      throw new Error(`${path2}.sessionType must be agentic or conversation.`);
    }
    const sessionType = candidate.sessionType;
    const messageCount = integer(candidate.messageCount, `${path2}.messageCount`);
    const userTurns = integer(candidate.userTurns, `${path2}.userTurns`);
    const toolCalls = integer(candidate.toolCalls, `${path2}.toolCalls`);
    if (userTurns === 0 || userTurns > messageCount) throw new Error(`${path2}.userTurns must be positive and cannot exceed messageCount.`);
    if (toolCalls > 0 !== (sessionType === "agentic")) throw new Error(`${path2}.sessionType must agree with toolCalls.`);
    const sourceMetrics = bySource[source2];
    if (messageCount > sourceMetrics.messageCount || userTurns > sourceMetrics.turnCount || toolCalls > sourceMetrics.toolCallCount) {
      throw new Error(`${path2} metrics cannot exceed the corresponding source aggregates.`);
    }
    const inputTokens = optionalInteger(candidate.inputTokens, `${path2}.inputTokens`);
    const outputTokens = optionalInteger(candidate.outputTokens, `${path2}.outputTokens`);
    const totalTokens = optionalInteger(candidate.totalTokens, `${path2}.totalTokens`);
    if (inputTokens !== void 0 && outputTokens !== void 0 && totalTokens !== void 0 && totalTokens !== inputTokens + outputTokens) {
      throw new Error(`${path2}.totalTokens must equal inputTokens + outputTokens when token fields are complete.`);
    }
    if (!Array.isArray(candidate.excerpts) || candidate.excerpts.length < 1 || candidate.excerpts.length > MAX_REPRESENTATIVE_EXCERPTS_PER_CANDIDATE) {
      throw new Error(`${path2}.excerpts must contain between 1 and ${MAX_REPRESENTATIVE_EXCERPTS_PER_CANDIDATE} excerpts.`);
    }
    const excerpts = candidate.excerpts.map((rawExcerpt, excerptIndex) => {
      const excerptPath = `${path2}.excerpts[${excerptIndex}]`;
      const excerpt = object2(rawExcerpt, excerptPath);
      assertOnlyKeys2(excerpt, EXCERPT_KEYS, excerptPath);
      if (excerpt.role !== "user" && excerpt.role !== "assistant") throw new Error(`${excerptPath}.role is unsupported.`);
      if (excerpt.position !== "opening" && excerpt.position !== "middle" && excerpt.position !== "closing") {
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
    if (!excerpts.some((excerpt) => excerpt.role === "user")) throw new Error(`${path2}.excerpts must retain human user evidence.`);
    return {
      evidenceRef: evidenceRef2,
      source: source2,
      ...startedAt ? { startedAt } : {},
      ...endedAt ? { endedAt } : {},
      ...models ? { models } : {},
      sessionType,
      messageCount,
      userTurns,
      toolCalls,
      ...inputTokens !== void 0 ? { inputTokens } : {},
      ...outputTokens !== void 0 ? { outputTokens } : {},
      ...totalTokens !== void 0 ? { totalTokens } : {},
      excerpts
    };
  });
}
function validateFactsReport(value) {
  const root = object2(value, "facts");
  assertOnlyKeys2(root, ROOT_KEYS, "facts");
  if (root.formatVersion !== "cookiy.facts.v1") throw new Error("facts.formatVersion must be cookiy.facts.v1.");
  const generatedAt = isoTimestamp2(root.generatedAt, "facts.generatedAt");
  const overall = validateMetricSet(root.overall, "facts.overall");
  if (overall.sessionCount === 0) throw new Error("facts.overall.sessionCount must be greater than zero.");
  const rawBySource = object2(root.bySource, "facts.bySource");
  const sourceNames = Object.keys(rawBySource);
  if (sourceNames.length === 0) throw new Error("facts.bySource must contain at least one source.");
  if (sourceNames.some((source2) => !SOURCES2.includes(source2))) throw new Error("facts.bySource contains an unsupported source.");
  const bySource = {};
  for (const source2 of sourceNames) {
    const metrics = validateMetricSet(rawBySource[source2], `facts.bySource.${source2}`);
    if (metrics.sessionCount === 0) throw new Error(`facts.bySource.${source2}.sessionCount must be greater than zero.`);
    bySource[source2] = metrics;
  }
  const sourceMetrics = Object.values(bySource);
  for (const key of ADDITIVE_METRICS) {
    if (overall[key] !== sum(sourceMetrics, key)) throw new Error(`facts.overall.${key} must equal the By Source sum.`);
  }
  for (const key of ["sessionCount", "sessionsWithInputTokens", "sessionsWithOutputTokens", "sessionsWithTotalTokens"]) {
    const expected = sourceMetrics.reduce((total, item) => total + item.tokenCoverage[key], 0);
    if (overall.tokenCoverage[key] !== expected) throw new Error(`facts.overall.tokenCoverage.${key} must equal the By Source sum.`);
  }
  for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
    const expected = overall.tokenCoverage.sessionsWithTotalTokens > 0 ? sourceMetrics.reduce((total, metrics) => total + (metrics[key] ?? 0), 0) : void 0;
    if (overall[key] !== expected) throw new Error(`facts.overall.${key} must match available By Source coverage.`);
  }
  const earliest = sourceMetrics.map((metrics) => metrics.earliestAt).filter((item) => item !== void 0).sort()[0];
  const latest = sourceMetrics.map((metrics) => metrics.latestAt).filter((item) => item !== void 0).sort().at(-1);
  if (overall.earliestAt !== earliest || overall.latestAt !== latest) throw new Error("facts.overall time range must match By Source ranges.");
  const topicReview = root.topicReview === void 0 ? void 0 : validateTopicReviewBinding(root.topicReview, overall.sessionCount);
  if (root.topicClassification !== void 0 && !topicReview) {
    throw new Error("facts.topicClassification requires facts.topicReview.");
  }
  const topicClassification = root.topicClassification === void 0 || !topicReview ? void 0 : validateTopicClassification(
    root.topicClassification,
    topicReview,
    overall.sessionCount,
    Object.fromEntries(Object.entries(bySource).map(([source2, metrics]) => [source2, metrics.sessionCount]))
  );
  const representativeCandidates = root.representativeCandidates === void 0 ? void 0 : validateRepresentativeCandidates(root.representativeCandidates, bySource);
  return {
    formatVersion: "cookiy.facts.v1",
    generatedAt,
    overall,
    bySource,
    ...representativeCandidates ? { representativeCandidates } : {},
    ...topicReview ? { topicReview } : {},
    ...topicClassification ? { topicClassification } : {}
  };
}
async function readFactsFile(filePath) {
  return validateFactsReport(JSON.parse(await readFile2(filePath, "utf8")));
}
function display(value) {
  return value === void 0 ? "unavailable" : String(value);
}
function distributionRow(label, item) {
  if (!item || item.sampleSize === 0) return `| ${label} | 0 | unavailable | unavailable | unavailable | unavailable |`;
  return `| ${label} | ${item.sampleSize} | ${item.p50} | ${item.p95} | ${item.mean} | ${item.max} |`;
}
function metricSections(metrics, headingLevel) {
  const heading = "#".repeat(headingLevel);
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
${distributionRow("Turns per session", metrics.turnsPerSession)}
${distributionRow("Tool calls per session", metrics.toolCallsPerSession)}
${distributionRow("Tokens per session", metrics.tokensPerSession)}`;
}
function sourceName(source2) {
  return source2 === "claude_code" ? "Claude Code" : "Codex";
}
function counted(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
function renderKeyHighlights(facts) {
  const sourceCount = Object.keys(facts.bySource).length;
  return [
    `- **Coverage:** ${counted(facts.overall.sessionCount, "main session")} from ${counted(sourceCount, "source")} across ${counted(facts.overall.fileCount, "source file")}.`,
    `- **Interaction volume:** ${counted(facts.overall.turnCount, "human user turn")} and ${counted(facts.overall.assistantMessageCount, "assistant message")}; median user turns per Session: ${facts.overall.turnsPerSession.p50}.`,
    `- **Tool use:** ${counted(facts.overall.toolCallCount, "recorded tool call")}; median per Session: ${facts.overall.toolCallsPerSession.p50}, maximum: ${facts.overall.toolCallsPerSession.max}.`
  ].join("\n");
}
function renderGeneratedStatistics(facts) {
  const sources = Object.entries(facts.bySource).map(([source2, metrics]) => `#### ${sourceName(source2)}

${metricSections(metrics, 5)}`).join("\n\n");
  const topicSection = facts.topicClassification ? `

#### Primary Topic Distribution

Method: \`agent_semantic_review_v1\`. Taxonomy: \`primary-topic-v1\`.
Denominator: all ${facts.topicClassification.denominator} included Sessions. All Sessions were reviewed by the current Agent.

| Primary topic | Sessions | Share |
| --- | ---: | ---: |
${TOPICS.map((topic2) => {
    const count = facts.topicClassification.counts[topic2];
    const share = (count / facts.topicClassification.denominator * 100).toFixed(2);
    return `| ${topic2} | ${count} | ${share}% |`;
  }).join("\n")}` : "";
  return `### Overall

${metricSections(facts.overall, 4)}

### By Source

${sources}${topicSection}`;
}
function renderDataSummary(facts) {
  const sources = Object.keys(facts.bySource);
  const sourceList = sources.map((source2) => `  - ${source2}`).join("\n");
  const samplePrivacy = facts.representativeCandidates === void 0 ? "No dialogue excerpts or representative samples are included." : "Only manually selected, facts-bound, redacted representative excerpts may be included; the candidate pool remains local.";
  const topicPrivacy = facts.topicClassification ? `${samplePrivacy} Only aggregate Primary Topic counts and shares are included; per-Session Topic evidence and assignments remain local.` : `${samplePrivacy} Topic labels, behavioral classifications, local paths, and raw Session identifiers are not included.`;
  const tokenSummary = facts.overall.totalTokens === void 0 ? "Total-token data is unavailable." : `Available-session token data totals ${facts.overall.totalTokens} tokens across ${facts.overall.tokenCoverage.sessionsWithTotalTokens} of ${facts.overall.sessionCount} Sessions.`;
  return `---
format_version: cookiy.data-summary.v1
privacy_reviewed: false
sources:
${sourceList}
generated_at: ${facts.generatedAt}
---

# Coding Session Data Summary

## Executive Summary

This report summarizes ${counted(facts.overall.sessionCount, "coding session")} from ${sources.map(sourceName).join(" and ")}, covering ${display(facts.overall.earliestAt)} through ${display(facts.overall.latestAt)}. ${tokenSummary}

### Why This Data Is Valuable

- **Scale and realism:** The source sessions have ${counted(facts.overall.turnCount, "human user turn")} in total.
- **Tool-use statistics:** The source sessions have ${counted(facts.overall.toolCallCount, "recorded tool call")}; this report includes aggregate counts, not execution traces.
- **Privacy-minimized scope:** ${topicPrivacy}

## Key Highlights

${renderKeyHighlights(facts)}

## Descriptive Statistics

${renderGeneratedStatistics(facts)}

## Representative Session Samples

No representative samples were included.
`;
}

// src/core/markdown-contract.ts
import { readFile as readFile3 } from "node:fs/promises";
var MAX_MARKDOWN_BYTES = 16 * 1024 * 1024;
var FORMAT_VERSION = "cookiy.data-summary.v1";
var ALLOWED_SOURCES = ["codex", "claude_code"];
function issue(code, message, line = 1, column = 1) {
  return { code, severity: "error", line, column, message };
}
function parseFrontMatter(text) {
  const lines = text.split(/\r?\n/);
  const issues = [];
  if (lines[0] !== "---") return { values: {}, endLine: 0, issues: [issue("MISSING_FRONT_MATTER", "The document must begin with YAML front matter.")] };
  const endIndex = lines.indexOf("---", 1);
  if (endIndex < 0) return { values: {}, endLine: 0, issues: [issue("INVALID_FRONT_MATTER", "The front matter closing delimiter is missing.")] };
  const values = {};
  let activeList;
  for (let index = 1; index < endIndex; index += 1) {
    const line = lines[index] ?? "";
    const pair = /^([a-z0-9_]+):(?:\s*(.*))?$/.exec(line);
    if (pair) {
      const key = pair[1] ?? "";
      const rawValue = (pair[2] ?? "").trim().replace(/^['"]|['"]$/g, "");
      if (rawValue === "") {
        values[key] = [];
        activeList = key;
      } else {
        values[key] = rawValue;
        activeList = void 0;
      }
      continue;
    }
    const item = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (item && activeList && Array.isArray(values[activeList])) {
      values[activeList].push((item[1] ?? "").replace(/^['"]|['"]$/g, ""));
      continue;
    }
    if (line.trim() !== "") issues.push(issue("INVALID_FRONT_MATTER", "Only simple scalar fields and source lists are supported.", index + 1));
  }
  return { values, endLine: endIndex + 1, issues };
}
function scanLines(text) {
  const lines = [];
  const fenceLines = [];
  let offset = 0;
  let fenced = false;
  let fenceCharacter = "";
  let fenceLength = 0;
  for (const [index, raw] of text.split(/(?<=\n)/).entries()) {
    const line = raw.replace(/\r?\n$/, "");
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const before = fenced;
    if (marker) {
      fenceLines.push(index + 1);
      const sequence = marker[1];
      if (!fenced) {
        fenced = true;
        fenceCharacter = sequence[0];
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
function headingPositions(lines, heading) {
  return lines.filter((line) => !line.fenced && line.text === heading);
}
function representativeSampleRange(lines, textLength) {
  const section = headingPositions(lines, "## Representative Session Samples")[0];
  if (!section) return void 0;
  const nextSection = lines.find((line) => line.line > section.line && !line.fenced && /^##\s+/.test(line.text));
  return { start: section.end, end: nextSection?.start ?? textLength, headingLine: section.line };
}
function protectSampleTables(text) {
  const replacements = [];
  let sequence = 0;
  const protectedText = text.replace(/^\|[^\r\n]*\|[ \t]*$/gm, (value) => {
    let marker = "";
    do {
      marker = `COOKIYPROTECTEDSAMPLETABLE${sequence}END`;
      sequence += 1;
    } while (text.includes(marker));
    replacements.push({ marker, value });
    return marker;
  });
  return {
    text: protectedText,
    restore: (value) => replacements.reduce((output, item) => output.replace(item.marker, item.value), value)
  };
}
function redactRepresentativeSamples(text) {
  const scanned = scanLines(text);
  const range = representativeSampleRange(scanned.lines, text.length);
  if (!range) return { text, redactions: {} };
  const sample = protectSampleTables(text.slice(range.start, range.end));
  const result = redactText(sample.text);
  return {
    text: `${text.slice(0, range.start)}${sample.restore(result.text)}${text.slice(range.end)}`,
    redactions: result.redactions
  };
}
function sampleSensitiveContentIssues(text, lines) {
  const range = representativeSampleRange(lines, text.length);
  if (!range) return [];
  const sample = protectSampleTables(text.slice(range.start, range.end));
  return detectSensitiveContent(sample.text).map((item) => ({
    ...item,
    line: item.line + range.headingLine - 1
  }));
}
function validateDocumentStructure(lines, fenceLines) {
  const issues = [];
  const requiredHeadings = [
    "# Coding Session Data Summary",
    "## Executive Summary",
    "### Why This Data Is Valuable",
    "## Key Highlights",
    "## Descriptive Statistics",
    "### Overall",
    "### By Source",
    "## Representative Session Samples"
  ];
  let previous = -1;
  for (const heading of requiredHeadings) {
    const positions = headingPositions(lines, heading);
    if (positions.length === 0) {
      issues.push(issue("MISSING_SECTION", `Missing required heading: ${heading}`));
      continue;
    }
    if (positions.length > 1) issues.push(issue("DUPLICATE_SECTION", `Required heading appears more than once: ${heading}`));
    if (positions[0].line <= previous) issues.push(issue("SECTION_ORDER", `Required heading is out of order: ${heading}`));
    previous = positions[0].line;
  }
  if (fenceLines[0] !== void 0) {
    issues.push(issue("CODE_FENCE_NOT_ALLOWED", "Fenced code blocks are not allowed in a Data Summary.", fenceLines[0]));
  }
  return issues;
}
function validateFactsBinding(text, lines, sources, privacyReviewed, facts) {
  const issues = [];
  if (!facts) return [issue("FACTS_FILE_REQUIRED", "A Data Summary must be validated and uploaded with its local cookiy.facts.v1 file.")];
  const expectedSources = Object.keys(facts.bySource).sort();
  if (JSON.stringify([...sources].sort()) !== JSON.stringify(expectedSources)) {
    issues.push(issue("FACTS_SOURCE_MISMATCH", "Front-matter sources do not match the supplied facts file."));
  }
  const placeholder = "No representative samples were included.";
  const expected = renderDataSummary(facts).replace("privacy_reviewed: false", `privacy_reviewed: ${privacyReviewed}`);
  const placeholderAt = expected.indexOf(placeholder);
  const expectedPrefix = expected.slice(0, placeholderAt);
  const expectedSuffix = expected.slice(placeholderAt + placeholder.length);
  if (placeholderAt < 0 || !text.startsWith(expectedPrefix) || !text.endsWith(expectedSuffix)) {
    issues.push(issue("GENERATED_CONTENT_CHANGED", "Content outside Representative Session Samples differs from the supplied facts file; render it again instead of editing it manually."));
  }
  const statisticsHeading = headingPositions(lines, "## Descriptive Statistics")[0];
  const overallHeading = headingPositions(lines, "### Overall")[0];
  const samplesHeading = headingPositions(lines, "## Representative Session Samples")[0];
  if (!statisticsHeading || !overallHeading || !samplesHeading) {
    issues.push(issue("MISSING_GENERATED_STATISTICS", "The deterministic statistics section is missing."));
  } else if (overallHeading.line <= statisticsHeading.line || samplesHeading.line <= overallHeading.line) {
    issues.push(issue("GENERATED_STATISTICS_LOCATION", "The deterministic statistics must stay inside Descriptive Statistics."));
  } else {
    const actual = text.slice(overallHeading.start, samplesHeading.start).trimEnd();
    if (actual !== renderGeneratedStatistics(facts)) {
      issues.push(issue("GENERATED_STATISTICS_CHANGED", "The deterministic statistics section differs from the supplied facts file; render it again instead of editing it manually."));
    }
  }
  return issues;
}
var SAMPLE_FIELDS = ["Evidence ref", "Source", "Model", "Session type", "Total tokens", "User turns"];
var SAMPLE_LABELS = [
  "Tags",
  "Context",
  "Workflow and outcome",
  "Why it is valuable",
  "Data-governance note",
  "Representative quote"
];
function normalizedWhitespace(value) {
  return value.replace(/\s+/gu, " ").trim();
}
var MANUAL_REDACTION = "[REDACTED]";
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function matchesCandidateExcerpt(candidateText, quoteText) {
  const candidate = normalizedWhitespace(candidateText);
  const quote = normalizedWhitespace(quoteText);
  if (candidate === quote) return true;
  if (!quote.includes(MANUAL_REDACTION)) return false;
  const visibleText = quote.replaceAll(MANUAL_REDACTION, " ");
  if ((visibleText.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 3) return false;
  const pattern = quote.split(MANUAL_REDACTION).map(escapeRegExp).join(".+?");
  return new RegExp(`^${pattern}$`, "u").test(candidate);
}
function sourceDisplay(source2) {
  return source2 === "claude_code" ? "Claude Code" : "Codex";
}
function containsNonLatinLanguage(value) {
  return Array.from(value).some((character) => new RegExp("\\p{L}", "u").test(character) && !new RegExp("\\p{Script=Latin}", "u").test(character));
}
function tableBlocks(lines) {
  const blocks = [];
  let active = [];
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
function tableCells(line) {
  return line.trim().slice(1, -1).split("|").map((cell) => cell.trim());
}
function validateSampleCard(cardLines, candidateMap, usedCandidates) {
  const issues = [];
  const heading = cardLines[0];
  const tables = tableBlocks(cardLines.slice(1));
  if (tables.length !== 1) {
    issues.push(issue("SAMPLE_METADATA_TABLE", "Each sample card must contain exactly one metadata table.", heading.line));
    return issues;
  }
  const table = tables[0];
  const delimiter = table[1] ? tableCells(table[1].text) : [];
  if (table.length < 2 || JSON.stringify(tableCells(table[0].text)) !== JSON.stringify(["Field", "Value"]) || delimiter.length !== 2 || !delimiter.every((cell) => /^:?-{3,}:?$/.test(cell))) {
    issues.push(issue("SAMPLE_METADATA_TABLE", "The sample metadata table must use the required Field and Value header.", table[0]?.line ?? heading.line));
    return issues;
  }
  const fields = /* @__PURE__ */ new Map();
  for (const row of table.slice(2)) {
    const cells = tableCells(row.text);
    if (cells.length !== 2) {
      issues.push(issue("SAMPLE_METADATA_TABLE", "Sample metadata rows must contain exactly two columns.", row.line));
      continue;
    }
    const [field, value] = cells;
    fields.set(field, [...fields.get(field) ?? [], value]);
  }
  for (const field of SAMPLE_FIELDS) {
    if ((fields.get(field)?.length ?? 0) !== 1) {
      issues.push(issue("SAMPLE_METADATA_FIELD", `Sample metadata must contain ${field} exactly once.`, heading.line));
    }
  }
  for (const field of fields.keys()) {
    if (!SAMPLE_FIELDS.includes(field)) {
      issues.push(issue("SAMPLE_METADATA_FIELD", `Unsupported sample metadata field: ${field}.`, heading.line));
    }
  }
  if (issues.some((item) => item.code.startsWith("SAMPLE_METADATA"))) return issues;
  const evidenceRef2 = fields.get("Evidence ref")[0];
  const candidate = candidateMap.get(evidenceRef2);
  if (!candidate) {
    issues.push(issue("SAMPLE_EVIDENCE_REF", "Evidence ref does not exist in the supplied facts candidate pool.", heading.line));
    return issues;
  }
  if (usedCandidates.has(evidenceRef2)) issues.push(issue("DUPLICATE_SAMPLE_EVIDENCE", "A representative candidate can be used only once.", heading.line));
  usedCandidates.add(evidenceRef2);
  const expected = /* @__PURE__ */ new Map([
    ["Source", sourceDisplay(candidate.source)],
    ["Model", candidate.models?.join(", ") ?? "unavailable"],
    ["Session type", candidate.sessionType],
    ["Total tokens", candidate.totalTokens === void 0 ? "unavailable" : String(candidate.totalTokens)],
    ["User turns", String(candidate.userTurns)]
  ]);
  for (const [field, value] of expected) {
    if (fields.get(field)[0] !== value) issues.push(issue("SAMPLE_FACT_MISMATCH", `${field} does not match ${evidenceRef2}.`, heading.line));
  }
  const otherRefs = [...cardLines.map((line) => line.text).join("\n").matchAll(/\bcandidate-\d{2}\b/g)].map((match) => match[0]).filter((value) => value !== evidenceRef2);
  if (otherRefs.length > 0) issues.push(issue("MIXED_SAMPLE_EVIDENCE", "A sample card cannot refer to another candidate.", heading.line));
  for (const label of SAMPLE_LABELS) {
    const pattern = new RegExp(`^\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\*\\*(?:\\s+(.*))?$`);
    const matches = cardLines.filter((line) => !line.fenced && pattern.test(line.text));
    if (matches.length !== 1) issues.push(issue("SAMPLE_REQUIRED_CONTENT", `Sample card must contain ${label} exactly once.`, heading.line));
    else if (label !== "Representative quote" && !normalizedWhitespace(pattern.exec(matches[0].text)?.[1] ?? "")) {
      issues.push(issue("SAMPLE_REQUIRED_CONTENT", `${label} cannot be empty.`, matches[0].line));
    }
  }
  const labelPositions = SAMPLE_LABELS.map((label) => cardLines.findIndex((line) => line.text.startsWith(`**${label}:**`)));
  if (labelPositions.some((position, index) => position < 0 || index > 0 && position <= labelPositions[index - 1])) {
    issues.push(issue("SAMPLE_CONTENT_ORDER", "Sample card content must follow the required label order.", heading.line));
  }
  const tagsLine = cardLines.find((line) => /^\*\*Tags:\*\*/.test(line.text));
  if (tagsLine) {
    const tags = tagsLine.text.replace(/^\*\*Tags:\*\*\s*/, "").split(",").map((tag) => tag.trim()).filter(Boolean);
    if (tags.length < 3 || tags.length > 6 || new Set(tags.map((tag) => tag.toLowerCase())).size !== tags.length) {
      issues.push(issue("SAMPLE_TAGS", "Tags must contain 3–6 unique comma-separated values.", tagsLine.line));
    }
  }
  const quoteLabelIndex = cardLines.findIndex((line) => line.text === "**Representative quote:**");
  const quotes = [];
  if (quoteLabelIndex >= 0) {
    for (const line of cardLines.slice(quoteLabelIndex + 1)) {
      if (!/^>/.test(line.text)) {
        if (line.text.trim()) issues.push(issue("SAMPLE_QUOTE_FORMAT", "Only quote lines may follow Representative quote.", line.line));
        continue;
      }
      const quote = line.text.replace(/^>\s?/, "").trim();
      if (!quote) continue;
      const parsed = /^(User|Assistant):\s+(.+)$/.exec(quote);
      if (!parsed) {
        issues.push(issue("SAMPLE_QUOTE_FORMAT", "Quotes must begin with User: or Assistant:.", line.line));
        continue;
      }
      const role = parsed[1].toLowerCase();
      const translation = /\s+\((user|assistant), translated\)$/i.exec(parsed[2]);
      if (translation && translation[1].toLowerCase() !== role) {
        issues.push(issue("SAMPLE_TRANSLATION_ROLE", "The translation role marker must match the quoted role.", line.line));
      }
      quotes.push({
        role,
        text: normalizedWhitespace(translation ? parsed[2].slice(0, translation.index) : parsed[2]),
        translated: Boolean(translation),
        line: line.line
      });
    }
  }
  if (quotes.length === 0) {
    issues.push(issue("SAMPLE_QUOTE_REQUIRED", "Each sample card needs at least one candidate-bound quote or English translation.", heading.line));
  }
  const originals = quotes.filter((quote) => !quote.translated);
  for (const quote of originals) {
    const matchingExcerpts = candidate.excerpts.filter((excerpt) => excerpt.role === quote.role && matchesCandidateExcerpt(excerpt.text, quote.text));
    if (matchingExcerpts.length === 0) {
      issues.push(issue("SAMPLE_QUOTE_MISMATCH", "Every original quote must exactly match a candidate excerpt except for sensitive spans replaced with [REDACTED].", quote.line));
    }
    if (containsNonLatinLanguage(quote.text) || matchingExcerpts.some((excerpt) => containsNonLatinLanguage(excerpt.text))) {
      issues.push(issue("NON_ENGLISH_ORIGINAL_NOT_ALLOWED", "Do not include a non-English original in the report; include only its role-marked English translation.", quote.line));
    }
  }
  for (const quote of quotes.filter((item) => item.translated)) {
    if (!/[A-Za-z]/.test(quote.text) || containsNonLatinLanguage(quote.text)) {
      issues.push(issue("SAMPLE_TRANSLATION_ENGLISH", "A translated quote must contain only an English translation, without the non-English original.", quote.line));
    }
    if (!candidate.excerpts.some((excerpt) => excerpt.role === quote.role && containsNonLatinLanguage(excerpt.text))) {
      issues.push(issue("UNBOUND_SAMPLE_TRANSLATION", "A translated quote must be bound by role to a non-English candidate excerpt.", quote.line));
    }
  }
  return issues;
}
function validateRepresentativeSamples(lines, facts) {
  const issues = [];
  const section = headingPositions(lines, "## Representative Session Samples")[0];
  if (!section) {
    const quote = lines.find((line) => !line.fenced && /^\s{0,3}>/.test(line.text));
    if (quote) issues.push(issue("UNBOUND_BLOCK_QUOTE", "Block quotes are allowed only as quotes inside a valid sample card.", quote.line));
    return { count: 0, issues };
  }
  const sectionStart = lines.findIndex((line) => line === section);
  const nextSectionOffset = lines.slice(sectionStart + 1).findIndex((line) => !line.fenced && /^##\s+/.test(line.text));
  const sectionEnd = nextSectionOffset < 0 ? lines.length : sectionStart + 1 + nextSectionOffset;
  const sampleSection = lines.slice(sectionStart + 1, sectionEnd);
  const unexpectedSubheading = sampleSection.find((line) => !line.fenced && /^###\s+/.test(line.text) && !/^###\s+(?:Example|Sample)\b/i.test(line.text));
  if (unexpectedSubheading) issues.push(issue("SAMPLE_HEADING", "Only numbered example headings are allowed in the sample section.", unexpectedSubheading.line));
  const sampleHeadings = sampleSection.filter((line) => !line.fenced && /^###\s+(?:Example|Sample)\b/i.test(line.text));
  const outside = lines.filter((line, index) => (index <= sectionStart || index >= sectionEnd) && !line.fenced && /^###\s+(?:Example|Sample)\b/i.test(line.text));
  if (outside.length > 0) issues.push(issue("SAMPLE_OUTSIDE_SECTION", "Sample cards are allowed only inside Representative Session Samples.", outside[0].line));
  if (sampleHeadings.length > 3) issues.push(issue("TOO_MANY_SAMPLES", "A Data Summary can contain at most three representative samples.", sampleHeadings[3].line));
  if (sampleHeadings.length > 0 && !facts?.representativeCandidates) {
    issues.push(issue("SAMPLE_CANDIDATES_REQUIRED", "Representative samples require a facts artifact containing the default candidate pool.", sampleHeadings[0].line));
  }
  const parsedHeadings = sampleHeadings.flatMap((line) => {
    const match = /^### Example (\d+)\.\s+(.+\S)\s*$/.exec(line.text);
    if (!match) {
      issues.push(issue("SAMPLE_HEADING", "Sample headings must use “### Example N. Generalized title”.", line.line));
      return [];
    }
    return [{ line, number: Number(match[1]) }];
  });
  parsedHeadings.forEach((heading, index) => {
    if (heading.number !== index + 1) issues.push(issue("SAMPLE_NUMBERING", "Sample numbering must start at 1 and remain consecutive.", heading.line.line));
  });
  const candidateMap = new Map((facts?.representativeCandidates ?? []).map((candidate) => [candidate.evidenceRef, candidate]));
  const usedCandidates = /* @__PURE__ */ new Set();
  const allowedQuoteLines = /* @__PURE__ */ new Set();
  for (const [index, heading] of parsedHeadings.entries()) {
    const start = sampleSection.findIndex((line) => line === heading.line);
    const next = parsedHeadings[index + 1];
    const end = next ? sampleSection.findIndex((line) => line === next.line) : sampleSection.length;
    const card = sampleSection.slice(start, end);
    const quoteLabelIndex = card.findIndex((line) => line.text === "**Representative quote:**");
    if (quoteLabelIndex >= 0) {
      for (const line of card.slice(quoteLabelIndex + 1)) {
        if (/^>/.test(line.text)) allowedQuoteLines.add(line.line);
      }
    }
    issues.push(...validateSampleCard(card, candidateMap, usedCandidates));
  }
  const unboundQuote = lines.find((line) => !line.fenced && /^\s{0,3}>/.test(line.text) && !allowedQuoteLines.has(line.line));
  if (unboundQuote) issues.push(issue("UNBOUND_BLOCK_QUOTE", "Block quotes are allowed only as quotes inside a valid sample card.", unboundQuote.line));
  return { count: sampleHeadings.length, issues };
}
function validateMarkdownBuffer(buffer, facts) {
  const issues = [];
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    issues.push(issue("INVALID_UTF8", "The file must be valid UTF-8."));
  }
  if (buffer.length > MAX_MARKDOWN_BYTES) issues.push(issue("FILE_TOO_LARGE", `The file exceeds ${MAX_MARKDOWN_BYTES} bytes.`));
  if (buffer.includes(0)) issues.push(issue("BINARY_CONTENT", "The Markdown file cannot contain NUL bytes."));
  const scanned = scanLines(text);
  const parsed = parseFrontMatter(text);
  issues.push(...parsed.issues);
  const formatVersion = typeof parsed.values.format_version === "string" ? parsed.values.format_version : void 0;
  const sourceValues = Array.isArray(parsed.values.sources) ? parsed.values.sources.filter((value) => typeof value === "string") : [];
  const sources = sourceValues.filter((value) => ALLOWED_SOURCES.includes(value));
  const generatedAt = typeof parsed.values.generated_at === "string" ? parsed.values.generated_at : void 0;
  const privacyReviewed = parsed.values.privacy_reviewed === "true";
  if (formatVersion !== FORMAT_VERSION) issues.push(issue("UNSUPPORTED_FORMAT_VERSION", `format_version must be ${FORMAT_VERSION}.`));
  if (sourceValues.length === 0) issues.push(issue("MISSING_SOURCES", "sources must contain at least one supported source."));
  for (const source2 of sourceValues) {
    if (!ALLOWED_SOURCES.includes(source2)) issues.push(issue("UNSUPPORTED_SOURCE", `Unsupported source: ${source2}.`));
  }
  if (new Set(sourceValues).size !== sourceValues.length) issues.push(issue("DUPLICATE_SOURCE", "sources must not contain duplicate values."));
  if (!generatedAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(generatedAt) || Number.isNaN(Date.parse(generatedAt))) {
    issues.push(issue("INVALID_GENERATED_AT", "generated_at must be a valid UTC ISO-8601 timestamp."));
  }
  if (!privacyReviewed) {
    issues.push(issue("PRIVACY_REVIEW_REQUIRED", "privacy_reviewed must be true after deterministic redaction and manual review."));
  }
  issues.push(...validateDocumentStructure(scanned.lines, scanned.fenceLines));
  const sampleValidation = validateRepresentativeSamples(scanned.lines, facts);
  const sampleCount = sampleValidation.count;
  issues.push(...sampleValidation.issues);
  if (formatVersion === FORMAT_VERSION) {
    issues.push(...validateFactsBinding(text, scanned.lines, sources, privacyReviewed, facts));
  }
  if (/<\/?(?:script|iframe|object|embed|style|img|video|audio|form|svg|[a-z][a-z0-9-]*)(?:\s[^>]*)?>/i.test(text)) {
    issues.push(issue("HTML_NOT_ALLOWED", "HTML and embedded active content are not allowed."));
  }
  if (/!?\[[^\]\n]*\](?:\([^\n)]*\)|\[[^\]\n]*\])/i.test(text) || /^\s{0,3}\[[^\]\n]+\]:\s*\S+/im.test(text) || /<(?:https?|ftp|file|s3|mailto):[^>]+>/i.test(text) || /\b(?:https?|ftp|file|s3):\/\//i.test(text) || /(^|[\s(])\/\/[A-Za-z0-9]/m.test(text)) {
    issues.push(issue("LINK_NOT_ALLOWED", "Links, images, and URI destinations are not allowed in a Data Summary."));
  }
  if (/\b(?:attachment|cid):\s*\S+/i.test(text)) issues.push(issue("ATTACHMENT_NOT_ALLOWED", "Attachments are not allowed in a Data Summary."));
  issues.push(...sampleSensitiveContentIssues(text, scanned.lines));
  return {
    valid: issues.length === 0,
    sizeBytes: buffer.length,
    metadata: {
      ...formatVersion ? { formatVersion } : {},
      sources,
      ...generatedAt ? { generatedAt } : {},
      privacyReviewed,
      sampleCount
    },
    issues
  };
}
async function validateMarkdownFile(filePath, facts) {
  return validateMarkdownBuffer(await readFile3(filePath), facts);
}

// src/core/statistics.ts
import { createReadStream } from "node:fs";
import { readdir, readFile as readFile4, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { createInterface } from "node:readline";
var SUPPORTED_EXTENSIONS = /* @__PURE__ */ new Set([".json", ".jsonl", ".ndjson"]);
var TEXT_CONTENT_TYPES = /* @__PURE__ */ new Set(["text", "input_text", "output_text"]);
function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function object3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function string(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function percentile(sorted, value) {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(value * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return { sampleSize: 0, p50: 0, p95: 0, mean: 0, max: 0 };
  return {
    sampleSize: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    mean: Number((sorted.reduce((sum2, item) => sum2 + item, 0) / sorted.length).toFixed(2)),
    max: sorted.at(-1)
  };
}
function timestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 1e10 ? value * 1e3 : value;
    return Number.isNaN(new Date(millis).getTime()) ? void 0 : millis;
  }
  if (typeof value === "string") {
    const millis = Date.parse(value);
    return Number.isNaN(millis) ? void 0 : millis;
  }
  return void 0;
}
function contentText(content, ignoredTypes = /* @__PURE__ */ new Set()) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    const item = object3(part);
    const type = String(item?.type ?? "");
    if (!item || ignoredTypes.has(type) || type && !TEXT_CONTENT_TYPES.has(type)) return "";
    return string(item.text) ?? string(item.input_text) ?? string(item.output_text) ?? "";
  }).filter(Boolean).join("\n");
}
function sessionFor(map, source2, filePath, rawId) {
  if (!rawId) {
    const fromSameFile = [...map.values()].find((session) => session.source === source2 && session.filePath === filePath);
    if (fromSameFile) return fromSameFile;
  }
  const id = rawId ?? filePath;
  const key = `${source2}\0${id}`;
  const existing = map.get(key);
  if (existing) return existing;
  const created = {
    rawId: id,
    source: source2,
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
    hasTotalTokens: false
  };
  map.set(key, created);
  return created;
}
function addMessageCandidate(session, role, content, ordinal, timestampMillis, fallback = false) {
  const text = contentText(content).trim();
  if (role !== "user" && role !== "assistant" || !text) return false;
  (fallback ? session.fallbackMessages : session.primaryMessages).push({
    role,
    text,
    ...timestampMillis !== void 0 ? { timestamp: new Date(timestampMillis).toISOString() } : {},
    ordinal
  });
  return true;
}
function finalizeMessages(session) {
  const messages = session.source === "codex" ? ["user", "assistant"].flatMap((role) => {
    const primary = session.primaryMessages.filter((item) => item.role === role);
    return primary.length > 0 ? primary : session.fallbackMessages.filter((item) => item.role === role);
  }) : session.primaryMessages;
  session.messages = messages.sort((left, right) => left.ordinal - right.ordinal);
  session.messageCount = session.messages.length;
  session.userMessageCount = session.messages.filter((message) => message.role === "user").length;
  session.assistantMessageCount = session.messages.filter((message) => message.role === "assistant").length;
  session.turnCount = session.userMessageCount;
  session.userMessages = session.messages.filter((message) => message.role === "user").map((message) => message.text);
}
function addModel(session, ...values) {
  for (const value of values) {
    const model = string(value);
    if (model && !session.models.includes(model)) session.models.push(model);
  }
}
function addUsage(session, usage, cumulative = false) {
  if (!usage) return false;
  const input = numeric(usage.input_tokens ?? usage.inputTokens);
  const output = numeric(usage.output_tokens ?? usage.outputTokens);
  const total = numeric(usage.total_tokens ?? usage.totalTokens);
  if (input !== void 0) {
    if (cumulative) session.cumulativeInputTokens = Math.max(session.cumulativeInputTokens ?? 0, input);
    else session.inputTokens += input;
    session.hasInputTokens = true;
  }
  if (output !== void 0) {
    if (cumulative) session.cumulativeOutputTokens = Math.max(session.cumulativeOutputTokens ?? 0, output);
    else session.outputTokens += output;
    session.hasOutputTokens = true;
  }
  if (total !== void 0) {
    if (cumulative) session.cumulativeTotalTokens = Math.max(session.cumulativeTotalTokens ?? 0, total);
    else session.totalTokens += total;
    session.hasTotalTokens = true;
  }
  return input !== void 0 || output !== void 0 || total !== void 0;
}
function processCodexRecord(record2, filePath, sessions, ordinal) {
  const payload = object3(record2.payload);
  const supported = record2.type === "session_meta" || record2.type === "response_item" && payload !== void 0 || record2.type === "event_msg" && payload !== void 0;
  if (!supported) return false;
  const sessionId = string(record2.session_id) ?? string(record2.sessionId) ?? (record2.type === "session_meta" ? string(payload?.id) : void 0);
  const session = sessionFor(sessions, "codex", filePath, sessionId);
  const time = timestamp(record2.timestamp ?? record2.created_at ?? payload?.timestamp);
  if (time !== void 0) session.timestamps.push(time);
  addModel(session, record2.model, payload?.model, object3(payload?.model_info)?.model);
  let recognized = record2.type === "session_meta";
  if (record2.type === "response_item" && payload) {
    if (payload.type === "message") recognized = addMessageCandidate(session, payload.role, payload.content, ordinal, time) || recognized;
    if (payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "local_shell_call") {
      session.toolCallCount += 1;
      recognized = true;
    }
  }
  if (record2.type === "event_msg" && payload) {
    if (payload.type === "user_message") recognized = addMessageCandidate(session, "user", string(payload.message) ?? payload.content, ordinal, time, true) || recognized;
    if (payload.type === "agent_message") recognized = addMessageCandidate(session, "assistant", string(payload.message) ?? payload.content, ordinal, time, true) || recognized;
    if (payload.type === "token_count") {
      const info = object3(payload.info);
      recognized = addUsage(session, object3(info?.total_token_usage), true) || recognized;
    }
  }
  return addUsage(session, object3(payload?.usage) ?? object3(record2.usage)) || recognized;
}
function processClaudeRecord(record2, filePath, sessions, ordinal) {
  if (record2.isSidechain === true || record2.is_sidechain === true || typeof record2.agentId === "string" || typeof record2.agent_id === "string" || typeof record2.parentToolUseID === "string" || typeof record2.parent_tool_use_id === "string" || record2.isMeta === true || record2.is_meta === true || ["system", "summary", "progress", "queue-operation"].includes(String(record2.type ?? ""))) return false;
  const message = object3(record2.message);
  const role = record2.type === "user" || record2.type === "assistant" ? record2.type : message?.role;
  if (role !== "user" && role !== "assistant") return false;
  const sessionId = string(record2.sessionId) ?? string(record2.session_id);
  const session = sessionFor(sessions, "claude_code", filePath, sessionId);
  const time = timestamp(record2.timestamp ?? record2.createdAt ?? message?.timestamp);
  if (time !== void 0) session.timestamps.push(time);
  addModel(session, record2.model, message?.model);
  const content = message?.content ?? record2.content;
  const ignoredTypes = role === "user" ? /* @__PURE__ */ new Set(["tool_result"]) : /* @__PURE__ */ new Set(["thinking", "redacted_thinking", "tool_use", "tool_result"]);
  const hasMessage = addMessageCandidate(session, role, contentText(content, ignoredTypes), ordinal, time);
  const blocks = Array.isArray(content) ? content : [];
  const toolCalls = role === "assistant" ? blocks.filter((block) => object3(block)?.type === "tool_use").length : 0;
  session.toolCallCount += toolCalls;
  const hasUsage = addUsage(session, object3(message?.usage) ?? object3(record2.usage));
  return hasMessage || toolCalls > 0 || hasUsage || role === "user" && blocks.some((block) => object3(block)?.type === "tool_result");
}
async function collectFiles(inputPath) {
  const absolute = resolve(inputPath);
  const info = await stat(absolute);
  if (info.isFile()) return SUPPORTED_EXTENSIONS.has(extname(absolute).toLowerCase()) ? { files: [{ path: absolute, bytes: info.size }], unsupportedFileCount: 0 } : { files: [], unsupportedFileCount: 1 };
  if (!info.isDirectory()) return { files: [], unsupportedFileCount: 0 };
  const output = [];
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
async function parseJsonLines(filePath, onRecord) {
  let malformed = 0;
  let parsedCount = 0;
  let recognizedCount = 0;
  const lines = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const record2 = object3(parsed);
      if (record2) {
        parsedCount += 1;
        if (onRecord(record2)) recognizedCount += 1;
      } else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { parsed: parsedCount, recognized: recognizedCount, malformed };
}
async function parseJson(filePath, onRecord) {
  try {
    const parsed = JSON.parse(await readFile4(filePath, "utf8"));
    const records = Array.isArray(parsed) ? parsed : [parsed];
    let malformed = 0;
    let parsedCount = 0;
    let recognizedCount = 0;
    for (const value of records) {
      const record2 = object3(value);
      if (record2) {
        parsedCount += 1;
        if (onRecord(record2)) recognizedCount += 1;
      } else malformed += 1;
    }
    return { parsed: parsedCount, recognized: recognizedCount, malformed };
  } catch {
    return { parsed: 0, recognized: 0, malformed: 1 };
  }
}
function activityCount(sessions) {
  return [...sessions.values()].reduce((sum2, session) => sum2 + session.primaryMessages.length + session.fallbackMessages.length + session.toolCallCount, 0);
}
async function scanSource(source2, files, unsupportedFileCount) {
  const sessions = /* @__PURE__ */ new Map();
  let parsedRecordCount = 0;
  let recognizedRecordCount = 0;
  let malformedRecordCount = 0;
  let skippedFileCount = 0;
  let ordinal = 0;
  for (const file of files) {
    const beforeMeaningful = activityCount(sessions);
    const process3 = (record2) => {
      ordinal += 1;
      return source2 === "codex" ? processCodexRecord(record2, file.path, sessions, ordinal) : processClaudeRecord(record2, file.path, sessions, ordinal);
    };
    const counts = extname(file.path).toLowerCase() === ".json" ? await parseJson(file.path, process3) : await parseJsonLines(file.path, process3);
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
    unsupportedFileCount
  };
}
function sessionInputTokens(session) {
  return session.hasInputTokens ? session.cumulativeInputTokens ?? session.inputTokens : void 0;
}
function sessionOutputTokens(session) {
  return session.hasOutputTokens ? session.cumulativeOutputTokens ?? session.outputTokens : void 0;
}
function sessionTotalTokens(session) {
  const input = sessionInputTokens(session);
  const output = sessionOutputTokens(session);
  if (input !== void 0 && output !== void 0) return input + output;
  return void 0;
}
function hasTokenArithmeticMismatch(session) {
  const normalized = sessionTotalTokens(session);
  if (normalized === void 0) return false;
  const reported = session.cumulativeTotalTokens !== void 0 ? session.cumulativeTotalTokens : session.hasTotalTokens ? session.totalTokens : void 0;
  return reported !== void 0 && reported !== normalized;
}
function metricSet(scan) {
  const timestamps = scan.sessions.flatMap((session) => session.timestamps).sort((a, b) => a - b);
  const days = new Set(timestamps.map((value) => new Date(value).toISOString().slice(0, 10)));
  const months = new Set(timestamps.map((value) => new Date(value).toISOString().slice(0, 7)));
  const sessionsWithInput = scan.sessions.filter((session) => session.hasInputTokens);
  const sessionsWithOutput = scan.sessions.filter((session) => session.hasOutputTokens);
  const sessionsWithCompleteTokens = scan.sessions.flatMap((session) => {
    const input = sessionInputTokens(session);
    const output = sessionOutputTokens(session);
    return input === void 0 || output === void 0 ? [] : [{ input, output, total: input + output }];
  });
  const inputTokens = sessionsWithCompleteTokens.reduce((sum2, session) => sum2 + session.input, 0);
  const outputTokens = sessionsWithCompleteTokens.reduce((sum2, session) => sum2 + session.output, 0);
  const totalTokens = sessionsWithCompleteTokens.reduce((sum2, session) => sum2 + session.total, 0);
  return {
    fileCount: scan.files.length,
    totalBytes: scan.files.reduce((sum2, file) => sum2 + file.bytes, 0),
    sessionCount: scan.sessions.length,
    messageCount: scan.sessions.reduce((sum2, session) => sum2 + session.messageCount, 0),
    userMessageCount: scan.sessions.reduce((sum2, session) => sum2 + session.userMessageCount, 0),
    assistantMessageCount: scan.sessions.reduce((sum2, session) => sum2 + session.assistantMessageCount, 0),
    turnCount: scan.sessions.reduce((sum2, session) => sum2 + session.turnCount, 0),
    toolCallCount: scan.sessions.reduce((sum2, session) => sum2 + session.toolCallCount, 0),
    ...sessionsWithCompleteTokens.length > 0 ? { inputTokens, outputTokens, totalTokens } : {},
    ...timestamps[0] !== void 0 ? { earliestAt: new Date(timestamps[0]).toISOString() } : {},
    ...timestamps.at(-1) !== void 0 ? { latestAt: new Date(timestamps.at(-1)).toISOString() } : {},
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
      sessionsWithTotalTokens: sessionsWithCompleteTokens.length
    },
    turnsPerSession: distribution(scan.sessions.map((session) => session.turnCount)),
    toolCallsPerSession: distribution(scan.sessions.map((session) => session.toolCallCount)),
    ...sessionsWithCompleteTokens.length > 0 ? { tokensPerSession: distribution(sessionsWithCompleteTokens.map((session) => session.total)) } : {}
  };
}
async function deduplicatedScans(inputs) {
  const collected = await Promise.all(inputs.map(async (input) => ({ input, collected: await collectFiles(input.path) })));
  const scans = [];
  for (const source2 of [...new Set(inputs.map((input) => input.source))]) {
    const entries = collected.filter((entry) => entry.input.source === source2);
    const canonicalFiles = /* @__PURE__ */ new Map();
    for (const file of entries.flatMap((entry) => entry.collected.files)) {
      const canonicalPath = await realpath(file.path);
      if (!canonicalFiles.has(canonicalPath)) canonicalFiles.set(canonicalPath, { path: canonicalPath, bytes: file.bytes });
    }
    scans.push(await scanSource(
      source2,
      [...canonicalFiles.values()].sort((left, right) => left.path.localeCompare(right.path)),
      entries.reduce((sum2, entry) => sum2 + entry.collected.unsupportedFileCount, 0)
    ));
  }
  return scans;
}
async function computeScans(inputs) {
  if (inputs.length === 0) throw new Error("At least one explicit source path is required.");
  const seen = /* @__PURE__ */ new Set();
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
    throw new Error("No supported main-session records with a human user turn were found.");
  }
  return { scans, sourceOrder };
}
function factsFromScans(scans, sourceOrder, now) {
  const bySource = {};
  sourceOrder.forEach((source2, index) => {
    bySource[source2] = metricSet(scans[index]);
  });
  const combinedScan = {
    files: scans.flatMap((scan) => scan.files),
    sessions: scans.flatMap((scan) => scan.sessions),
    parsedRecordCount: scans.reduce((sum2, scan) => sum2 + scan.parsedRecordCount, 0),
    recognizedRecordCount: scans.reduce((sum2, scan) => sum2 + scan.recognizedRecordCount, 0),
    malformedRecordCount: scans.reduce((sum2, scan) => sum2 + scan.malformedRecordCount, 0),
    skippedFileCount: scans.reduce((sum2, scan) => sum2 + scan.skippedFileCount, 0),
    unsupportedFileCount: scans.reduce((sum2, scan) => sum2 + scan.unsupportedFileCount, 0)
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
        ...inputTokens !== void 0 ? { inputTokens } : {},
        ...outputTokens !== void 0 ? { outputTokens } : {},
        ...totalTokens !== void 0 ? { totalTokens } : {}
      };
    }))
  );
  return {
    formatVersion: "cookiy.facts.v1",
    generatedAt: now.toISOString(),
    overall: metricSet(combinedScan),
    bySource,
    ...representativeCandidates ? { representativeCandidates } : {}
  };
}
async function computeFacts(inputs, now = /* @__PURE__ */ new Date()) {
  const { scans, sourceOrder } = await computeScans(inputs);
  return factsFromScans(scans, sourceOrder, now);
}
async function computeFactsWithTopicReview(inputs, now = /* @__PURE__ */ new Date()) {
  const { scans, sourceOrder } = await computeScans(inputs);
  const facts = factsFromScans(scans, sourceOrder, now);
  const sessions = scans.flatMap((scan) => scan.sessions).map((session) => ({
    internalIdentity: session.rawId,
    source: session.source,
    userMessages: session.userMessages
  }));
  const { binding, review } = createTopicReview(sessions, facts.generatedAt);
  return { facts: { ...facts, topicReview: binding }, topicReview: review };
}

// src/platform/credentials.ts
import { chmod as chmod2, mkdir, readFile as readFile5, rm as rm2, stat as stat2 } from "node:fs/promises";
import { dirname } from "node:path";

// src/platform/paths.ts
import os from "node:os";
import path from "node:path";
function credentialFilePath(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathModule = platform === "win32" ? path.win32 : path;
  if (env.COOKIY_EARN_CREDENTIALS?.trim()) return pathModule.resolve(env.COOKIY_EARN_CREDENTIALS.trim());
  const homeDir = options.homeDir ?? os.homedir();
  return pathModule.join(homeDir, ".cookiy", "earn-token.txt");
}

// src/platform/private-file.ts
import { chmod, open, rename, rm } from "node:fs/promises";
import { randomBytes as randomBytes2 } from "node:crypto";
async function writePrivateFileAtomic(destination, data, platform = process.platform) {
  const isWindows = platform === "win32";
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes2(6).toString("hex")}`;
  let handle;
  try {
    handle = await open(temporary, "wx", isWindows ? void 0 : 384);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = void 0;
    if (!isWindows) await chmod(temporary, 384);
    await rename(temporary, destination);
    if (!isWindows) await chmod(destination, 384);
  } catch (error) {
    await handle?.close().catch(() => void 0);
    await rm(temporary, { force: true }).catch(() => void 0);
    throw error;
  }
}

// src/platform/credentials.ts
var CLI_TOKEN_PATTERN = /^cky_[A-Za-z0-9_-]{50}$/;
function validateTokenShape(token) {
  return CLI_TOKEN_PATTERN.test(token);
}
async function readToken(options = {}) {
  let token;
  try {
    token = (await readFile5(credentialFilePath(options), "utf8")).trim();
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT") {
      throw new Error("Not signed in to Cookiy. First run `node <skill-directory>/scripts/cookiy-earn.js auth save` to save your login token. (ENOENT: no saved credential file)", { cause: error });
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`Could not read your Cookiy login token. Check the credential file permissions and try again. (${code})`, { cause: error });
    }
    throw error;
  }
  if (!validateTokenShape(token)) throw new Error("Please save your Cookiy login token again by running `node <skill-directory>/scripts/cookiy-earn.js auth save`. (Saved credential is malformed.)");
  return token;
}
async function saveTokenAtomic(token, options = {}) {
  if (!validateTokenShape(token)) throw new Error("Cookiy CLI tokens must be exactly 54 characters and start with cky_.");
  const destination = credentialFilePath(options);
  const directory = dirname(destination);
  const isWindows = (options.platform ?? process.platform) === "win32";
  const hasOverride = Boolean((options.env ?? process.env).COOKIY_EARN_CREDENTIALS?.trim());
  let directoryExisted = true;
  try {
    await stat2(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    directoryExisted = false;
  }
  await mkdir(directory, { recursive: true, ...isWindows ? {} : { mode: 448 } });
  if (!isWindows && (!hasOverride || !directoryExisted)) await chmod2(directory, 448);
  await writePrivateFileAtomic(destination, `${token}
`, options.platform ?? process.platform);
  return destination;
}
async function deleteToken(options = {}) {
  try {
    await rm2(credentialFilePath(options));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// src/cli.ts
var HELP = `cookiy-earn — build and submit a redacted Coding Session Data Summary

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
function ioWrite(stream, value) {
  stream.write(`${value}
`);
}
function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name && args[index + 1]) values.push(args[index + 1]);
    else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
  }
  return values;
}
function optionValue(args, name) {
  return optionValues(args, name).at(-1);
}
function positional(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--source" || arg === "--output" || arg === "--facts" || arg === "--confirm-upload" || arg === "--topic-review-output") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--source=") || arg.startsWith("--output=") || arg.startsWith("--facts=") || arg.startsWith("--confirm-upload=") || arg.startsWith("--topic-review-output=")) continue;
    if (!arg.startsWith("-")) result.push(arg);
  }
  return result;
}
function parseSources(args) {
  return optionValues(args, "--source").map((value) => {
    const equals = value.indexOf("=");
    const source2 = value.slice(0, equals);
    const path2 = value.slice(equals + 1);
    if (equals < 1 || !path2 || source2 !== "codex" && source2 !== "claude_code") {
      throw new Error("--source must use codex=<path> or claude_code=<path>.");
    }
    return { source: source2, path: path2 };
  });
}
function rejectUnknownFactsOptions(args) {
  const valueOptions = ["--source", "--output", "--topic-review-output"];
  const booleanOptions = ["--no-topic-review"];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (valueOptions.includes(arg)) {
      index += 1;
      continue;
    }
    if (valueOptions.some((option) => arg.startsWith(`${option}=`))) continue;
    if (booleanOptions.includes(arg)) continue;
    if (arg.startsWith("-")) throw new Error(`Unknown facts option: ${arg}`);
  }
}
async function readTokenFromInput(io) {
  if (!process2.stdin.isTTY || io.stdin !== process2.stdin) {
    let value = "";
    for await (const chunk of io.stdin) value += String(chunk);
    return value.trim();
  }
  const input = process2.stdin;
  io.stderr.write("Cookiy CLI token (input hidden): ");
  input.setRawMode?.(true);
  input.resume();
  input.setEncoding("utf8");
  return await new Promise((resolveInput, reject) => {
    let value = "";
    const restore = () => {
      input.setRawMode?.(false);
      input.pause();
      input.removeListener("data", onData);
    };
    const onData = (chunk) => {
      if (chunk === "") {
        restore();
        io.stderr.write("\n");
        reject(new Error("Credential input cancelled."));
      } else if (chunk === "\r" || chunk === "\n") {
        restore();
        io.stderr.write("\n");
        resolveInput(value.trim());
      } else if (chunk === "") {
        value = value.slice(0, -1);
      } else {
        value += chunk;
      }
    };
    input.on("data", onData);
  });
}
async function inspect(filePath, factsPath) {
  const absolute = resolve2(filePath);
  const content = await readFile6(absolute);
  const facts = factsPath ? await readFactsFile(resolve2(factsPath)) : void 0;
  const validation = validateMarkdownBuffer(content, facts);
  return {
    path: absolute,
    sizeBytes: content.length,
    sha256: contentHash(content),
    sources: validation.metadata.sources,
    sampleCount: validation.metadata.sampleCount,
    valid: validation.valid,
    issueCount: validation.issues.length,
    ...facts ? {
      overall: {
        sessions: facts.overall.sessionCount,
        userTurns: facts.overall.turnCount,
        toolCalls: facts.overall.toolCallCount,
        totalTokens: facts.overall.totalTokens ?? "unavailable"
      }
    } : {}
  };
}
function formatRecord(item) {
  const status = item.status === "received" ? "under review" : item.status;
  return `${item.id}	${item.sources.join("+")}	${item.sizeBytes} bytes	${status}	${item.createdAt}`;
}
async function runCli(args = process2.argv.slice(2), io = process2) {
  const [command, subcommand] = args;
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      ioWrite(io.stdout, HELP);
      return 0;
    }
    if (command === "facts") {
      rejectUnknownFactsOptions(args);
      const output = optionValue(args, "--output");
      if (!output) throw new Error("facts requires --output <facts.json>; raw session-derived content is never printed to stdout.");
      const noTopicReview = args.includes("--no-topic-review");
      const requestedReviewOutput = optionValue(args, "--topic-review-output");
      if (noTopicReview && requestedReviewOutput) {
        throw new Error("--no-topic-review cannot be combined with --topic-review-output.");
      }
      const absoluteOutput = resolve2(output);
      const absoluteReviewOutput = requestedReviewOutput ? resolve2(requestedReviewOutput) : void 0;
      if (absoluteReviewOutput && absoluteReviewOutput === absoluteOutput) {
        throw new Error("--output and --topic-review-output must use different files.");
      }
      ioWrite(io.stderr, "Privacy notice: only the summary you have reviewed and approved will be uploaded; source sessions, unselected excerpts, and other local analysis files stay on your device.");
      if (absoluteReviewOutput) {
        ioWrite(io.stderr, "Topic notice: the current Agent must review bounded, redacted user-message evidence for every Session; evidence and per-Session assignments remain local, and only aggregate Topic counts and shares may be uploaded.");
      }
      const result = !absoluteReviewOutput ? { facts: await computeFacts(parseSources(args)), topicReview: void 0 } : await computeFactsWithTopicReview(parseSources(args));
      await Promise.all([
        writePrivateFileAtomic(absoluteOutput, `${JSON.stringify(result.facts, null, 2)}
`),
        ...absoluteReviewOutput && result.topicReview ? [writePrivateFileAtomic(absoluteReviewOutput, `${JSON.stringify(result.topicReview, null, 2)}
`)] : []
      ]);
      const facts = result.facts;
      ioWrite(io.stdout, `Wrote local facts: ${resolve2(output)}`);
      if (absoluteReviewOutput) ioWrite(io.stdout, `Wrote private Topic review: ${absoluteReviewOutput}`);
      ioWrite(io.stdout, `Private representative candidates: ${facts.representativeCandidates?.length ?? 0} (maximum 8)`);
      ioWrite(io.stdout, `Sources: ${Object.keys(facts.bySource).join(", ")}; sessions: ${facts.overall.sessionCount}; files: ${facts.overall.fileCount}`);
      return 0;
    }
    if (command === "topics" && subcommand === "apply") {
      const [factsPath, topicReviewPath] = positional(args.slice(2));
      const output = optionValue(args, "--output");
      if (!factsPath || !topicReviewPath || !output) {
        throw new Error("topics apply requires <base-facts.json> <topic-review.json> --output <classified-facts.json>.");
      }
      const [facts, topicReview] = await Promise.all([
        readFactsFile(resolve2(factsPath)),
        readTopicReviewFile(resolve2(topicReviewPath))
      ]);
      const classified = applyTopicReview(facts, topicReview);
      await writePrivateFileAtomic(resolve2(output), `${JSON.stringify(classified, null, 2)}
`);
      ioWrite(io.stdout, `Wrote local classified facts: ${resolve2(output)}`);
      ioWrite(io.stdout, `Method: ${classified.topicClassification.method}; reviewed Sessions: ${classified.topicClassification.reviewedSessionCount}`);
      return 0;
    }
    if (command === "render") {
      const [factsPath] = positional(args.slice(1));
      const output = optionValue(args, "--output");
      if (!factsPath || !output) throw new Error("render requires <facts.json> --output <draft.md>.");
      const facts = await readFactsFile(resolve2(factsPath));
      if (facts.topicReview && !facts.topicClassification) {
        throw new Error("The explicitly requested Topic review has not been applied. Classify every Session and run topics apply, or regenerate facts with --no-topic-review.");
      }
      await writePrivateFileAtomic(resolve2(output), renderDataSummary(facts));
      ioWrite(io.stdout, `Wrote local Data Summary draft: ${resolve2(output)}`);
      ioWrite(io.stdout, "Redact and manually review this draft before validation or upload.");
      return 0;
    }
    if (command === "redact") {
      const [input] = positional(args.slice(1));
      const output = optionValue(args, "--output");
      if (!input || !output) throw new Error("redact requires <input.md> --output <redacted.md>.");
      const source2 = await readFile6(resolve2(input), "utf8");
      const result = redactRepresentativeSamples(source2);
      await writePrivateFileAtomic(resolve2(output), result.text);
      ioWrite(io.stdout, `Wrote redacted Markdown: ${resolve2(output)}`);
      ioWrite(io.stdout, `Redactions: ${Object.values(result.redactions).reduce((sum2, count) => sum2 + count, 0)}`);
      return 0;
    }
    if (command === "validate") {
      const [file] = positional(args.slice(1));
      if (!file) throw new Error("validate requires <summary.md>.");
      const factsPath = optionValue(args, "--facts");
      const facts = factsPath ? await readFactsFile(resolve2(factsPath)) : void 0;
      const result = await validateMarkdownFile(resolve2(file), facts);
      if (args.includes("--json")) ioWrite(io.stdout, JSON.stringify(result, null, 2));
      else {
        ioWrite(io.stdout, result.valid ? `Valid Data Summary (${result.sizeBytes} bytes).` : `Invalid Data Summary: ${result.issues.length} issue(s).`);
        for (const item of result.issues) ioWrite(io.stdout, `${item.code} at ${item.line}:${item.column} — ${item.message}`);
      }
      return result.valid ? 0 : 2;
    }
    if (command === "inspect") {
      const [file] = positional(args.slice(1));
      if (!file) throw new Error("inspect requires <summary.md>.");
      const result = await inspect(file, optionValue(args, "--facts"));
      if (args.includes("--json")) ioWrite(io.stdout, JSON.stringify(result, null, 2));
      else Object.entries(result).forEach(([key, value]) => ioWrite(io.stdout, `${key}: ${Array.isArray(value) ? value.join(", ") : value !== null && typeof value === "object" ? JSON.stringify(value) : String(value)}`));
      return result.valid ? 0 : 2;
    }
    if (command === "auth" && subcommand === "save") {
      const token = await readTokenFromInput(io);
      if (!validateTokenShape(token)) throw new Error("Cookiy CLI tokens must be exactly 54 characters and start with cky_.");
      await new CookiyApiClient().verifyToken(token);
      const savedAt = await saveTokenAtomic(token);
      ioWrite(io.stdout, `Credential verified and saved to ${savedAt}`);
      if (process2.platform === "win32") ioWrite(io.stdout, "The plaintext file relies on your Windows user-profile ACL; it is not stored in Windows Credential Manager.");
      return 0;
    }
    if (command === "auth" && subcommand === "logout") {
      const deleted = await deleteToken();
      ioWrite(io.stdout, deleted ? `Deleted credential file: ${credentialFilePath()}` : "No saved Cookiy Earn credential was found.");
      return 0;
    }
    if (command === "upload") {
      const [file] = positional(args.slice(1));
      if (!file) throw new Error("upload requires <summary.md>.");
      const approvedHash = optionValue(args, "--confirm-upload");
      if (!approvedHash || !/^[a-f0-9]{64}$/.test(approvedHash)) throw new Error("Upload blocked: --confirm-upload requires the full SHA-256 shown by inspect.");
      const markdown = await readFile6(resolve2(file));
      if (contentHash(markdown) !== approvedHash) throw new Error("Upload blocked: the file has changed since consent was obtained. Inspect it and ask again.");
      const factsPath = optionValue(args, "--facts");
      const facts = factsPath ? await readFactsFile(resolve2(factsPath)) : void 0;
      const validation = validateMarkdownBuffer(markdown, facts);
      if (!validation.valid) throw new Error(`Upload blocked: Markdown validation found ${validation.issues.length} issue(s).`);
      const token = await readToken();
      const result = await new CookiyApiClient().upload(markdown, token);
      ioWrite(io.stdout, JSON.stringify(result, null, 2));
      return 0;
    }
    if (command === "list") {
      const token = await readToken();
      const result = await new CookiyApiClient().list(token);
      if (result.nextCursor) ioWrite(io.stderr, "More submissions exist; this V1 command displays only the first page.");
      if (args.includes("--json")) ioWrite(io.stdout, JSON.stringify(result, null, 2));
      else if (result.items.length === 0) ioWrite(io.stdout, "No Data Summary submissions found.");
      else result.items.forEach((item) => ioWrite(io.stdout, formatRecord(item)));
      return 0;
    }
    throw new Error(`Unknown command.

${HELP}`);
  } catch (error) {
    const safeMessage = error instanceof CookiyApiError || error instanceof Error ? error.message : "Unexpected error.";
    ioWrite(io.stderr, `Error: ${safeMessage}`);
    return 1;
  }
}
if (process2.argv[1] && basename(process2.argv[1]) === "cookiy-earn.js") process2.exitCode = await runCli();
export {
  runCli
};
