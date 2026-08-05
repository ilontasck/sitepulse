# External Dependencies Inventory

This is a safe inventory of dependencies found outside the SitePulse repository.

## Required For This Project

```text
git
node >=22.5
pnpm 11.9.0-compatible
Playwright Chromium browser installed by pnpm exec playwright install chromium
```

## Observed On Old Mac / Codex Session

```text
Homebrew: /usr/local/bin/brew, version 6.0.2
Git: version 2.15.0
SQLite CLI: /usr/bin/sqlite3, version 3.37.0
Codex verification Node: v24.14.0
Codex verification pnpm: 11.9.0
Playwright CLI: 1.61.1
```

The repository includes `.node-version` with `24.14.0`. Any Node.js version `>=22.5` is supported by `package.json`.

Observed Homebrew leaves:

```text
git
pipx
pkgconf
swig
wget
```

## User/Machine Files Found

```text
~/.gitconfig
~/.npmrc
~/.zshrc
~/.config/gh
~/.codex/
~/.agents/
```

## Codex And Skills

User-installed skills were found under:

```text
~/.agents/skills
~/.codex/skills
```

Examples of user skill names observed:

```text
ask-matt
code-review
codebase-design
diagnosing-bugs
domain-modeling
find-skills
grilling
prototype
qa
research
tdd
```

These are not required to run SitePulse, but they may affect your Codex workflow. Reinstall/copy them on the new Mac if you rely on them.

## Not Safely Exported

```text
~/.npmrc
~/.codex/auth.json
~/.codex/*.sqlite
~/.codex/*.sqlite-shm
~/.codex/*.sqlite-wal
~/.codex/logs*
~/.codex/sessions
~/.codex/browser
~/.codex/attachments
```

Restore these through sign-in, connector setup, or a private manual backup outside Git.
