> Historical snapshot, 19–20 September 2026. Superseded by [current status](../SOURCE-OF-TRUTH.md). Claims about missing STE-31 apply only to that snapshot.

# Source of truth — 2026-09-19

Audit started 2026-09-19; validation completed 2026-09-20 Europe/Berlin.

## Authoritative development checkout

- Path: `/Users/stefanyavisenko/SitePuls /source-of-truth-2026-09-19`
- Branch: `integration/source-of-truth-2026-09-19`
- Starting baseline: `3da4e6908140a4282155ced7cb60ab78dd9850ff`.
- Baseline branch: `feature/ste-16-production-observability`.
- Main and freshly queried GitHub main: `08ef007ba561bf86d2e5ddf76544e061d562dcac`.
- Baseline is exactly two commits ahead of main, zero behind. It contains every current main commit plus reviewed STE-16 implementation and fixes. Fresh unit/API and browser validation below confirms this is the most complete tested local product state, not merely the newest timestamp.
- Integration adds this audit document only. Runtime code, NOQORI assets, auth, security and legal text are unchanged from the tested baseline. No MERALYNT rebrand, new UI, feature implementation, automatic conflict selection, or main merge.
- Resolve the documentation commit/final checkout SHA with `git rev-parse integration/source-of-truth-2026-09-19`; a commit cannot embed its own SHA. The delivery response records it.

## Read-only inventory and dependencies

Before any repository modification: inspected status, HEAD, all refs, worktrees, full commit graph, patch equivalence, range-diff, ignored/untracked files and project copies. No tracked staged or unstaged changes existed in any checkout.

The workspace root is not itself a Git repository. Recursive discovery, excluding dependency caches and Git internals, found exactly four existing project checkouts and no additional independent project copy. The new integration checkout is a fifth worktree sharing the same object database.

| Original checkout | Branch | HEAD | Initial status |
| --- | --- | --- | --- |
| `sitepulse` | `feature/ste-16-production-observability` | `3da4e69` | untracked `docs/design-qa/` |
| `client-acquisition-toolkit` | `feature/client-acquisition-toolkit` | `5645cd5` | clean |
| `integration-client-acquisition-review` | `integration/client-acquisition-review` | `08ef007` | clean (ignored local outputs exist) |
| `noqori-overnight-2026-09-09` | `overnight/2026-09-09` | `203750e` | untracked `node_modules` symlink and `overnight-evidence/` |

All checkout paths above are under `/Users/stefanyavisenko/SitePuls ` (the trailing space is part of the path).

| Local branch | Tip | Integration decision |
| --- | --- | --- |
| `main` | `08ef007` | Included unchanged as ancestor; main not moved |
| `integration/client-acquisition-review` | `08ef007` | Included as ancestor |
| `feature/ste-16-production-observability` | `3da4e69` | Selected baseline, including `209da44` and `3da4e69` |
| `feat-authenticated-frontend-csp` | `b5be6f7` | Ancestor; includes `c51aab8` authenticated UI/CSP and email rate limiting |
| `ste-12-browser-network-sandbox` | `bcb51cf` | Ancestor; later fixes through `8a239aa` already included |
| `ste-13-process-supervisor` | `f7d24ec` | Ancestor |
| `ste-23-loading-queue-experience` | `28b0636` | Ancestor; NOQORI experience retained |
| `ste-25-production-assets` | `f07cfe9` | Ancestor; assets retained |
| `feature/client-acquisition-toolkit` | `5645cd5` | All six patches already included under replacement SHAs; do not merge again |
| `overnight/2026-09-09` | `203750e` | All final code/tests already included; historical report remains on original branch |

Read-only `git ls-remote --heads origin` returned exactly these GitHub branches:

- `main`: `08ef007ba561bf86d2e5ddf76544e061d562dcac`
- `feat-authenticated-frontend-csp`: `b5be6f79a47e1201e30a472cc686876693a9086a`
- `ste-12-browser-network-sandbox`: `8a239aad8d69ab32caa94360b01e49abd0b66af7`

Cached remote refs match these values; `origin/HEAD` points to `origin/main`. No fetch, prune, reset or alteration of those branches was needed.

Simplified dependency graph (the complete graph is in the local backup):

