# Machine Setup For SitePulse

This document describes the development environment needed to work on SitePulse from a fresh Mac.

## Git

Required.

Install:

```bash
xcode-select --install
brew install git
```

Configure on the new Mac:

```bash
git config --global user.name "ilontasck"
git config --global user.email "stefanio2021@gmail.com"
```

GitHub auth options:

```bash
brew install gh
gh auth login
gh auth setup-git
```

Observed old global Git config used a GitHub CLI credential helper at an old absolute path. Recreate GitHub auth on the new Mac instead of copying that path.

## Homebrew

Install Homebrew:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Required or recommended formulae:

```bash
brew install git node pnpm sqlite gh
```

Observed Homebrew version during prep: `6.0.2`.

Observed old Homebrew leaves:

```text
git
pipx
pkgconf
swig
wget
```

Only `git`, `node`, and `pnpm` are required for this project. `sqlite` and `gh` are recommended.

## Node

Required.

Project requirement:

```text
Node.js >=22.5
```

Version used for verification in Codex:

```text
v24.14.0
```

Install with Homebrew:

```bash
brew install node
node -v
```

## pnpm

Required package manager.

Project package manager:

```text
pnpm@11.9.0
```

Install:

```bash
brew install pnpm
pnpm --version
```

Alternative if using Corepack:

```bash
corepack enable
corepack prepare pnpm@11.9.0 --activate
```

## npm

npm is not used directly by this project. It may be installed with Node, but project commands should use pnpm.

## Playwright

Required for e2e tests.

Project dependency:

```text
@playwright/test ^1.61.1
```

Install browser binaries:

```bash
pnpm exec playwright install chromium
```

This is already done by:

```bash
./setup.sh
```

Run e2e tests:

```bash
pnpm test:e2e
```

## SQLite

The app stores local audit data in:

```text
data/sitepulse.sqlite
```

The app uses Node's built-in `node:sqlite` module. The `sqlite3` CLI is optional but useful:

```bash
brew install sqlite
sqlite3 data/sitepulse.sqlite
```

The database file is runtime state and is ignored by Git.

## VS Code

VS Code is optional. The `code` CLI was not found in PATH during prep.

Useful extensions if you use VS Code:

```text
dbaeumer.vscode-eslint
esbenp.prettier-vscode
ms-playwright.playwright
GitHub.vscode-github-actions
```

No `.vscode/` project settings are required for SitePulse.

## Codex

Codex app state lives outside the project, usually under:

```text
~/.codex/
~/.agents/
```

Do not commit or blindly copy:

```text
~/.codex/auth.json
~/.codex/*.sqlite
~/.codex/logs*
~/.codex/sessions
~/.codex/browser
~/.codex/attachments
```

On the new Mac:

1. Install/open Codex.
2. Sign in.
3. Reconnect GitHub and any other connectors.
4. Reinstall or copy personal skills only if you rely on them.
5. Open the cloned `sitepulse` folder.
6. Ask Codex to read `MIGRATION.md` and finish setup.

## CLI Tools

Required:

```text
git
node
pnpm
sh
```

Recommended:

```text
gh
sqlite3
brew
```

Not required:

```text
npm global packages
VS Code CLI
custom shell aliases
```

## Global npm Packages

No global npm packages are required. The project uses local dependencies from `package.json`.

## Shell Settings

No project-specific shell settings are required.

Observed files outside the project:

```text
~/.zshrc
~/.npmrc
~/.gitconfig
```

Do not copy `.npmrc` into the repository because it can contain registry tokens.

## New Mac Bootstrap

```bash
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install git node pnpm sqlite gh
gh auth login
git clone https://github.com/ilontasck/sitepulse.git
cd sitepulse
./setup.sh
pnpm start
```

