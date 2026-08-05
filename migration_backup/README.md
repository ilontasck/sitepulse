# Migration Backup

This folder contains safe, non-secret migration notes and templates for restoring SitePulse on a new Mac.

Included:

```text
codex/
environment-template.md
external-dependencies.md
new-codex-prompt.md
project-restore-checklist.md
```

Not included:

```text
.env
~/.npmrc
~/.codex/auth.json
Codex SQLite state/log databases
GitHub tokens
local SQLite audit database
node_modules/
Playwright browser cache
```

Secrets and machine-specific state should be restored manually by signing in again or copying private files outside Git.

`codex/` contains exported local agent skills and Codex skill restore instructions. It intentionally excludes Codex auth, logs, sessions, SQLite state, browser state, and plugin caches.