```text
e944324 NOQORI report hierarchy
  -> 28b0636 loading/queue -> f07cfe9 assets -> f7d24ec supervisor
  -> bcb51cf sandbox -> 9a71ab1/e4b163c/8a239aa acceptance fixes
  -> c51aab8 authenticated frontend/CSP -> b5be6f7 login limiting
       |-> overnight fixes/tests -> 203750e historical report
       |-> 75e4a30/8e48007/f12ddf1/9c34c60/bd1ce26 (integrated overnight)
             |-> db6e276..cd72784 (equivalent toolkit patches)
                  -> 3ca206b -> 5942c0c -> 08ef007 main + review branch
                  -> 209da44 -> 3da4e69 observability + integration baseline
```

Known states verified as actual commit objects:

- `e944324fbf3699aa3d8fae94445bbb659260b3f7`
- `b5be6f79a47e1201e30a472cc686876693a9086a`
- `08ef007ba561bf86d2e5ddf76544e061d562dcac`
- `3da4e6908140a4282155ced7cb60ab78dd9850ff`

The toolkit feature branch diverged at `75e4a30`; its six commits run from `c4b9f51` through `5645cd5`. `git cherry main feature/client-acquisition-toolkit` marks all six commits as patch-equivalent. Mappings: `c4b9f51 -> db6e276`, `ee66e8b -> e10ddab`, `5b9389b -> 8daf2b7`, `513c60d -> 401ba99`, `ef1a385 -> 13f4a90`, `5645cd5 -> cd72784`. Main also includes three subsequent correctness/privacy fixes; older toolkit files must not replace them.

Overnight mappings: `1ab8547 -> 75e4a30`, `564ad00 -> 8e48007`, `df8cf03 -> f12ddf1`, `f35f38a -> 9c34c60`. `fea4a4e` plus `025027c` have the same final E2E tree as main through `bd1ce26`. This was checked with range-diff and an empty E2E tree diff, rather than relying on individual commit messages. The only unique added file in overnight is `OVERNIGHT-REPORT.md`; it is historical evidence, not missing product code. Its old configuration and launch statements are not promoted to current truth.

## Preservation and work deliberately left separate

Local backup: `/Users/stefanyavisenko/SitePuls /source-of-truth-backup-2026-09-19` (private directory, not committed or pushed).

- `refs/backup/source-of-truth-2026-09-19/heads/*` and `remotes/*` preserve all 14 initial refs; each target was read back and verified.
- `repository.bundle` contains complete reachable history and passed `git bundle verify`.
- Each original checkout has `status.txt`, binary `staged.patch`, binary `unstaged.patch`, and `untracked-and-ignored.tar.gz`. Patches are empty because no tracked edits existed.
- Archives were reopened and every archived regular file compared against its source SHA-256; symlink targets were verified. Counts: sitepulse 113, toolkit 0, review checkout 2, overnight 25 entries. `manifest.json` records hashes, initial statuses and HEADs.
- Sitepulse includes all 16 `docs/design-qa/noqori-current/*.png` screenshots. They remain user-owned, untracked and unchanged, not silently adopted as new design requirements.
- Ignored local environment/data/report/test files were preserved too. These backups may contain private data; they stay local. Installed dependency directory contents were excluded; the lockfile and original installation remain, and the overnight `node_modules` symlink was preserved as a symlink.
- Original `.env`, SQLite files, leads/outreach/reports, overnight config proposals and evidence are not imported into the new checkout. Tests use the integration checkout's own data paths and a copied dependency installation.
- No original worktree, file, branch or user edit was deleted, reset, stashed, overwritten or cleaned.

Additional object audit found 62 unreachable objects, including four old commits. All were saved in `unreachable.pack`/`.idx` and passed `git verify-pack`; all four commits additionally have `refs/backup/source-of-truth-2026-09-19/recovered/<sha>` refs:

- `e2bcbc7` / `7cd2bbc`: historical Module 05 design stash and index snapshot. Final `8f11718` contains subsequent report fixes (20 insertions, 2 deletions versus the stash in index.html), followed by later design/auth work. Preserved, not replayed over newer UI.
- `2e766ff` / `9be4f7a`: intermediate STE-12 acceptance commits. Final `9a71ab1` adds explicit QUIC validation and readiness-before-claim protections and updated evidence; intermediate snapshots must not replace it.

Full initial statuses, branch list, refs, graph and worktree inventory are retained in the backup. No existing stash entries were present. No corruption was reported by `git fsck`.

## Fresh validation

Runtime: Node `v24.14.0`; existing lockfile/dependencies, no dependency upgrades.

