# Internal client-acquisition workflow

This toolkit turns one URL that you provide into a short, evidence-backed sales draft. It uses the existing NOQORI audit engine, including URL normalization, DNS/private-network checks, redirect validation, HTML adapters, and the existing rendered-audit limiter. It does not send messages or collect leads from external services.

## Run a mini-audit

From the repository root:

```bash
pnpm mini-audit https://example.com
```

Add `--rendered` when Core Web Vitals or Lighthouse findings are worth the extra browser cost. This uses the existing single-concurrency rendered-audit limiter. The default is the faster HTML-only path.

The command writes:

- `reports/leads/example-com-mini-audit.md` — the three highest-priority findings with evidence and recommended direction.
- `outreach/example-com-mini-audit.txt` — a draft only; it is never sent automatically.

Use `--no-outreach` when only the Markdown report is needed. Use `--lead --company "Example Co" --industry "SaaS"` to append a row to `data/leads.csv`.

## Lead tracker

The optional CSV tracker has these fields:

`company`, `website`, `industry`, `contact_name`, `contact_method`, `contact_value`, `finding_1`, `finding_2`, `finding_3`, `audit_date`, `contacted_at`, `status`, `follow_up_at`, `result`, `revenue`.

Use statuses such as `NEW`, `AUDITED`, `READY_TO_CONTACT`, `CONTACTED`, `REPLIED`, `INTERESTED`, `WON`, and `LOST`. Edit the CSV manually for follow-up details. Do not put passwords, cookies, session tokens, API keys, or other secrets in it.

## Manual QA checklist

Before adapting an outreach draft for a potential client, a person must verify:

- The problem actually exists.
- The screenshot or evidence matches the problem.
- The affected URL is correct.
- The severity is reasonable.
- The message contains no unsupported claim or false statement.
- The report and message contain no sensitive information.
- The finding is still relevant after a quick human review on desktop and mobile.

The output is an automated preliminary check, not a full audit. A full Website Audit & QA is the €99 service offer described in the current brief; confirm commercial details before sending.

## What remains manual

The operator chooses the URL, verifies the findings, decides whether the company is a fit, adapts the draft, records contact status, and sends any message through an approved channel. This toolkit does not scrape search engines, bypass CAPTCHA, automate LinkedIn, harvest bulk emails, or send cold outreach.
