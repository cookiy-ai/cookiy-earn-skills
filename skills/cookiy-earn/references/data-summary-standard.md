# Cookiy Data Summary v1

The upload artifact is exactly one UTF-8 Markdown file, no larger than 16,777,216 bytes. It combines aggregate statistics with 1–3 redacted, facts-bound representative cards whenever a safe candidate is available. Full dialogue, the candidate pool, local paths, raw Session identifiers, per-Session Topic labels, and behavioral classifications remain outside the V1 scope.

Start from the deterministic draft produced by:

```text
node <skill-directory>/scripts/cookiy-earn.js render report-facts.json --output draft.md
```

Use the `report-facts.json` produced directly by `facts`. The draft uses `cookiy.data-summary.v1`, is checked against the contents of a strictly validated local `cookiy.facts.v1` artifact, and starts with `privacy_reviewed: false`. Do not edit the generated statistics section. Re-run `render` when facts change.

The local facts artifact contains aggregate metrics plus at most eight candidates with no more than five redacted, 280-code-point opening, middle, or closing excerpts each and report-local references. Facts never contain source paths or raw Session identifiers. Facts are never uploaded.

## Required structure

The headings below must each occur exactly once and in this order:

1. `Coding Session Data Summary`
2. `Executive Summary`
3. `Why This Data Is Valuable`
4. `Key Highlights`
5. `Descriptive Statistics`
6. `Overall`
7. `By Source`
8. `Representative Session Samples`

Documents cannot contain Markdown links, images, reference links, URI destinations, attachments, HTML, or fenced code blocks. These conservative restrictions keep the upload surface small and make validation fail closed without a general-purpose Markdown renderer.

## Representative sample cards

Use three consecutively numbered cards when at least three candidates pass the final sensitive-information and evidence-binding checks; otherwise use every passing candidate. Rank passing candidates with the local-only rubric in [representative-session-samples.md](representative-session-samples.md) and use the highest-value candidates. Do not use genericity, narrow scope, amount of operational detail, perceived relative value, or overlap with another candidate as exclusion criteria. Keep the placeholder only when every candidate has a concrete privacy, translation, or evidence-binding blocker:

```text
### Example 1. Generalized task title

| Field | Value |
| --- | --- |
| Evidence ref | candidate-01 |
| Source | Codex |
| Model | unavailable |
| Session type | agentic |
| Total tokens | unavailable |
| User turns | 4 |

**Tags:** testing, debugging, tool-use

**Context:** Evidence-backed, non-identifying context.

**Workflow and outcome:** Supported actions and result, or an explicit unavailable outcome.

**Why it is valuable:** Supported training, evaluation, or research value.

**Data-governance note:** What was removed, generalized, and manually reviewed.

**Representative quote:**

> User: A candidate excerpt with optional sensitive spans replaced by [REDACTED].
```

Model and Total tokens must be `unavailable` when absent. Source, model, Session type, total tokens, user turns, and every quote must come from the same candidate. An English original may match its candidate excerpt exactly or replace one or more non-empty sensitive spans with the literal `[REDACTED]`; all other text and ordering must remain unchanged, and meaningful visible text must remain. Use 3–6 comma-separated tags. For a non-English candidate excerpt, the report must omit the original and show only a faithful English translation with the same role and a `(role, translated)` suffix. Card titles and narratives must not expose identifying details or make unsupported claims.

## Statistics

The generated section reports deduplicated source files and bytes, time coverage, main Sessions, semantic messages, human user turns, tool calls, parsed/recognized/malformed record coverage, and tokens for Sessions with complete token data. It reports p50, p95, mean, and max for turns, tool calls, and available per-Session tokens.

Codex `response_item` messages are canonical per role. Codex `event_msg` user/agent messages fill only a missing user or assistant role, so mixed logs retain a role without counting dual representations twice. Claude Code tool results, metadata records, sidechains, and records carrying a subagent identifier are excluded from human-turn counts. A Session must contain at least one semantic human turn to be included.

Token aggregates include only Sessions with complete input and output token counts. Coverage counts and distribution sample sizes disclose how many Sessions contribute to those aggregates.

The facts reader verifies types, non-negative integer domains, message and token arithmetic, coverage counts, distribution sample sizes, time ranges, allowed fields, Overall/By Source aggregation, candidate bounds and safety. Markdown validation binds all generated content and every sample metadata table to the facts artifact. Only editable Sample titles, tags, narratives, and quotes are scanned for sensitive content. English originals must be exact or derived only through `[REDACTED]` span replacement, and translated-role quotes must bind to non-English candidate excerpts. Translation fidelity is confirmed during manual privacy review.

## Validation

After deterministic redaction and manual review, change `privacy_reviewed` to `true`, then validate with the exact local facts file:

```text
node <skill-directory>/scripts/cookiy-earn.js validate summary.md --facts local-facts.json
```

Fix every reported issue and validate again after every edit.
