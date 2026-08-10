# Codex Skills Index

This index describes the skills exported in `migration_backup/codex/`.

Restore instructions live in `RESTORE.md`. User-installed skills are under `home/.agents/skills/`. System skills are under `home/.codex/skills/.system/` as a reference backup; Codex normally recreates system skills after install/sign-in.

## User Skills

| Skill | Description | Used When | Known Dependencies |
| --- | --- | --- | --- |
| `ask-matt` | Router over the local engineering/writing skill set. | You are unsure which skill or flow fits the task. | Routes to many skills, especially `grill-with-docs`, `grill-me`, `handoff`, `prototype`, `to-spec`, `to-tickets`, `implement`, `tdd`, `code-review`, `triage`, `diagnosing-bugs`, `wayfinder`, `domain-modeling`, `codebase-design`. |
| `batch-grill-me` | Relentless interview that asks all currently unblocked frontier questions round by round. | You want a broad design/decision interview with many questions at once. | No explicit dependency. |
| `claude-handoff` | Hands the current conversation to a fresh background Claude agent. | You want another agent to continue work immediately from a summary. | Depends on external `claude --bg` CLI being available. |
| `code-review` | Reviews changes since a fixed point along Standards and Spec axes. | You ask for a branch/PR/WIP review, or “review since X”. | Expects issue tracker docs from `setup-matt-pocock-skills` when missing; may spawn review sub-agents. |
| `codebase-design` | Vocabulary for deep modules, interfaces, seams, adapters, depth, and locality. | You want to design/improve a module interface or make code more testable/agent-navigable. | Used by `tdd` and `improve-codebase-architecture`; may support `grill-with-docs`. |
| `design-an-interface` | Generates multiple radically different module/API interface designs using parallel sub-agents. | You want to explore API/module shape options or mention “design it twice”. | Uses `codebase-design` vocabulary. |
| `diagnosing-bugs` | Diagnosis loop for hard bugs, regressions, flakes, failures, and performance issues. | You say “diagnose/debug this” or report something broken, slow, failing, or throwing. | May hand findings to `improve-codebase-architecture`; usually creates a regression test. |
| `domain-modeling` | Builds and sharpens domain language and architectural/domain decisions. | You need glossary terms, ubiquitous language, or ADR-style decisions. | Used by `grill-with-docs`; related to `ubiquitous-language`. |
| `edit-article` | Edits article drafts for structure, clarity, and tighter prose. | You want to revise or improve an article draft. | No explicit dependency. |
| `find-skills` | Helps discover and install agent skills. | You ask “is there a skill for X?” or want to extend capabilities. | May lead to skill installation; recorded in `.skill-lock.json`. |
| `git-guardrails-claude-code` | Sets up Claude Code hooks to block dangerous git commands. | You want to prevent `push`, `reset --hard`, `clean`, branch deletion, etc. in Claude Code. | Depends on Claude Code hook support. |
| `grill-me` | Relentless interview to sharpen a plan or design without repo-backed docs. | You want to stress-test an idea/plan outside a codebase. | Uses the same interviewing primitive as `grilling`. |
| `grill-with-docs` | Relentless interview that also creates ADRs/glossary/domain docs. | You want to sharpen a repo-backed plan/design and leave a paper trail. | Uses `grilling` and `domain-modeling`; may feed `to-spec`/`to-tickets`. |
| `grilling` | Core interview primitive for stress-testing plans, decisions, and ideas. | You use grill trigger phrases or need a relentless decision interview. | Used by `grill-me` and `grill-with-docs`. |
| `handoff` | Compacts a conversation into a handoff document for another agent/session. | You need to continue in a fresh session or preserve context across sessions. | Often bridges to/from `prototype` or multi-agent flows. |
| `implement` | Implements work from a spec or ticket. | You want a spec/ticket built in code. | Drives `tdd` internally and closes with `code-review` in the documented flow. |
| `improve-codebase-architecture` | Scans a codebase for deepening opportunities, reports them visually, then grills a chosen one. | You want to improve codebase architecture or find agent-friendly refactor opportunities. | Uses `codebase-design`; can feed `grill-with-docs`. |
| `loop-me` | Interviews the user about workflow specs within the workspace. | You want to design/spec workflows through repeated questioning. | No explicit dependency. |
| `migrate-to-shoehorn` | Migrates tests from `as` type assertions to `@total-typescript/shoehorn`. | You mention shoehorn, replacing `as` in tests, or partial test data. | Depends on TypeScript test context and shoehorn package adoption. |
| `obsidian-vault` | Searches, creates, and manages Obsidian notes with wikilinks and indexes. | You want to find, create, or organize notes in Obsidian. | Depends on an accessible Obsidian vault. |
| `prototype` | Builds throwaway prototypes to answer design/state/UI questions. | A design question needs runnable proof rather than discussion. | Often paired with `handoff` from/to larger planning flows. |
| `qa` | Conversational QA session that files GitHub issues from user-reported bugs. | You want to report bugs, do QA, or file issues conversationally. | Depends on GitHub/issue tracker access for filing. |
| `request-refactor-plan` | Creates a detailed refactor plan with tiny commits, then files it as an issue. | You want to plan a refactor or break it into safe steps. | Depends on issue tracker setup/access. |
| `research` | Investigates a question against high-trust primary sources and writes findings to Markdown. | You want docs/API facts or reading legwork delegated. | May use background agents and web/primary-source access. |
| `resolving-merge-conflicts` | Resolves in-progress git merge/rebase conflicts. | You are inside a conflicted merge or rebase. | Depends on Git conflict state. |
| `scaffold-exercises` | Creates exercise directories with sections, problems, solutions, and explainers. | You want to scaffold course/exercise material. | No explicit dependency. |
| `setup-matt-pocock-skills` | Configures a repo for the engineering skill suite. | First-time setup before using the engineering flows in a repo. | Foundation for issue tracker docs, triage labels, and domain docs used by other skills. |
| `setup-pre-commit` | Sets up Husky pre-commit hooks with lint-staged, formatting, type checks, and tests. | You want commit-time formatting/typechecking/testing hooks. | Depends on Node package tooling; may add Husky/lint-staged. |
| `setup-ts-deep-modules` | Wires dependency-cruiser into a TypeScript repo for deep-module boundaries. | You want TypeScript package/module boundary enforcement. | Uses dependency-cruiser; related to `codebase-design`. |
| `tdd` | Test-driven development workflow. | You want red-green-refactor, integration tests, or test-first feature/bug work. | Uses `codebase-design` vocabulary; used by `implement`. |
| `teach` | Teaches a concept over multiple sessions using the workspace as state. | You want to learn a skill/concept over time. | Uses its bundled format templates. |
| `to-questionnaire` | Turns unresolved decisions into a questionnaire for someone else. | You need answers from another person before proceeding. | Often follows planning/grilling. |
| `to-spec` | Synthesizes the current conversation into a spec and publishes it to the issue tracker. | You already discussed the idea and want a written spec. | Often follows `grill-with-docs` or `wayfinder`; depends on issue tracker setup. |
| `to-tickets` | Breaks a plan/spec/conversation into tracer-bullet tickets with blocking edges. | You need independently grabbable implementation issues. | Typically follows `to-spec`; depends on configured issue tracker. |
| `triage` | Moves issues/PRs through categorization, verification, grilling if needed, and agent-ready briefs. | You need to process incoming issues or external PRs. | Depends on issue tracker docs/setup; may produce work for `implement`. |
| `ubiquitous-language` | Extracts a DDD-style glossary and flags ambiguous terms. | You want domain terms, glossary, DDD language, or terminology cleanup. | Related to `domain-modeling`. |
| `wayfinder` | Plans work too large for one session as decision tickets until the path is clear. | A large greenfield/feature effort is too foggy for one thread. | Hands off to `to-spec`, then `to-tickets` and `implement`. |
| `wizard` | Generates interactive bash wizards for manual procedures and migrations. | You need a human-guided setup/migration script that opens URLs and captures values. | May use external CLIs/APIs depending on the generated wizard. |
| `writing-beats` | Assembles raw material into a journey of grounded writing beats. | You want to shape writing at the beat/sequence level. | Works with the writing skill family. |
| `writing-fragments` | Mines raw fragments before structure exists. | You are exploring rough writing material. | Works with the writing skill family. |
| `writing-great-skills` | Reference for writing and editing predictable skills. | You are authoring or improving skills. | Supports `skill-creator`-style work conceptually. |
| `writing-shape` | Shapes raw material into an article paragraph by paragraph. | You want to turn material into a coherent article. | Works with the writing skill family. |

