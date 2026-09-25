# STE-31: retention and deletion contract

Verified against STE-31 `166c3f8e1d08a2f384cc4e599e3322be39a4b744` and selected descendant `6ada04e831fc6dd5fd7c729268886e2c116cb434`. STE-31 is present; no transfer from an unavailable branch is needed.

## Account deletion

`DELETE /api/auth/account` requires an active session, the exact trusted Origin, JSON content type and `{ "password": "current password" }`. There is **no backend confirmation-string/token requirement**. A future UI should ask for confirmation without inventing an API field.

Success: 204 and cleared session cookie. Wrong password: 401. Missing session: 401. Missing/untrusted Origin: 403. Invalid body/content type: 400/415. Password attempts are now capped per account using `AUTH_LOGIN_EMAIL_RATE_LIMIT_MAX` over `AUTH_LOGIN_RATE_LIMIT_WINDOW_MS` in addition to the general auth limiter; excess: 429.

The transaction disables the account, records deletion request/purge eligibility, revokes sessions, invalidates unused reset/verification tokens and cancels pending notifications. Login and owner reads stop immediately. Pending/running work cannot publish a report for the disabled owner; computation already running may finish but persistence is fenced. Physical erasure is a later cleanup operation.

The existing code sets `purge_after` to **request + 29 days**, leaving room for the existing 30-day completion target. Cleanup starts with the API and repeats every six hours by default, selecting up to 100 entries per category. It removes user jobs/reports before the user; token/session/outbox rows cascade. A stopped service, failed cleanup or backlog can miss the target: monitor cleanup and verify the deadline on the deployed server. No new retention policy was selected in this review.

## Reports and remaining data

`DELETE /api/audits/:id` is owner-only and requires trusted Origin. It hides the report immediately; physical deletion and linked-job removal occur in bounded cleanup. Another user's report/job reads/deletes return 404; anonymous requests return 401.

Free reports expire after 30 days; the later internal pro policy expires after 12 calendar months. Expiry hides the report immediately. Physical deletion follows scheduled cleanup, potentially over multiple batches. Do not promise deletion by the next run when a backlog exists.

Important unresolved scope: terminal failed jobs without reports have no age-based purge for active accounts. Reset-token rows expire for authentication after one hour, but have no independent physical cleanup while an account remains active. Backups, WAL/free pages, reverse-proxy/provider logs and email-provider records are outside application-row deletion. Account purge deletes associated token records, but SQL row deletion is not a forensic secure-erase guarantee.

These gaps need an owner-approved policy and implementation before external personal data is collected. Do not silently invent durations. The draft legal pages must match the final chosen policies, including any pro plan enabled for users.

## Evidence and operations

Unit/API tests cover wrong passwords, Origin/session checks, ownership, expiry, batching, FK safety, lease races and cascade deletion. `e2e/beta-lifecycle.spec.mjs` covers a real browser, auth API, SQLite, queue/worker, generated report, print CSS, cross-user denial, account disablement and physical purge with an advanced test clock. The external site's HTML/DNS are controlled fixtures; this is not a server sandbox acceptance test.

Self-service account deletion UI is still absent. Before inviting users, provide a tested operator-assisted process with identity verification or add and test the UI. Never ask users to send their password to support. Legal/request handling and backups require an operator, not only an API endpoint.
