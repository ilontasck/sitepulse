# SitePulse Migration Guide

Use this file when moving SitePulse to a new Mac. The goal is to clone the repository, run one setup command, and continue work with the same project behavior.

## Verified Tool Versions

- Node.js used for verification in this Codex environment: `v24.14.0`
- Project minimum Node.js version: `>=22.5`
- pnpm used for verification: `11.9.0`
- npm: not required directly by this project; use pnpm
- Playwright package: `@playwright/test ^1.61.1`
- Playwright CLI verified version: `1.61.1`
- Git observed on old Mac/session: `2.15.0`
- Homebrew observed on old Mac/session: `6.0.2`
- SQLite CLI observed on old Mac/session: `3.37.0`

## Required Homebrew Dependencies

Install these on the new Mac:

```bash
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install git node pnpm
```

Optional but useful:

```bash
brew install sqlite
brew install gh
```

Notes:

- The application uses Node's built-in experimental `node:sqlite` module, not a native npm SQLite package.
- The `sqlite` Homebrew package is useful for manually inspecting `data/sitepulse.sqlite`, but the app can run without the `sqlite3` CLI.
- Playwright browser binaries are installed by `./setup.sh`.

## Environment Variables

`setup.sh` creates `.env` from `.env.example` if `.env` is missing.

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

Manual restore:

- If you used a real `ADMIN_API_KEY`, copy it manually into `.env` on the new Mac.
- Do not commit `.env`.
- If the old local SQLite database matters, copy `data/sitepulse.sqlite` separately. It is intentionally ignored by Git.

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
docs/screenshots/           Portfolio screenshots
scripts/reset-db.mjs        Local SQLite reset helper
playwright.config.mjs       E2E web server config
setup.sh                    New-machine setup script
MIGRATION.md                Migration instructions
MACHINE_SETUP.md            Machine-level development environment notes
migration_backup/           Safe restore notes and exported non-secret templates
```

## Install And Run On A New Mac

```bash
git clone https://github.com/ilontasck/sitepulse.git
cd sitepulse
./setup.sh
pnpm start
```

Open:

```text
http://localhost:3000
```

## Test Commands

```bash
pnpm test
pnpm test:e2e
pnpm test:all
```

## What setup.sh Does

1. Checks that `node` exists.
2. Requires Node.js `22.5+`.
3. Enables Corepack if `pnpm` is missing and Corepack exists.
4. Creates `data/`.
5. Creates `.env` from `.env.example` if needed.
6. Runs `pnpm install --frozen-lockfile`.
7. Installs Playwright Chromium with `pnpm exec playwright install chromium`.
8. Runs `pnpm test`.

## Files Included In Git

Important project files verified in Git:

```text
.env.example
.gitignore
MIGRATION.md
MACHINE_SETUP.md
README.md
data/.gitkeep
docs/screenshots/*.png
e2e/sitepulse.spec.mjs
index.html
package.json
playwright.config.mjs
pnpm-lock.yaml
scripts/reset-db.mjs
server.mjs
setup.sh
src/**/*.mjs
test/**/*.mjs
migration_backup/*.md
```

## Files Not Included In Git

```text
.env
.env.*
node_modules/
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

## External Dependencies Found Outside The Project

Observed outside the repository during migration prep:

```text
/usr/local/bin/brew
/usr/bin/sqlite3
~/.gitconfig
~/.npmrc
~/.zshrc
~/.config/gh
~/.codex/
~/.agents/
```

Important notes:

- `~/.npmrc` can contain tokens. It was not copied into the repository.
- `~/.codex/auth.json`, Codex SQLite state, logs, memories, sessions, browser state, and connector auth were not copied.
- `~/.agents/skills` contains user-installed agent skills. A safe inventory is recorded in `migration_backup/external-dependencies.md`.
- Old GitHub credential helpers can point to absolute paths on the old Mac. Re-authenticate GitHub on the new Mac with `gh auth login` or GitHub Desktop/Codex.

## Manual Restore Checklist

- Install Xcode Command Line Tools.
- Install Homebrew.
- Install Git, Node, and pnpm.
- Clone the repository.
- Run `./setup.sh`.
- Recreate `.env` secrets if any.
- Re-authenticate GitHub.
- Open Codex and sign in.
- Reconnect any Codex connectors/plugins you use.
- Reinstall or copy personal Codex/agent skills if you rely on them.
- Copy `data/sitepulse.sqlite` manually only if you need old local audit history.

## One Prompt For Codex On The New Mac

After cloning the repo on the new Mac, open Codex in this project and send:

```text
Read MIGRATION.md and MACHINE_SETUP.md. Restore this SitePulse project as far as possible on this Mac: verify Git status, run ./setup.sh, check .env, run pnpm test, run pnpm test:e2e if Playwright is installed, and tell me only what still needs manual setup.
```

## Final Old-Mac Push

```bash
git status
git add .
git commit -m "Prepare complete Mac migration docs"
git push
```

