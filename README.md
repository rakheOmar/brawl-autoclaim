# Brawl Stars daily gift

A small Bun CLI that attempts to claim the known daily free offer from the Supercell **web store**. It does not log in or claim in-game shop rewards. There are no runtime dependencies; TypeScript and Bun type definitions are development dependencies.

## Setup

1. Install Bun and run `bun install --frozen-lockfile`.
2. Sign in to the [Supercell Store](https://store.supercell.com/en/brawlstars). In browser developer tools, use the Network tab to inspect a store request's Cookie header.
3. Copy `.env.example` to `.env` and set `SESSION_COOKIE`, `SC_STORE_Q` (the cookie named `sc-store-q`), and `SCSO_SCID` (the cookie named `scsso_scid`). `NEXT_LOCALE` defaults to `en`. Bun loads `.env` locally.
4. Run `bun run status` to check discovery without claiming, then `bun run claim` to claim.

Cookies are credentials: don't share them, paste them into issues, or commit `.env`. They expire and must be refreshed manually.

## GitHub Actions

1. On the repository page, select **Fork**, choose your account, and create the fork. You can instead create a private repository containing this project if you prefer; GitHub forks may not offer the privacy settings you want.
2. Sign in to the Supercell Store and obtain your own cookie values as described in [Setup](#setup). Never commit them or share them.
3. In your repository, open **Settings → Secrets and variables → Actions → New repository secret**. Create `SESSION_COOKIE`, `SC_STORE_Q`, and `SCSO_SCID` using the corresponding cookie **values**, not the entire Cookie header. Secrets are not copied from the original repository when you fork.
4. Open the **Actions** tab and enable workflows if GitHub prompts you to. Select **Claim daily gift**, then **Run workflow** to test it. Check the run logs for the result.
5. The `10 8 * * *` cron in `.github/workflows/claim.yml` runs at 08:10 UTC (1:40 PM IST), ten minutes after the configured 1:30 PM IST reset. Adjust it for your preferred time if needed.
6. The workflow runs on the `main` branch. If your default branch differs, update the job's branch condition. Scheduled workflows must be present on the default branch.

Scheduled Actions can be delayed or dropped; neither exact timing nor a daily run is guaranteed. Check runs periodically and refresh expired secrets manually. GitHub may disable scheduled workflows in inactive public repositories. The claim workflow doesn't upload artifacts or print request/response bodies. Use a private repository if run metadata and logs should not be public.

## Checks

Run `bun run typecheck` and `bun test` locally. Tests use synthetic fixtures and do not access the store or require secrets.

## Exit codes

Logs are JSON lines and distinguish success, uncertain outcomes, and HTTP failures without printing response bodies or credentials.

| Code | Meaning |
| --- | --- |
| 0 | Status succeeded, or all claims were reported as claimed or likely already claimed. |
| 2 | Invalid command or missing/invalid cookie configuration. |
| 3 | Store request failed, timed out, or returned an HTTP error. |
| 4 | Session could not be verified from the store page. |
| 5 | No recognized daily offer was found. |
| 6 | A claim was rejected with HTTP 400 or 409; the reason is unknown. |
| 7 | A claim's outcome is uncertain, including a timeout or unexpected response. |

For multiple offers, all are attempted and the first failure code is returned. A failed or timed-out claim is never automatically retried because it may already have been processed.

## Limitations

The offer SKU pattern and API are based on an observed, reverse-engineered store flow. The script finds all distinct SKUs matching that one known daily-free pattern; it cannot guarantee discovery of other free offers or future formats. An empty successful claim response is treated as likely already claimed, but this is a heuristic, not confirmation. HTTP 400/409 responses remain ambiguous failures. The script still sends the claim request because it cannot reliably detect a previously claimed offer from the page. A live claim has been reported successful, but store-side changes, access restrictions, or expired cookies can still break the script.