## System Skill Reference

| Skill | Description | Used When | Known Dependencies |
| --- | --- | --- | --- |
| `imagegen` | Generates or edits raster images such as photos, illustrations, textures, sprites, mockups, and cutouts. | You ask Codex to create or transform bitmap images rather than code/vector assets. | Uses image generation tooling; includes scripts/assets/references. |
| `openai-docs` | Official-docs workflow for OpenAI products, APIs, Codex, models, prompting, and upgrades. | You ask how to build with OpenAI products or need current official OpenAI documentation. | Uses OpenAI docs MCP/tools when available; may use bundled helper scripts and official web fallback. |
| `plugin-creator` | Scaffolds Codex plugin directories and manifests. | You want to create/update a personal plugin or marketplace entry. | Uses bundled Python validation/scaffold scripts. |
| `review-agent` | Read-only defect-first code review agent. | Another agent delegates review of a diff, commit, branch, or custom review target. | Intended for delegated review workflows. |
| `skill-creator` | Guidance for creating or updating Codex skills. | You want to create or improve a skill. | Can use bundled scripts/references for validation and metadata. |
| `skill-installer` | Installs Codex skills from curated lists or GitHub repo paths. | You ask to list or install skills, including private-repo skills. | Requires network/GitHub access; uses bundled install/list scripts. |

## Restore Notes

- Primary restore path for user skills: copy `migration_backup/codex/home/.agents/skills` back to `~/.agents/skills`.
- Also restore `migration_backup/codex/home/.agents/.skill-lock.json` to `~/.agents/.skill-lock.json`.
- System skills under `home/.codex/skills/.system` are a reference backup. Prefer letting Codex recreate them, then use this copy only if something is missing.
- Do not restore raw Codex auth, session, cache, or SQLite state from the old Mac. See `RESTORE.md`.
