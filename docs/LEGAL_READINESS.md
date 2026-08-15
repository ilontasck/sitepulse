# NOQORI Legal Readiness Checklist

This file tracks the legal readiness status of the NOQORI service.
It is an internal development document and is **not served to users**.

---

## READY

The following work has been completed as part of Module 06:

- [x] Real data-flow inventory (see `docs/LEGAL_READINESS.md` and Module 06 implementation notes)
- [x] Cookie / storage inventory — one strictly necessary session cookie identified; no consent banner required at current implementation
- [x] Privacy Policy page — `/privacy` (source: `privacy.html`)
- [x] Impressum / Legal Notice page — `/impressum` (source: `impressum.html`)
- [x] Terms of Service page — `/terms` (source: `terms.html`)
- [x] Legal page routes wired in backend (`src/http/static-files.mjs`)
- [x] Footer legal navigation on the landing page (`index.html`)
- [x] `module-06.css` — legal page design system
- [x] Placeholder detection script (`scripts/check-legal-placeholders.mjs`)
- [x] Tests for legal page delivery, footer links, and placeholder detection

---

## REQUIRED BEFORE PUBLIC LAUNCH

The following items **must** be resolved before any legal page is published
to a production domain or presented to users.

### 1. Controller / Business Identity

- [ ] Legal entity / business name
- [ ] Full postal address (street, city, postal code, country)
- [ ] Official contact email address
- [ ] Commercial register court and number (if applicable)
- [ ] VAT ID / Umsatzsteuer-Identifikationsnummer (if applicable)
- [ ] Representative(s) if a company (Geschäftsführer / director)

### 2. Hosting Infrastructure

- [ ] Hosting provider name and country
- [ ] Server / data centre location (country / region)
- [ ] Confirmation of whether data is processed outside the EEA
- [ ] Data Processing Agreement (DPA) with hosting provider in place

### 3. Privacy Policy Completions

- [ ] Publication date
- [ ] Process log retention period (confirm with hosting provider)
- [ ] **PUBLIC‑LAUNCH BLOCKER**: Define legitimate purpose and retention period for audit reports, implement deletion behavior if required, update Privacy Policy
- [ ] Define retention criteria for audit job records
- [ ] International transfer mechanism (if server is outside EEA)
- [ ] Define and document operational process for handling data-subject rights requests (access, rectification, erasure, restriction)
- [ ] Supervisory authority name and contact details

### 4. Impressum Completions (§ 5 DDG)

- [ ] Provider name
- [ ] Postal address
- [ ] Contact email
- [ ] Telephone number (if applicable)
- [ ] Register details (if applicable)
- [ ] USt-IdNr. (if applicable)

### 5. Terms of Service Completions

- [ ] Controller / provider name
- [ ] Publication date
- [ ] Minimum age threshold confirmed for applicable jurisdiction
- [ ] Liability cap (to be determined by legal counsel)
- [ ] Governing law jurisdiction
- [ ] Courts with exclusive jurisdiction
- [ ] Contact email and postal address

### 6. Legal Review

- [ ] Full legal review of Privacy Policy by a qualified lawyer
- [ ] Full legal review of Impressum by a qualified lawyer
- [ ] Full legal review of Terms of Service by a qualified lawyer
- [ ] Legal basis for each processing activity confirmed (GDPR Art. 6)
- [ ] GDPR / TTDSG cookie assessment confirmed for applicable jurisdiction
- [ ] Right-to-erasure operational process defined and documented

---

## DATA-FLOW SUMMARY (verified from source code, Module 06 audit)

| Data | Where stored | Retention | Deletion |
|------|-------------|-----------|----------|
| Email address (original + normalised) | SQLite `users` table | Until account deleted | Manual request via defined operational process |
| Scrypt password hash | SQLite `users` table | Until account deleted | Manual request via defined operational process |
| Account UUID | SQLite `users` table | Until account deleted | Manual request via defined operational process |
| Session token SHA-256 hash | SQLite `sessions` table | 14 days (active); +24 h after revocation | Hourly automated cleanup |
| Submitted audit URLs | SQLite `audit_jobs` + `audits` tables | **PUBLIC‑LAUNCH BLOCKER — retention period undefined** | No automatic deletion |
| Audit report JSON blob | SQLite `audits` table | **PUBLIC‑LAUNCH BLOCKER — retention period undefined** | No automatic deletion |
| IP address | In-memory rate limiter only | Current rate-limit window only | Never persisted |
| Telemetry events | stdout (process log) | Hosting provider log retention | Not under application control |

## COOKIE SUMMARY (verified from source code)

| Name | Type | Purpose | Lifetime | Third-party? |
|------|------|---------|---------|-------------|
| `__Host-sitepulse_session` (HTTPS) / `sitepulse_session` (HTTP) | Strictly necessary | Session authentication | 14 days | No |

No localStorage, sessionStorage, IndexedDB, or other client-side storage is used.
No analytics, tracking, or advertising cookies are present.
**Cookie consent banner: not required at current implementation.**

## THIRD-PARTY SERVICES (verified from source code)

None. No analytics, CDN, external fonts, email delivery, tracking, or monitoring
integrations are present in the current codebase.

---

## HOW TO CHECK FOR UNRESOLVED PLACEHOLDERS

```bash
node scripts/check-legal-placeholders.mjs
```

This script scans `privacy.html`, `impressum.html`, and `terms.html` for any
remaining `[REQUIRED BEFORE PUBLIC LAUNCH: …]` strings and exits with a
non-zero code if any are found.

Integrate into your pre-launch CI pipeline to prevent accidental publication
of incomplete legal pages.

---

*Last updated: Module 06 implementation — August 2026*
