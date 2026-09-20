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
- `LEGAL_PROCESS_LOG_RETENTION`
- `LEGAL_AUDIT_REPORT_RETENTION`

Optional values are `LEGAL_CONTACT_PHONE`, `LEGAL_VAT_ID`, and the pair `LEGAL_REGISTER_NAME` plus `LEGAL_REGISTER_NUMBER`. Do not invent them. Leave both register values empty for an Einzelunternehmen that is not entered in the Handelsregister.

Only after every mandatory value is verified and the final legal review is complete may the private deployment environment set:

```text
LEGAL_PUBLICATION_READY=true
```

Run `node scripts/check-legal-placeholders.mjs` with the same private environment before launch. A non-zero exit is a release blocker.

## Dependencies

- **STE-14:** production hosting has not been provisioned. A plan mentioning Hetzner Cloud Germany/NBG1 is not evidence of an actual provider, contract, server location, or log-retention setting. Populate hosting fields only from the deployed arrangement and confirm any required DPA.
- **STE-31:** audit/job/report retention and deletion behavior remain undecided and unimplemented in the available source-of-truth. `LEGAL_AUDIT_REPORT_RETENTION` is therefore a deliberate public-launch blocker, not a guessed duration.
- **STE-60:** NOQORI remains the current brand. Any future brand decision must update the legal text and runtime values as a separate change.
- **Final legal review:** a qualified lawyer must review the Privacy Policy, Impressum, Terms, legal bases, age language, liability wording, contact sufficiency, consumer rules, data-subject process, and the actual production facts.

## Current data-flow summary

| Data | Storage | Current behavior |
| --- | --- | --- |
| Account email | SQLite `users` | Stored until account deletion process is completed |
| Password | Salted scrypt hash in `users` | Plaintext is never stored |
| Session | SHA-256 token hash in `sessions` | Active for 14 days; revoked sessions are cleaned after the configured cleanup interval |
| Password reset | SHA-256 token hash in `password_reset_tokens` | One-hour, single-use; newer request invalidates older pending tokens; successful reset revokes all sessions |
| Submitted URL and audit job | SQLite `audit_jobs` | Owner-scoped; retention awaits STE-31 |
| Audit report | SQLite `audits` | Owner-scoped; retention/deletion awaits STE-31 |
| Client IP | In-memory rate-limit bucket | Not stored in SQLite or application logs |
| Operational telemetry | Process output / hosting journal | Privacy-safe allowlisted fields; actual infrastructure retention awaits STE-14 |

NOQORI currently sets only the strictly necessary session cookie. It uses no analytics, advertising, external fonts, tracking storage, `localStorage`, `sessionStorage`, or IndexedDB. The current cookie assessment should be reviewed under the applicable GDPR and TDDDG rules before launch.

## Current status

The code-side legal configuration and publication guard are ready for review. STE-19 is not Done and the service is not public-launch ready while runtime identity/contact values, actual STE-14 hosting facts, STE-31 retention behavior, and final legal advice are outstanding.
