# Privacy, redaction, and consent

The final Markdown normally includes 1–3 representative cards using excerpts from a private pool of at most eight redacted candidates. A selected quote may replace additional sensitive spans with the literal `[REDACTED]`, but cannot otherwise alter the candidate text. The facts file, unselected candidates, bounded Topic evidence, and per-Session assignments remain local. Before upload, the current Agent checks selected samples for identifying or sensitive information; this is what `privacy_reviewed` records. Deterministic validation helps but cannot prove that arbitrary text is anonymous and safe.

Representative Session Sample titles, narratives, tags, and quotes must not contain:

- Cookiy CLI tokens, API keys, bearer or Basic credentials, JWTs, cloud credentials, private keys, passwords, cookies, credential-bearing URIs, or environment-variable values;
- emails, phone numbers, IPv4 or IPv6 addresses, secrets in URL query parameters, raw local Session identifiers, usernames, or absolute local paths;
- full source dialogue, candidate excerpts not selected into a validated sample card, per-Session Topic labels or references, or behavioral classifications;
- Markdown links, images, URI destinations, HTML, embedded content, or fenced code blocks;

All content outside Representative Session Samples is generated from the local facts artifact and must remain unchanged. Sample metadata tables are facts-bound and are not altered by redaction. The validator rejects invalid UTF-8, duplicate or reordered required sections, changed generated content, or content over 16 MiB.

Use:

```text
node <skill-directory>/scripts/cookiy-earn.js redact draft.md --output summary.md
node <skill-directory>/scripts/cookiy-earn.js validate summary.md --facts local-facts.json --json
node <skill-directory>/scripts/cookiy-earn.js inspect summary.md --facts local-facts.json
```

Redaction writes a separate private local file and processes only editable Sample content; facts-bound Sample metadata tables and all generated content outside the Sample section remain unchanged. Review Sample content for project/customer identifiers, internal business facts, personal or creative content, unusual credential formats, and narratives that exceed the evidence. Confirm that every card uses one evidence reference and that every translation is faithful. Set front-matter `privacy_reviewed` to `true` only after deterministic checks and manual review are complete. Revalidate after every edit.

Before upload, display the exact path, byte size, full SHA-256 (explain it as a file checksum identifying this version), sources, final sample count, high-level overall statistics, and the sentence: “Only the summary you have reviewed and approved will be uploaded; source sessions, unselected excerpts, and other local analysis files stay on your device.” Ask whether the user consents to upload this summary to Cookiy now, identifying the exact version by its full file checksum.

Consent applies to one SHA-256 and one upload invocation. If the file changes, inspection produces a different hash and the upload command rejects the earlier consent value. Do not interpret silence, an ambiguous reply, or an earlier request to generate or submit as consent. Any later request for full Session data requires separate consent.
