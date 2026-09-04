# Cookiy Earn Skill

Turn your Codex or Claude Code sessions into an English summary with activity statistics and selected examples. Review it and choose whether to share it with Cookiy.

The Skill does not upload full session history, does not call a Cookiy-hosted LLM, and does not require login for local generation. Uploading a summary does not guarantee income; any later purchase of complete data requires separate consent.

## Install

Install the skill directly from the `main` branch:

```sh
npx skills add https://github.com/cookiy-ai/cookiy-earn-skills/tree/main/skills/cookiy-earn --global
```

Use `--agent codex` or `--agent claude-code` when a targeted install is preferable; otherwise let `skills` detect supported agents interactively. Update and uninstall through the same `skills` CLI. Uninstalling does not remove the saved Cookiy credential; use `cookiy-earn auth logout` for that separate action.

Desktop clients that cannot run `npx skills` can download the [main branch ZIP](https://github.com/cookiy-ai/cookiy-earn-skills/archive/refs/heads/main.zip), extract it, and import the `skills/cookiy-earn/` directory inside the extracted repository through the client's native Skill importer.

## Use

After installation, say to Codex or Claude Code:

> Use the cookiy-earn skill to generate a summary of my local Codex or Claude Code sessions.

The agent generates the summary locally and guides you through reviewing it. You can choose whether to upload it to Cookiy; you do not need to run the scripts manually.

## What gets installed

`skills/cookiy-earn/` is self-contained. Its bundled JavaScript needs Node.js 20 or newer and has no runtime npm dependencies.

## What it produces

- One English Markdown Data Summary with deterministic aggregate statistics, distributions, Key Highlights, and up to three bounded, redacted representative samples.
- Private local supporting files: a facts JSON file containing a candidate pool of up to eight representative samples. These files are never uploaded.
- A validated final summary identified by its file checksum (SHA-256). Only the exact Markdown version you reviewed and approved can be uploaded; source sessions, unselected excerpts, and other local analysis files stay on your device.

CLI help is available after installation with:

```sh
node /path/to/cookiy-earn/scripts/cookiy-earn.js --help
```

## Credentials

When upload or history listing requires sign-in, the agent automatically opens [the Cookiy CLI token page](https://earn.cookiy.ai/cli-token) so you can sign in and obtain a token, then guides you through saving it with `auth save`. If it cannot open a browser, it provides the link instead. Enter the token in the hidden terminal prompt, not in chat.

`auth save` reads the 54-character Cookiy CLI token from hidden input (or stdin), verifies it, and atomically saves it to `<home>/.cookiy/earn-token.txt`. Set `COOKIY_EARN_CREDENTIALS` to override the path.

On macOS and Linux the default Cookiy-owned directory is mode `0700` and the file is `0600`. An existing parent directory supplied through `COOKIY_EARN_CREDENTIALS` keeps its current mode. On Windows the token is a plaintext file protected only by the inherited user-profile ACL; it is not stored in Windows Credential Manager. WSL uses its own Linux home.

Never pass the token as a command-line argument.

## Development

This repository is private as an npm package. The self-contained skill is distributed directly from the GitHub `main` branch.

```sh
pnpm install
pnpm build
pnpm verify
pnpm smoke:install
```

`pnpm build` bundles TypeScript into `skills/cookiy-earn/scripts/cookiy-earn.js`. `pnpm verify` type-checks, runs deterministic and local HTTP-stub tests, and proves that the committed bundle matches the TypeScript source. `pnpm smoke:install` uses the pinned `skills@1.5.23` CLI to exercise Codex and Claude Code install, repeat install, update, discovery, execution, and uninstall in temporary workspaces.

Before merging changes into `main`, run the checks above and commit any updated bundle alongside its source changes.

## Supported platforms

Core tests and installation smoke tests are intended to run on Windows, macOS, and Linux. The implementation uses Node standard APIs rather than Bash or other POSIX-only runtime commands.