| Check | Result |
| --- | --- |
| `pnpm test` (complete unit/API/integration suite) | PASS: 295 tests, 48 suites, 0 failed/cancelled/skipped/todo; 2.972 s |
| `pnpm test:e2e` | PASS: 51 Chromium tests, 0 failed; 57.2 s; includes real login/logout, session recovery, throttling, CSP and NOQORI layout flows |
| `node --check` on all tracked JS/MJS/CJS | PASS: 156 files |
| `sh -n setup.sh` | PASS |
| `git diff --check` | PASS before documentation commit |
| `node scripts/check-legal-placeholders.mjs` | FAIL, exit 1: 38 matches (privacy 18, impressum 11, terms 9); includes illustrative markers in page comments |
| `pnpm verify:systemd` | UNAVAILABLE: verifier reports Linux required; wrapper exit 0 is not a validation pass |

Initial sandbox execution blocked local server sockets (`EPERM`, explicitly on E2E port 3010); the sandbox unit process stalled and was stopped. Complete reruns with local execution permission passed. These are environment failures, not omitted product failures. Logs are in `unit-api-approved.log`, `e2e-approved.log`, `legal-check.log`, `systemd-check.log` in the backup; initial failed/stalled logs also remain.

This branch is a verified development baseline, not a public-launch approval. Pushing the integration Git branch does not deploy legal pages or production services.

## Actual remaining launch blockers and evidence limits

1. Legal checker fails: business/controller identity, contact/address, hosting/location, dates, retention, jurisdiction and other legal decisions remain unresolved. Do not invent values; follow `docs/LEGAL_READINESS.md` and obtain the required review.
2. Audit/job retention and account erasure implementation are missing from this available baseline. Session cleanup exists but does not supply general retention or account deletion.
3. STE-31 backend/branch is unavailable, as detailed below. It cannot be treated as completed or merely awaiting UI.
4. This Mac run cannot validate Linux/systemd deployment, network namespace enforcement or fresh production attestation for the current bundle. Existing STE-12 historical evidence is retained; STE-16 rollout needs migration 006, compatible RPC v2 services and fresh runtime checks.
5. Observability alert scheduling/delivery and production journal retention remain operator work according to `docs/PRODUCTION-OBSERVABILITY.md`. No deployment or notification setup was performed.

No external Linear issue status was changed or inferred from historical reports. STE-30/STE-33 and branding work were not implemented. The audit establishes only the repository states available here and on the configured GitHub origin.

## Exact STE-31 transfer plan (future work)

1. Start from this integration branch and record its final SHA. Do not branch from an older auth or overnight snapshot.
2. Obtain the real `ste-31-data-retention` checkout, bundle, remote branch or backend commit. It is absent from local branches, all configured remote heads, workspace checkouts, reflog search and recovered commit messages. Current `src/http/auth-routes.mjs` supports config/register/login/me/logout, not `DELETE /api/auth/account`; migrations stop at 006.
3. Preserve any incoming dirty checkout exactly as above. Inspect ancestry and full diff against this baseline before selecting backend commits. Transfer only reviewed retention/erasure changes in dependency order; never copy an entire old source tree. If the implementation cannot be recovered, agree a separate backend specification and implement it before the UI; this is not completed work.
4. Review schema/migration numbering against observability migration 006, transaction behavior, audit/job ownership, active worker leases, session revocation and deletion races. Preserve current trusted Origin, strict JSON/CSRF protections, active-session authorization and rate limits; do not assume a CSRF-token endpoint exists in this baseline.
5. Run recovered backend unit/API tests before adding UI. Confirm request body/password/confirmation contract, response codes, cookie clearing and erasure/retention behavior from that actual implementation.
6. Use TDD at the public HTTP boundary and authenticated browser interface (`index.html`, `assets/noqori/app.js`, existing auth panel). Agree seams before writing tests per the local TDD skill. Add the smallest NOQORI-consistent account section only in the subsequent STE-31 task.
7. Cover success, wrong password, missing confirmation, expired/missing session, untrusted/missing Origin and CSRF-relevant request forms, request failure/loading and successful logged-out state. Retain login/logout/session recovery regressions. Ensure cleared sensitive UI and no stale async completion restores authenticated state.
8. Run full unit/API and available Playwright suites, syntax and legal checks; review security/privacy/design deltas, correct findings, and make separate backend/UI/review commits. Document real launch blockers and evidence before deciding whether STE-31 can close in Linear. No automatic main merge.
