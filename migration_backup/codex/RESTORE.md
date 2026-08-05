# Codex Skills Restore

This folder exports the portable Codex/agent skill layer found outside the SitePulse repository.

## What Was Exported

Portable and safe to restore:

```text
home/.agents/.skill-lock.json
home/.agents/skills/
home/.codex/skills/.system/
home/.codex/config/config.toml.template
```

Meaning:

- `home/.agents/skills/` contains locally installed user agent skills and their `agents/openai.yaml`, scripts, templates, and reference docs.
- `home/.agents/.skill-lock.json` records skill installer metadata and the selected agent list.
- `home/.codex/skills/.system/` is a reference copy of system skills currently present on the old Mac. Codex normally restores these itself, so this is backup/reference, not something to overwrite by default.
- `home/.codex/config/config.toml.template` is a safe, redacted template derived from `~/.codex/config.toml`.

## What Was Not Copied

These files are used by Codex but should not be committed or copied through this project because they contain auth state, machine state, history, caches, logs, or absolute paths:

```text
~/.codex/auth.json
~/.codex/config.toml
~/.codex/*.sqlite
~/.codex/*.sqlite-shm
~/.codex/*.sqlite-wal
~/.codex/sqlite/
~/.codex/logs_*.sqlite*
~/.codex/state_*.sqlite*
~/.codex/goals_*.sqlite*
~/.codex/memories_*.sqlite*
~/.codex/sessions/
~/.codex/attachments/
~/.codex/browser/
~/.codex/cache/
~/.codex/plugins/cache/
~/.codex/.tmp/
~/.codex/ipc/
~/.codex/tmp/
~/.codex/session_index.jsonl
~/.codex/transcription-history.jsonl
```

Restore those by signing into Codex again, reconnecting tools/plugins, and letting Codex rebuild local cache/state.

## Restore Locations On The New Mac

From the cloned SitePulse repository:

```bash
mkdir -p ~/.agents ~/.codex/skills
cp -R migration_backup/codex/home/.agents/skills ~/.agents/
cp migration_backup/codex/home/.agents/.skill-lock.json ~/.agents/.skill-lock.json
```

Optional system-skill reference restore:

```bash
mkdir -p ~/.codex/skills
cp -R migration_backup/codex/home/.codex/skills/.system ~/.codex/skills/
```

Usually you should skip that optional command and let Codex install system skills itself. Use the backup only if Codex opens without expected system skills after sign-in.

## Restore Config

Do not overwrite `~/.codex/config.toml` with the old raw file. It had old-Mac absolute paths.

Use this template as a checklist instead:

```text
migration_backup/codex/home/.codex/config/config.toml.template
```

Manual config steps:

1. Open Codex on the new Mac.
2. Sign in.
3. Reconnect GitHub and any connectors you use.
4. Enable the same plugins if needed:
   - browser
   - chrome
   - sites
   - visualize
   - documents
   - pdf
   - spreadsheets
   - presentations
   - template-creator
5. Open the cloned SitePulse folder and trust it when prompted.
6. If you need the same model preference, set `gpt-5.6-sol` and low reasoning effort in Codex settings if available.

## Verify Skills Are Available

After restore, open Codex in the SitePulse project and ask:

```text
List the available local skills and confirm that ~/.agents/skills is being read. Then read MIGRATION.md and MACHINE_SETUP.md and verify this project setup.
```

Expected user skills include examples such as:

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

If those do not appear, restart Codex after copying `~/.agents/skills`.

## Files That Require Manual Restore

Manual only:

- Codex sign-in/auth.
- GitHub connector auth.
- Gmail/Slack/Google Drive/Figma/Linear/etc connector auth.
- Browser sessions.
- Conversation history.
- Codex local memories/state.
- Plugin cache.

These are not necessary for SitePulse to run, but they affect your personal Codex workflow.
