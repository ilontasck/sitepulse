# Application and API

Current implementation: HTML/CSS/JS frontend, Node 24 HTTP API, SQLite, persisted queue and separate worker. NOQORI remains the UI brand. See [setup](LOCAL-DEVELOPMENT.md), [status](SOURCE-OF-TRUTH.md) and [security](SECURITY-REVIEW.md).

- `POST /api/auth/register`, `/login`, `/logout`; `GET /api/auth/me`, `/config`. Closed registration by runtime default; the local env example explicitly opts into public registration.
- Password-reset request/confirm and email-verification request/confirm APIs plus frontend forms. Hashed one-time tokens; actual delivery requires a configured provider adapter. The stock entrypoint has none.
- `POST /api/audits` accepts a public URL, requires a session and trusted Origin, returns 202 and an owner-scoped job URL. Poll `GET /api/audit-jobs/:id`, then fetch `GET /api/audits/:id`.
- `/api/audits/history` and `/api/audits/quota` expose the owner's history/quota. Free: 3 accepted audits per UTC calendar month; internal pro: 25. Terminal failures refund once; deleting a successful report does not refund. Billing and self-service plan switching are absent.
- Owner-scoped report deletion and password-confirmed account deletion: [STE-31 contract](RETENTION-DELETION.md). Report delete/repeat UI exists; self-service account deletion UI does not.
- `/api/operations` and related failed-job/retry/log routes require `X-Admin-Key`. `/admin` is an operator UI; access to the page alone grants no API rights. Store the key only in private deployment configuration.
- API liveness/readiness: `/api/health`, `/api/ready`. Worker health: loopback port 3001. Operational scheduling, alert delivery and backups require server setup.

## Scanning

HTML checks cover SEO, accessibility heuristics, performance hints, security headers and report recommendations. They are not a comprehensive accessibility/security audit. Rendered Lighthouse is optional; TBT is a lab proxy, not INP. Failed non-safety HTML scans may produce an explicitly marked fallback, so check scanner mode instead of treating every report as a successful live scan.

HTML transport validates DNS both at the policy boundary and at the socket lookup, rejects private addresses, manually checks every redirect, and bounds body size/time. Chromium networking still requires the Linux kernel sandbox. Fresh profiles and request interception alone are insufficient.

## Architecture references

[Authentication design](AUTH_ARCHITECTURE.md) and [queue design](ASYNC_AUDIT_ARCHITECTURE.md) preserve detailed historical decisions. Their original deferred-feature lists are historical; this document and the current code describe shipped behavior.
