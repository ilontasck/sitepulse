# Local development and checks

Current as of 2026-09-25. Start from the branch in [SOURCE-OF-TRUTH](SOURCE-OF-TRUTH.md).

## Safe setup

1. Inspect `git status --short --ignored` and `git worktree list` before changing an existing checkout. Preserve untracked/ignored data; never copy an old checkout over this release.
2. Use Node 24.x and pnpm 11.9.0. Run `pnpm install --frozen-lockfile`.
3. Create `.env` from `.env.example` only when absent. On Mac/Linux: `test -e .env || cp .env.example .env`. On PowerShell: `if (!(Test-Path .env)) { Copy-Item .env.example .env }`.
4. Keep `NODE_ENV=development`, `PUBLIC_ORIGIN=http://127.0.0.1:3000` and `AUTH_REGISTRATION_MODE=public` for disposable local accounts. Open that exact origin, not `localhost` with a different origin. Production registration stays `closed`.
5. Run `pnpm start` and `pnpm worker` in separate terminals with the same `.env`, database path and code release. Data is stored in `data/sitepulse.sqlite` by default. Migrations run on startup locally.
6. Register, submit `https://example.com`, wait for queued/running/report, and use Print report. The worker is required. `RENDERED_AUDIT_ENABLED=false` means HTML checks, not Chromium/Lighthouse performance measurements.

`setup.sh` is an optional POSIX helper; Windows users should use the explicit commands above (or WSL for the helper). Windows application compatibility is intended, not newly verified here. SQLite requires persistent writable storage. Postgres is not a prerequisite for a single-VM closed beta; migration is a separate scaling decision.

## Tests

```sh
pnpm exec playwright install chromium
pnpm test
pnpm test:e2e
node scripts/check-legal-placeholders.mjs
```

Unit/API tests use temporary databases. Browser tests use this checkout's ignored `data/e2e-sitepulse.sqlite`; the new beta lifecycle test uses its own temporary database. Port 3010 must be free. Do not point tests at production data. A sandbox may require permission to bind loopback ports/run Chromium; `EPERM` is an environment failure, not a passing test.

The legal checker intentionally exits 1 with the example environment. It must pass with genuine, reviewed production values before external use. To load a private env file explicitly: `node --env-file=.env scripts/check-legal-placeholders.mjs`.

`pnpm verify:systemd` and Linux sandbox acceptance are Linux checks. An UNAVAILABLE message on Mac is not a pass, even if the wrapper exits zero.

## Deployment boundary

Use the [Linux supervision runbook](PRODUCTION_PROCESS_SUPERVISION.md) and [network isolation runbook](PRODUCTION_BROWSER_SECURITY.md). The API, worker, migration service and isolated runner must share the intended release/schema (currently migrations 001–011). Retest the exact release bundle on the server. Keep the worker health listener loopback-only.

Email delivery is not enabled by flags alone: the stock server has no provider adapter. Enabling transactional email without an adapter now fails startup. Keep all three email flags false until a provider integration is configured and tested. Recovery UI/API are implemented, but messages are not delivered in the default setup.

Do not use `pnpm reset-db` as a deployment or testing step. It destroys the selected local database. Back up and test restoration before any production migration.
