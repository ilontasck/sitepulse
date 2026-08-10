# SitePulse Project Health Report

Final verification date: 2026-08-10

Repository: `https://github.com/ilontasck/sitepulse.git`

Verified runtime: Node.js `v24.14.0`, pnpm `11.9.0`, Playwright `1.61.1`

## ✅ Environment — PASS

- The active versions satisfy `.node-version`, `package.json#engines`, and `packageManager`.
- `setup.sh` passes shell syntax validation and its install flow matches the migration guides.
- `.env` exists, matches `.env.example`, is ignored by Git, and contains no committed secret.
- The Codex skills/agents backup and restore index under `migration_backup/codex/` are present.
- The only environment caveat is Node's experimental warning for the built-in `node:sqlite` API.

## ✅ Dependencies — PASS

- `pnpm install --frozen-lockfile --offline` succeeds and the lockfile matches `package.json`.
- `pnpm audit --prod` reports no known vulnerabilities.
- The dependency surface is minimal: Playwright is the only npm development dependency; runtime uses Node built-ins.

## ✅ Git — PASS

- `origin` fetch/push URL is `https://github.com/ilontasck/sitepulse.git`.
- After the final audit commit and push, local `main` and `origin/main` are required to have divergence `0/0`.
- No merge/rebase state, conflict markers, tracked `.env`, tracked SQLite databases, or tracked test artifacts were found.
- The final audit changes and this report are committed and published together on `origin/main`.

## ✅ Tests — PASS

- Unit/integration: 32 passed, 0 failed across 8 suites.
- E2E: 3 Chromium tests passed, 0 failed.
- All `.mjs` entrypoints, source files, tests, and Playwright configuration pass `node --check`.
- `data/sitepulse.sqlite` and `data/e2e-sitepulse.sqlite` both return `ok` from `PRAGMA integrity_check`.
- Regression coverage was added for JSON primitive rejection, invalid numeric configuration, and forwarded-header rate-limit bypass.

## ✅ Security — WARNING

- No secrets or API keys are tracked; `.env` and runtime SQLite data are ignored.
- SQL statements use prepared parameters. Static serving uses an allowlist plus normalized path containment checks.
- User-originated report strings are HTML-escaped before `innerHTML` rendering.
- URL scanning blocks unsafe protocols, private/reserved IPv4 and IPv6 ranges, unsafe redirects, excessive redirects, large bodies, non-HTML responses, and timeouts.
- Express is not used; the smaller Node HTTP surface has CSP, clickjacking, MIME-sniffing, referrer, and permissions headers, bounded JSON bodies, and rate limiting.
- Fixed during this audit: JSON primitives now return a safe 400; caller-controlled `X-Forwarded-For` can no longer evade the local rate limiter; stale limiter buckets are pruned; numeric security limits are validated at startup.
- Remaining deployment risk: DNS is validated before `fetch`, but the connection is not pinned to the validated address. A production Internet-facing scanner should use a pinned-address transport or isolated egress proxy to eliminate DNS-rebinding TOCTOU risk.
- Current CSP needs `'unsafe-inline'` because the single-file frontend contains inline CSS/JS. Extract these assets and adopt nonces/hashes before a public production launch.

## ✅ Performance — WARNING

- Scanner fetches have a 4.5-second timeout and 250 KB response cap; redirects are bounded.
- API request bodies and list result sizes are bounded; SQLite has WAL, busy timeout, and useful indexes.
- No unnecessary runtime dependencies or obvious repeated network requests were found.
- SQLite is opened, initialized, and closed for each store operation. This is simple and safe for the local MVP, but a persistent connection/queue or external database is recommended before meaningful concurrency.
- The in-memory rate limiter is process-local; use a shared store when running multiple instances.

## ✅ Architecture — PASS

- Clear seams separate configuration, HTTP routing/security, audit orchestration, scanner adapters, scoring/report generation, and persistence.
- Imports resolve, module direction is coherent, and no circular imports, duplicate implementations, dead exports, TODOs, or FIXMEs were found.
- The project intentionally uses JavaScript ESM rather than TypeScript or Express; there is no dormant TypeScript/Express layer to maintain.
- The scanner adapter boundary is suitable for adding Lighthouse, axe, rendered-browser, or queue-backed scanners later.

## ✅ Documentation — PASS

- `README.md`, `MIGRATION.md`, `MACHINE_SETUP.md`, `.env.example`, `setup.sh`, and `migration_backup/` agree on versions, commands, paths, ignored runtime files, and restore procedure.
- The documented project tree matches the repository, including scanner adapters, Playwright, SQLite, screenshots, and Codex skill backups.
- This report records current verification results and production caveats.

## ✅ Technical Debt — WARNING

- Production hardening items: eliminate DNS-rebinding TOCTOU, remove inline-script/style CSP exceptions, replace process-local rate limiting for horizontal scaling, and revisit per-operation SQLite connections.
- Product-quality limitations are documented: HTML heuristics are not Lighthouse/Core Web Vitals, rendered accessibility, contrast, or JS-generated-content analysis.
- These items do not block continued local development or the current portfolio MVP.

## Final Assessment

All development-blocking findings discovered during this audit were fixed and covered by regression tests. The remaining warnings are production-scale or scanner-depth improvements, not migration defects.

**PROJECT STATUS: READY FOR DEVELOPMENT ✅**
