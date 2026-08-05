# SitePulse

SitePulse is a portfolio-grade website audit dashboard for small businesses. Users enter a website URL and receive a polished audit report with scores, live HTML checks, security-minded recommendations, and prioritized next steps.

The project is intentionally built as a local MVP/demo foundation: the UI feels like a premium SaaS dashboard, while the backend already includes a modular scanner pipeline, API validation, SSRF protection, privacy controls, SQLite persistence, and automated tests.

## GitHub Repository Summary

One-line description:

```text
Premium website audit dashboard with a Node.js backend, SQLite storage, SSRF-safe HTML scanner, and Playwright-tested SaaS-style report UI.
```

Tech stack:

```text
HTML/CSS/JavaScript, Node.js, SQLite, Playwright, Node test runner
```

Portfolio value:

```text
Shows full-stack product execution: polished UI, backend API, secure scanner pipeline, privacy controls, persistence, testing, and deploy-aware documentation.
```

## What It Does

- Accepts a public website URL.
- Runs a safe HTML-based audit scanner.
- Scores eight audit categories:
  - Design quality
  - Mobile responsiveness
  - Performance
  - SEO basics
  - Accessibility
  - Trust and conversion
  - Buttons and forms
  - Content clarity
- Shows an interactive report with:
  - Overall score
  - Category scores
  - Live checks
  - Priority fixes
  - Recommendations grouped by priority
  - Scanner mode and adapters used
  - Safe error states for invalid or private/internal URLs

## Tech Stack

- Frontend: HTML, CSS, vanilla JavaScript
- Backend: Node.js ESM HTTP server
- Storage: SQLite via Node's built-in `node:sqlite`
- Testing: Node test runner and Playwright
- Security: SSRF-aware scanner fetch, API validation, rate limiting, security headers

Node's `node:sqlite` module is currently marked experimental by Node, so this project requires Node.js `22.5+`.

## Portfolio Value

This project demonstrates:

- Product-minded frontend UI for a SaaS-style audit dashboard.
- Backend API design with health, audit create/read, and protected admin summary routes.
- SQLite storage with clean repository boundaries.
- Scanner pipeline architecture that can later accept Lighthouse, Playwright, axe-core, or queue-based adapters.
- SSRF protection before scanning user-supplied URLs.
- Privacy cleanup: public users cannot fetch the full audit history.
- Security-minded development: validation, safe errors, body limits, rate limiting, static file allowlist, and security headers.
- E2E testing of the main user flow and important error states.
- Modular code organization without coupling SQL or scanner internals into routes.

## Scanner Checks

Current scanner mode:

- `html-real-checks`: safely fetches target HTML and runs adapter-based checks.
- `fallback`: used when live HTML scanning fails for non-safety reasons.

Active adapters:

- `http-html`: SSRF-aware HTML fetcher with manual redirect checks, timeout, and response size limit.
- `seo`: title, meta description, canonical, H1 count, robots meta, and basic Open Graph checks.
- `accessibility`: image alt attributes, form labels, button names, document language, and heading structure.
- `performance-hints`: response time, HTML size, script/style count, large inline script/style, and caching headers.
- `security-headers`: HTTPS plus Content-Security-Policy, frame protection, X-Content-Type-Options, Referrer-Policy, and Permissions-Policy checks.

Honest limitation: this is not Lighthouse yet. It does not measure Core Web Vitals, rendered contrast, JS-generated content, mixed content after rendering, or mobile layout from a real browser. Those are planned future adapters.

## Project Structure

```text
server.mjs                  App entrypoint
index.html                  Frontend application and report UI
src/config/                 Runtime config
src/audit/                  URL validation, safety, scanner pipeline, scoring, recommendations
src/audit/scanners/         HTML scanner and adapter modules
src/http/                   App factory, routes, errors, security, body parsing, static files
src/storage/                SQLite audit repository
test/                       Unit and API tests
e2e/                        Playwright browser tests
scripts/reset-db.mjs        Local SQLite reset helper
playwright.config.mjs       E2E web server config
```

