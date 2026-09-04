# Representative Session Samples

Representative samples are part of the default report. Before reading session files, tell the user: “The summary includes selected short excerpts with sensitive details removed. Only the summary you have reviewed and approved will be uploaded; source sessions, unselected excerpts, and other local analysis files stay on your device.” Deterministic redaction is not proof of anonymity.

Generate the private pool locally:

```text
node <skill-directory>/scripts/cookiy-earn.js facts --source codex=<confirmed-path> --source claude_code=<confirmed-path> --output local-facts.json
```

The script uses ordered semantic main-session messages, excludes tool parameters/results, shell output, metadata, sidechains, subagents, system content, and unsupported content, then removes Markdown resources and code blocks, redacts, and truncates each candidate excerpt to 280 Unicode code points. For a Session with at least three user turns, it adds one middle interaction window around an internal user turn, preferring direct assistant context on both sides and then greater safely normalized text length. The candidate keeps at most five excerpts total. The candidate pool contains at most eight report-local references and remains local.

Review every candidate. Generated candidates are presumptively usable. Do not reject one merely because its content is generic, narrowly scoped, operational, detail-heavy, lower-value than another candidate, or similar to another candidate. This is a draft selection followed by validation, user review, and exact-version upload consent.

Skip a candidate only for a concrete blocker: sensitive or identifying content cannot be removed without leaving too little meaningful text; no excerpt can be safely and faithfully quoted or translated; or the proposed card cannot be supported by that candidate alone. The presence of internal-looking implementation, product, data-model, authentication, testing, or operational details is not by itself a blocker. Replace only the actually sensitive spans—such as a person, customer, private project or repository, branch, pull request, internal identifier, non-public business fact, creative work, or unusual credential—with the literal `[REDACTED]`; retain the rest when the card remains meaningful.

Rank every passing candidate with this local-only value rubric; do not write scores or per-candidate classifications into the Markdown:

- **Long-horizon work, 0–3:** reward sustained, multi-stage progress evidenced by user turns, messages, tool feedback loops, and the opening-to-closing span. A long wall-clock span alone is weak evidence because it may contain idle time.
- **Correction and adaptation, 0–4:** reward a user correcting an AI assumption, result, or approach followed by a relevant AI adjustment. A new request or additive requirement alone is not a correction.
- **Collaboration richness, 0–4:** reward substantive iterative human–AI work, coordination among people represented safely in the main conversation, or AI delegation/review/synthesis that is explicitly evidenced in retained main-session text. Do not infer collaboration from excluded sidechains, tool data, or missing context.
- **Outcome and verification, 0–3:** reward a concrete result, test, build, reproduction, review finding, or clearly stated handoff. Do not invent an outcome when the evidence ends earlier.

Select the three highest totals, or every passing candidate when fewer than three pass. Use clearer evidence and then source, Session-type, or workflow diversity only as tie-breakers. There is no minimum value score: fill the available sample slots after the privacy and evidence-binding checks pass.

Each selected card must use the exact structure in [data-summary-standard.md](data-summary-standard.md). Generalize the title, use 3–6 evidence-supported tags, and keep every metric, narrative, and quote bound to one `evidenceRef`. Do not estimate missing values. An English original must either match a candidate excerpt after whitespace normalization or differ only by replacing one or more non-empty sensitive spans with `[REDACTED]`; do not paraphrase, reorder, or add text. For a non-English candidate excerpt, omit the original from the report and include only a faithful English translation carrying the same role marker and `(user, translated)` or `(assistant, translated)`. The non-English original remains only in the private facts artifact for evidence binding.

If no candidate passes the concrete privacy and evidence-binding checks, keep the Representative Session Samples section and state that none were included. Never synthesize a quote, derive claims from value scores alone, or upload the facts file.
