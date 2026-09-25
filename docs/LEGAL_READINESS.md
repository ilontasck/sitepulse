# NOQORI legal readiness

STE-19 replaces repository-stored operator placeholders with an escaped runtime configuration. The repository is public: never commit the operator's home address, personal telephone number, or production contact details. Supply publishable values through the deployment environment only.

## Done in code

- `/privacy`, `/impressum`, and `/terms` remain real routes with the existing NOQORI layout and CSP-compatible markup.
- Legal template variables are allowlisted and HTML-escaped before rendering. Unknown or unresolved variables fail rendering.
- `LEGAL_PUBLICATION_READY=false` is the safe default. Development and test render an explicit draft notice without requiring operator PII.
- Production refuses to start unless `LEGAL_PUBLICATION_READY=true`; the ready setting fails configuration loading unless all mandatory operator, contact, hosting, publication-date, process-log-retention, and audit/report-retention values exist.
- Phone and VAT sections are optional. Register name and number must be supplied together; the register section is absent when neither is configured, matching an unregistered Einzelunternehmen.
- The Privacy Policy covers account email, scrypt password hashes, sessions, one-hour password-reset-token hashes, submitted URLs, audit jobs/reports, operational logs, the strictly necessary session cookie, absence of analytics/tracking, and owner-scoped report access.
- The NRW supervisory authority is included with its public institutional address and email.
- Terms use German law only where legally permissible, preserve mandatory consumer protections, use statutory jurisdiction, and contain no invented liability cap or court.
- The checker rejects old launch markers, unknown template directives, incomplete public configuration, and a closed publication gate.
- Current authenticated/free reports are available for up to 30 days. At expiry they become inaccessible immediately; scheduled bounded cleanup later removes expired or manually deleted reports with their linked jobs.
- Account deletion disables access and revokes sessions immediately; application-owned jobs, reports, reset tokens, sessions, and the user record are eligible for physical purge after 29 days; bounded scheduled cleanup must be monitored to meet the existing 30-day operational target. This is not an unconditional deadline guarantee.

## Runtime values still required

These values are intentionally empty in `.env.example` and must come from the private production environment:

- `LEGAL_OPERATOR_NAME`
- `LEGAL_OPERATOR_ADDRESS_LINE1`
- `LEGAL_OPERATOR_POSTAL_CODE`
- `LEGAL_OPERATOR_CITY`
- `LEGAL_OPERATOR_COUNTRY`
- `LEGAL_CONTACT_EMAIL`
- `LEGAL_PUBLICATION_DATE` (`YYYY-MM-DD`)
- `LEGAL_HOSTING_PROVIDER`
- `LEGAL_HOSTING_COUNTRY`
- `LEGAL_SERVER_LOCATION`
- `LEGAL_PROCESS_LOG_RETENTION` (policy: `30 days, except incident or legal retention`; infrastructure enforcement remains STE-14)
- `LEGAL_AUDIT_REPORT_RETENTION` (`Available for up to 30 days; expired reports are removed by scheduled retention cleanup.`)

Optional values are `LEGAL_CONTACT_PHONE`, `LEGAL_VAT_ID`, and the pair `LEGAL_REGISTER_NAME` plus `LEGAL_REGISTER_NUMBER`. Do not invent them. Leave both register values empty for an Einzelunternehmen that is not entered in the Handelsregister.

Only after every mandatory value is verified and the final legal review is complete may the private deployment environment set:

```text
LEGAL_PUBLICATION_READY=true
```

Run `node scripts/check-legal-placeholders.mjs` with the same private environment before launch. A non-zero exit is a release blocker.

## Dependencies

- **STE-14:** production hosting has not been provisioned. A plan mentioning Hetzner Cloud Germany/NBG1 is not evidence of an actual provider, contract, server location, or log-retention setting. Populate hosting fields only from the deployed arrangement and confirm any required DPA.
- **STE-31:** application retention, report deletion, account disablement, and bounded physical cleanup are implemented. UI work remains outside this backend phase.
- **STE-60:** NOQORI remains the current brand. Any future brand decision must update the legal text and runtime values as a separate change.
- **Final legal review:** a qualified lawyer must review the Privacy Policy, Impressum, Terms, legal bases, age language, liability wording, contact sufficiency, consumer rules, data-subject process, and the actual production facts.

## Current data-flow summary

| Data | Storage | Current behavior |
| --- | --- | --- |
| Account email | SQLite `users` | Disabled immediately on deletion request; eligible for physical purge after 29 days; scheduled cleanup completion requires monitoring |
| Password | Salted scrypt hash in `users` | Plaintext is never stored |
| Session | SHA-256 token hash in `sessions` | Active for 14 days; revoked sessions are cleaned after the configured cleanup interval |
| Password reset | SHA-256 token hash in `password_reset_tokens` | One-hour, single-use; newer request invalidates older pending tokens; successful reset revokes all sessions |
| Submitted URL and audit job | SQLite `audit_jobs` | Owner-scoped; removed with expired/deleted reports or during account purge |
| Audit report | SQLite `audits` | Current authenticated/free tier: available for up to 30 days; expiry or manual deletion hides immediately, then scheduled cleanup removes physically |
| Client IP | In-memory rate-limit bucket | Not stored in SQLite or application logs |
| Operational telemetry | Process output / hosting journal | Policy: 30 days except incident/legal retention; actual infrastructure enforcement awaits STE-14 |

NOQORI currently sets only the strictly necessary session cookie. It uses no analytics, advertising, external fonts, tracking storage, `localStorage`, `sessionStorage`, or IndexedDB. The current cookie assessment should be reviewed under the applicable GDPR and TDDDG rules before launch.

## Reconciliation on 2026-09-25

See [the exact STE-31 contract](RETENTION-DELETION.md) and [beta blockers](BETA-READINESS.md). The later branch includes an internal pro policy with 12-calendar-month report retention, email verification-token storage and an audit-notification outbox. Free reports remain 30 days. Do not enable pro for users until the public wording and policy match it.

Known release gaps: failed jobs without a report and password-reset-token rows have no independent age-based physical purge for active accounts. Application deletion does not erase off-host backups, provider logs, SQLite free pages or WAL copies. Decide these policies and implement/verify enforcement before external personal data collection. A legal exception in prose is not a legal-hold feature in code.

The example 30-day process-log wording is not evidence of server configuration or an approved policy. Confirm the value with the operator; no hosting provider, retention decision or legal identity was invented in this review. Draft wording now describes batching/eligibility instead of promising completion on the next run.

## Current status

The code-side legal configuration, publication guard, and STE-31 retention behavior are ready for review. The service is not public-launch ready while runtime identity/contact values, actual STE-14 hosting and log-retention enforcement, and final legal advice are outstanding.
