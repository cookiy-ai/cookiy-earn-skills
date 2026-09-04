---
name: cookiy-earn
description: Generate and, only after exact-version consent, submit an English Cookiy Data Summary with bounded, redacted representative samples from local Codex or Claude Code session history. Use when a user wants to summarize these coding histories for Cookiy; do not use for unrelated exports or raw-history uploads.
---

# Cookiy Earn

Create one Markdown summary with aggregate statistics and representative excerpts. Never upload full session history, the candidate pool, Topic evidence, or per-Session classifications.

Before reading session files, tell the user:

- Only the summary you have reviewed and approved will be uploaded; source sessions, unselected excerpts, and other local analysis files stay on your device.
- Local generation does not require a Cookiy login.
- Uploading a summary does not guarantee income.
- Any later purchase of full data requires separate consent.

## Workflow

1. Discover likely Codex and Claude Code history locations from the current OS and installed tools. Treat common locations only as clues. Verify file content before declaring a source, read sources without changing them, and pass only confirmed paths to the script.
2. Read [references/representative-session-samples.md](references/representative-session-samples.md), make its disclosure, then build facts once with `node <skill-directory>/scripts/cookiy-earn.js facts --source codex=<confirmed-path> --source claude_code=<confirmed-path> --output <report-facts.json>`, omitting absent sources. This stage is local-only and must not require a token.
3. Read [references/data-summary-standard.md](references/data-summary-standard.md), then run `render <report-facts.json> --output <draft.md>`. Review every private candidate. Apply the concrete privacy and evidence-binding checks first, then use the reference's local-only value rubric to rank every passing candidate and include the highest-value three, or every passing candidate when fewer than three are available. Scores have no eligibility threshold and never enter the Markdown. Treat each generated candidate as presumptively usable: generic content, narrow scope, operational detail, or similarity to another candidate is not by itself a reason to skip it. Use the no-samples placeholder only when none passes. Copy English quotes from one candidate; for a non-English excerpt, include only a faithful English translation with the required translated-role marker and omit the original from the report. You may replace sensitive spans in English originals with the literal `[REDACTED]`, but must not otherwise alter or invent quote text. Never mix evidence references or add per-Session Topic labels, behavioral classifications, links, images, HTML, or fenced code blocks. Keep the generated Key Highlights and statistics section unchanged.
4. Read [references/privacy-and-consent.md](references/privacy-and-consent.md). Run `redact <draft.md> --output <summary.md>`; this redacts only editable Representative Session Sample content and leaves fact-bound metadata and all generated report content unchanged. Then check the selected samples for names, project or customer details, paths, credentials, and unsupported claims. This upload-safety check is the privacy review. When it passes, change front-matter `privacy_reviewed` to `true` and run `validate <summary.md> --facts <report-facts.json>`; fix every issue and validate again.
5. Run `inspect <summary.md> --facts <report-facts.json>` and show the user the exact final path, byte size, full SHA-256 (explain it as a file checksum identifying this version), sources, sample count, and overall statistics. Tell the user: “Only the summary you have reviewed and approved will be uploaded; source sessions, unselected excerpts, and other local analysis files stay on your device.”
6. Stop and ask for explicit consent to upload the exact file identified by that full SHA-256. The original generate/submit request is not consent for this step. A refusal or ambiguity causes no network call.
7. Only after explicit consent for this upload, read [references/api-contract.md](references/api-contract.md). If the user is not signed in, follow its browser-based token setup and run `auth save`; then run `upload <summary.md> --facts <report-facts.json> --confirm-upload <full-sha256>`, using exactly the hash shown before consent. Never add the confirmation value before consent.

Use `list` when the user asks for their Cookiy Data Summary history. It requires authentication; read [references/api-contract.md](references/api-contract.md) and follow its browser-based token setup if the user is not signed in. It displays only public submission metadata and reports when the service has more than the first V1 page.

If no supported data exists, a format cannot be parsed, or high-risk secrets remain, report that clearly and end safely. Do not call Cookiy to generate, analyze, redact, or repair content.
