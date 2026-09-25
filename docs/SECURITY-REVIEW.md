# Security review — 2026-09-25

Scope: selected descendant of STE-31, local Mac code review and tests. This is a bounded review, not a penetration-test certificate or a claim of invulnerability. [Release status](SOURCE-OF-TRUTH.md) / [blockers](BETA-READINESS.md).

## Confirmed and fixed

1. **HTML DNS rebinding:** policy validation resolved a public IP, then native fetch independently resolved the hostname when connecting. A regression with a controlled resolver and a private local HTTP server failed before the fix (the fetch succeeded instead of rejecting). The default transport now validates all DNS answers inside the socket lookup and hands only those answers to the connection; it keeps hostname/SNI, normal TLS verification, manual redirects, bounded streaming and decompression. No reusable global agent or implicit redirect following. The regression now passes without sending a request to the private server. Chromium remains subject to the kernel sandbox, not this transport.
2. **IPv6 special-use ranges:** site-local, local translation and other non-global/special-use IPv6 destinations were not all rejected. Policy now fails closed outside global unicast and in the tested IETF special-use range. Regression covers site-local, translation, compatible IPv4, Teredo, benchmarking and ORCHID examples. Conservative denial can reject unusual otherwise reachable services.
3. **Account deletion password guesses:** only the coarse auth limit covered current-password verification. Added a per-account password-attempt limit using the existing login email-limit settings. Regression proves the account remains active when excess attempts receive 429.
4. **False email readiness:** `TRANSACTIONAL_EMAIL_ENABLED=true` could still use the disabled adapter. Startup now rejects that configuration before database migration. A provider adapter must actually be injected; flags do not install one.
5. **Privacy wording:** replaced unconditional next-run/30-day erasure promises with the actual eligibility, batching and operational target. Documented the internal pro policy and missing physical cleanup for failed jobs/reset-token rows. No retention durations or business identity were invented.

## Checked defenses

- Authenticated, owner-scoped report/job reads and deletion; unrelated accounts receive 404. Password hashing, token hashing, session revocation and password-reset flows are covered by API tests.
- Exact Origin and strict JSON checks protect cookie-authenticated mutations. Admin retry also requires trusted Origin and the operator key. Session cookies use HttpOnly/SameSite and production Secure/host-cookie rules.
- URL scheme/private-host/private-IP rejection, mixed DNS answers, redirect validation, streamed size limits and abort behavior; live HTML scan of `https://example.com` succeeded after the transport change.
- Bounded in-memory rate-limit buckets, scrypt concurrency and transactional monthly quotas. In-memory limits are per process and reset on restart. Caller-supplied forwarding headers are ignored; a reverse proxy can make clients share one IP bucket. Validate capacity and proxy behavior before invites.
- API and worker use the same migrations/release/database. Production runner attestation fails closed. The worker health listener is loopback-only. Linux enforcement was not run on this Mac.
- Reachable Git history: 924 blobs scanned across local/remote refs with filename and private-key/GitHub/AWS/OpenAI-token patterns; zero candidates. This does not prove absence of all secret formats or sensitive content in images/unreachable objects. Existing migration backup contains templates/skills; private local archives were not imported. No real `.env`, SQLite, customer data or private archive was staged.
- `pnpm audit --prod --json`: zero reported advisories at this check, 122 dependency entries. This is a registry snapshot, not a guarantee about all dependency behavior.

## Residual blockers / server checks

See [beta checklist](BETA-READINESS.md). In particular: no server credentials or deployment were used; no current Linux/systemd, nftables, browser egress, reboot/recovery, TLS/proxy, backup restoration, email-provider or alert-delivery acceptance is claimed. Historical Linux evidence applies to its old bundle only.

Retention needs an approved policy for failed jobs, physical reset-token removal, backups and provider logs, then matching implementation/tests. SQL deletion alone does not sanitize SQLite free pages/WAL/backups. An in-flight email send may already have reached the provider when account deletion cancels its outbox row.

The current account deletion API has no frontend flow. Recovery/verification forms exist, but default delivery is disabled. Do not describe those features as operational until configured and tested.
