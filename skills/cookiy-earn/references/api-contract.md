# Cookiy API and credentials

Read this only for authentication, upload, or history listing.

The bundled CLI uses `https://cash-panel-api.cookiy.ai/api`. `COOKIY_API_URL` may select only that production URL or an HTTP(S) loopback server for local tests. URLs containing userinfo, a query, or a fragment are rejected; this override never bypasses validation, consent, or authentication.

## Credentials

When authentication is needed and the user has no saved token, or the service rejects the token as invalid or expired, automatically open `https://earn.cookiy.ai/cli-token` in the user's browser using the available browser tool or OS URL opener. Let the user complete sign-in and obtain a CLI token on that page, then guide them to enter it through `auth save`'s hidden terminal input. If the browser cannot be opened, provide the link for the user to open manually. Do not ask the user to paste the token into chat. This setup is only needed for authentication, upload, or history listing; local summary generation remains login-free.

`auth save` accepts a 54-character `cky_` token from hidden terminal input or stdin, validates it through `GET /auth/cli-token/me`, and only then saves it atomically. Never put a token in command arguments.

The default plaintext file is `<home>/.cookiy/earn-token.txt`; `COOKIY_EARN_CREDENTIALS` overrides it. Unix-like systems restrict the default Cookiy-owned directory to `0700` and the file to `0600`; an existing override parent retains its current mode. Windows relies on inherited user-profile ACLs; this is not Windows Credential Manager. WSL uses its own Linux home. Uninstalling the Skill does not delete this file; `auth logout` deletes only it.

Never print a full token, raw dialogue, object key, bucket name, or internal storage URL. The locally computed full summary SHA-256 is intentionally displayed so the user can consent to an exact version.

## Upload

`upload <summary.md> --facts <local-facts.json> --confirm-upload <full-sha256>` reads the Markdown once, requires its full SHA-256 to equal the exact value shown before consent, validates those same immutable bytes against the local facts, and sends those bytes through `POST /data-summaries` as multipart form data with exactly one Markdown `file` and no additional form fields. Consent is enforced locally by the exact SHA-256 confirmation. The facts JSON is never uploaded. The same hash is sent as `Idempotency-Key`; the current backend independently hashes the file bytes and deduplicates by account plus content hash. Network/5xx failures are retried; authentication, consent, size, and validation errors are not.

The public success fields are `id`, `sources`, `sizeBytes`, `status`, `createdAt`, and `duplicate`. A duplicate is a successful content-level idempotent result, not a new record.

## History

`list` calls `GET /data-summaries` and exposes only `id`, `sources`, `sizeBytes`, `status`, and `createdAt`. `received` is displayed as `under review`. V1 displays the first page and explicitly reports when `nextCursor` indicates that more submissions exist. It does not edit or delete submissions.