Runtime files are ignored by Git:

```text
node_modules/
test-results/
playwright-report/
.env
.env.*
data/*.sqlite
data/*.sqlite-shm
data/*.sqlite-wal
data/*.json
coverage/
*.log
.DS_Store
```

## Requirements

- Node.js `22.5+`
- pnpm
- Chromium for Playwright e2e tests

For a full new-Mac restore, read:

- [MIGRATION.md](MIGRATION.md): project restore guide, environment variables, ignored files, and one-prompt Codex restore flow.
- [MACHINE_SETUP.md](MACHINE_SETUP.md): machine-level Git, Homebrew, Node, pnpm, Playwright, SQLite, VS Code, CLI, and Codex notes.
- [migration_backup/](migration_backup/): safe non-secret restore notes and templates.

## Install

```bash
pnpm setup
```

This runs `setup.sh`, which checks Node.js, installs dependencies, installs Playwright Chromium, creates local runtime files, and runs unit tests.

## Run Locally

```bash
pnpm start
```

Open:

```text
http://localhost:3000
```

Development alias:

```bash
pnpm dev
```

## Move To A New Mac

The repository is prepared so the new Mac setup is:

```bash
git clone https://github.com/ilontasck/sitepulse.git
cd sitepulse
./setup.sh
pnpm start
```

Before moving, push the project from the old Mac:

```bash
git status --short --ignored
pnpm test
git add .
git commit -m "Prepare complete Mac migration docs"
git push
```

Current `origin`:

```text
https://github.com/ilontasck/sitepulse.git
```

Files intentionally not moved through Git:

```text
node_modules/
.env
.env.*
data/*.sqlite
data/*.sqlite-shm
data/*.sqlite-wal
data/*.json
test-results/
playwright-report/
blob-report/
playwright/.cache/
coverage/
.pnpm-store/
.npm/
.yarn/
.yarn-cache/
dist/
build/
.cache/
.parcel-cache/
.vite/
.turbo/
*.log
tmp/
temp/
.DS_Store
.vscode/
.idea/
```

If the local SQLite database contains work you need to preserve, export or copy `data/sitepulse.sqlite` separately. It is intentionally ignored because it is runtime state, not source code.

## Demo Script

1. Start the app with `pnpm start`.
2. Open `http://localhost:3000`.
3. Enter `https://example.com/`.
4. Run the audit.
5. Review the report:
   - Overall score
   - Category cards
   - Live checks
   - Priority recommendations
   - Scanner metadata and adapters
6. Try `not a website` and confirm a friendly validation error.
7. Try `http://127.0.0.1:3000` and confirm private/internal URLs are blocked before scanning.

## Suggested Screenshots

Real screenshots are stored in `docs/screenshots/`:

| Landing | Loading |
| --- | --- |
| ![SitePulse landing page](docs/screenshots/01-landing.png) | ![SitePulse loading state](docs/screenshots/02-loading.png) |

| Report | Category Detail |
| --- | --- |
| ![SitePulse audit report](docs/screenshots/03-report.png) | ![SitePulse category detail](docs/screenshots/04-category-detail.png) |

| Unsafe URL Error | Print View |
| --- | --- |
| ![SitePulse unsafe URL error](docs/screenshots/05-unsafe-url-error.png) | ![SitePulse print view](docs/screenshots/06-print-view.png) |

If you want to refresh screenshots manually for a portfolio case study, capture:

- Landing page: hero, URL form, and live preview card.
- Loading state: form submitted while the audit spinner is visible.
- Final report: overall score, scanner metadata, priority recommendations, and category checks.
- Category detail: one expanded category showing live checks and recommended actions.
- Error state: private/internal URL blocked with the friendly error message.
- Print view: A4 report preview with buttons and decorative background removed.

## Test Commands

Unit and API tests:

```bash
pnpm test
```

