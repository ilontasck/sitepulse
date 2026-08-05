# New Mac Codex Prompt

After cloning the repository on the new Mac, open Codex in the project folder and send:

```text
Read MIGRATION.md, MACHINE_SETUP.md, and migration_backup/*.md. Restore this SitePulse project as far as possible on this Mac: verify Git status, check required tools, run ./setup.sh, confirm .env exists, run pnpm test, run pnpm test:e2e if Playwright Chromium is installed, and report only remaining manual steps.
```

