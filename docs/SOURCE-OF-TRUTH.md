# Current source of truth — 2026-09-25

Start with [README](../README.md). The prior 19–20 September report is preserved as [historical evidence](history/SOURCE-OF-TRUTH-2026-09-20.md). Its claims that STE-31 was unavailable are obsolete for this release.

## Git baseline

Fresh `git fetch origin --prune` confirmed:

| Ref | Exact SHA | Relationship |
| --- | --- | --- |
| `origin/main` | `08ef007ba561bf86d2e5ddf76544e061d562dcac` | Existing main; untouched |
| `origin/integration/source-of-truth-2026-09-19` | `ebaebeba088d3045969e29b7ea984ac201dc4c28` | Main + 3 commits (observability, fix, audit document) |
| `origin/feature/ste-31-retention-deletion` | `166c3f8e1d08a2f384cc4e599e3322be39a4b744` | Integration + 5 commits |
| Selected product baseline: `origin/feature/ste-35-transactional-email-foundation` | `6ada04e831fc6dd5fd7c729268886e2c116cb434` | STE-31 + 4, main + 12; zero behind main |

STE-31's five commits are `ebe8b84` (password recovery), `6b25e1d` (legal configuration), `61385a2` (retention/deletion foundation), `74bae4b` (cleanup) and `166c3f8` (wording). Compared with integration: 36 changed files, 1,934 insertions, 422 deletions. Its code includes migrations 007/008, password-confirmed account deletion, report expiry/soft deletion, bounded cleanup, lease/owner protections, legal templates/checker and tests.

Further linear descendants are `0307cba` (quotas), `9c8ef58` (history UI), `d696240` (admin operations), `6ada04e` (email foundation). They include STE-31 without a merge conflict. This is the most complete product baseline found and actually tested. Local `a5e2a5d6872f2f4c17854d42805004572714644d` adds brand research only; no product code is missing by excluding it. NOQORI was not renamed.

Working branch: **`integration/beta-readiness-2026-09-25`**, isolated checkout `beta-readiness-2026-09-25` under the workspace with the trailing space. It fast-forwarded from STE-31 to the selected product baseline before changes. New commits add security fixes, lifecycle regression and documentation. Resolve delivered tip with `git rev-parse integration/beta-readiness-2026-09-25`; the PR records those commits. No main merge/deployment.

## Local inventory and preservation

The workspace `/Users/stefanyavisenko/SitePuls ` contains five pre-existing worktrees sharing the repository:

| Checkout | Initial HEAD | Tracked/untracked state |
| --- | --- | --- |
| `sitepulse` | `3da4e6908140a4282155ced7cb60ab78dd9850ff` | No tracked edits; untracked design-QA screenshots |
| `client-acquisition-toolkit` | `5645cd5997d5cd79ca2d3dfc6179e43ea1fcfa69` | Clean; ignored dependencies |
| `integration-client-acquisition-review` | `08ef007ba561bf86d2e5ddf76544e061d562dcac` | Clean; ignored test data/output |
| `noqori-overnight-2026-09-09` | `203750e82867f398276eaf890012178e5794b7dd` | Untracked dependency symlink/evidence; ignored logs/database |
| `source-of-truth-2026-09-19` | `a5e2a5d6872f2f4c17854d42805004572714644d` | Now on brand-research branch; ignored dependencies/databases |

Two additional empty Git initializations with this origin exist at `~/Projects/sitepulse` and `~/Documents/Pulse Studio/sitepulse`; both have unborn main and no product commits. Their parent `~/Documents/Pulse Studio` is another unborn unrelated repository with untracked project folders. Discovery also checked Desktop, Documents, Projects, the literal `SitePuls%20` path and Codex worktrees. macOS-protected Library/media directories denied enumeration, so no claim is made about inaccessible locations.

All original `.env`, SQLite, lead/outreach/report data, private backup archives, screenshots and evidence remain in place. No reset, clean, stash, force push or old-tree replacement. Dependencies were freshly installed in the new checkout from the unchanged lockfile; no private settings/data copied. Only explicit project paths are staged.

## Validation on Mac

Runtime: Node v24.14.0, pnpm 11.9.0. Baseline `6ada04e`: **359 unit/API tests + 91 Chromium tests passed**. The new regression tests demonstrated failures before their fixes.

Final results after the complete rerun: Linux/systemd and production network sandbox remain **NOT VERIFIED** for this release. Windows application execution was not tested here.

- `pnpm install --frozen-lockfile`: pass; lockfile unchanged.
- `pnpm test`: **364 passed, 0 failed/cancelled/skipped** (57 suites).
- `pnpm test:e2e`: **92 passed, 0 failed**, Chromium, 1.1 minutes.
- Real external `generateAudit("https://example.com")`: pass, `html-real-checks`, all five HTML adapters; no rendered/Lighthouse claim.
- `node scripts/check-legal-placeholders.mjs`: templates valid; **exit 1 / publication blocked** because the gate is false and 12 required genuine runtime fields are absent. Tests with fixture configuration validate the positive checker path, not real legal approval.
- `pnpm audit --prod --json`: zero known advisories in this registry snapshot.
- Syntax: 188 JS/MJS/CJS files passed `node --check`. Documentation: 73 local Markdown links resolve. `git diff --check` and `sh -n setup.sh`: pass.

The original sandbox denied test loopback binding (`EPERM`); full checks were rerun with local execution permission. While developing the new browser test, an incorrect form selector and an overlapping test-server attempt failed; the corrected isolated lifecycle test passed. These are not hidden successful runs.

Most existing UI tests control API responses; real auth tests are separate. The new `e2e/beta-lifecycle.spec.mjs` uses real auth/routes/SQLite/worker/report generation and only fixtures the external website HTML/DNS. It proves queued/running/report/print CSS, private URL rejection, ownership denial, immediate account disablement and physical purge under an advanced test clock. It is not production egress, real email delivery or Linux process supervision acceptance.

See [security review](SECURITY-REVIEW.md), [retention contract](RETENTION-DELETION.md), [legal readiness](LEGAL_READINESS.md) and [separate beta/public blockers](BETA-READINESS.md). Logs and browser artifacts remain local/ignored; no private test traces are published.