Alias for the same unit/API test suite:

```bash
pnpm test:unit
```

Browser e2e tests:

```bash
pnpm test:e2e
```

All tests:

```bash
pnpm test:all
```

Reset local SQLite database:

```bash
pnpm reset-db
```

## Environment Variables

`setup.sh` creates `.env` from `.env.example` when `.env` does not exist. Keep real secrets only in `.env`; it is ignored by Git.

```text
HOST=127.0.0.1
PORT=3000
NODE_ENV=development
DATABASE_FILE_PATH=./data/sitepulse.sqlite
ADMIN_API_KEY=
REQUEST_BODY_LIMIT_BYTES=32768
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=60
```

Notes:

- `DATABASE_FILE_PATH` controls the SQLite database location.
- `ADMIN_API_KEY` enables protected `GET /api/audits` summaries.
- `.env` is ignored and should not be committed.

## API Overview

### `GET /api/health`

Returns service health.

### `POST /api/audits`

Creates an audit report.

```json
{
  "websiteUrl": "https://example.com/"
}
```

Response includes `audit`, `categories`, `checks`, `recommendations`, `scanner`, and `warnings`.

### `GET /api/audits/:id`

Returns one audit report by unguessable UUID.

### `GET /api/audits?limit=20`

Admin-only summary endpoint. Requires:

```text
X-Admin-Key: your-admin-key
```

It returns summaries only, not full category/recommendation payloads.

## Security And Privacy

- Rejects invalid, unsupported, localhost, and private/internal URLs.
- Resolves hostnames before scanning and blocks private/internal IP ranges.
- Manually validates redirect targets instead of blindly following redirects.
- Limits redirects, request time, and downloaded HTML size.
- Requires JSON request bodies.
- Applies JSON body size limits.
- Uses basic in-memory API rate limiting.
- Applies security headers globally.
- Serves static files through an allowlist.
- Keeps audit history private unless `ADMIN_API_KEY` is configured.
- Returns safe JSON errors without stack traces.

## Storage

SQLite database:

```text
data/sitepulse.sqlite
```

The database is initialized automatically. The `audits` table stores summary columns plus a full JSON report payload:

- `id`
- `created_at`
- `updated_at`
- `normalized_url`
- `domain`
- `overall_score`
- `scanner_mode`
- `report_json`

Reset it with:

```bash
pnpm reset-db
```

## Deploy Readiness

Good demo targets:

- Render
- Railway
- Fly.io
- A small VPS
- Any Node.js host that can run a persistent process and write to local disk

SQLite caveat:

- SQLite is fine for a local MVP and portfolio demo.
- On serverless or ephemeral platforms, local SQLite files may disappear between deployments or instances.
- A real SaaS deployment should use Postgres for durable storage, backups, concurrent access, and easier horizontal scaling.

Before production:

- Replace local SQLite with Postgres.
- Add authenticated user accounts.
- Move slow scans into a background job queue.
- Add hosted file/report export.
- Add Lighthouse, Playwright rendering, and axe-core adapters.
- Add monitoring and structured logs.
- Configure production `ADMIN_API_KEY`, `DATABASE_FILE_PATH` or Postgres env vars, and stricter rate limits.

## Before Pushing To GitHub

Run this quick checklist:

```bash
git status
pnpm setup
pnpm test
pnpm test:e2e
pnpm reset-db
```

Then verify:

- `.env` is not present in Git.
- `node_modules/` is not staged.
- `data/*.sqlite`, `data/*.sqlite-shm`, `data/*.sqlite-wal`, and `data/*.json` are not staged.
- `test-results/` and `playwright-report/` are not staged.
- Screenshots in `docs/screenshots/` are current.
- README commands still match `package.json`.

## Roadmap

- Lighthouse performance adapter
- Playwright rendering/mobile adapter
- axe-core accessibility adapter
- Authenticated report history
- Branded PDF export
- Background scan queue
- Postgres storage for hosted production
- Public demo deployment
