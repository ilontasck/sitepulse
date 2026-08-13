# Day 4 Real-World Async Audit Soak

Date: 2026-08-13

## Environment

- Commit: `77b72621aeb7cef9483b25a11a4a90cdfabd9081`
- Web server and worker ran as separate Node.js processes.
- Both processes shared an isolated temporary SQLite database; production data was not used.
- Normal URL normalization, DNS resolution, SSRF checks, redirects, worker-side revalidation, leases, and telemetry remained enabled.
- HTML and rendered runs used separate temporary databases.
- Rendered mode used `RENDERED_AUDIT_MAX_CONCURRENCY=1`.
- Requests were sequential except for the explicit five-job queue smoke; no authentication, private endpoints, or aggressive concurrency were used.

Baseline before real-site testing: 100 unit/API tests and 11 Playwright E2E tests passed.

## HTML sites and results

The transition column is reconstructed from persistent timestamps. Public polling sometimes observed `queued -> completed` because these HTML audits completed between one-second polls.

| Submitted URL | Normalized/final URL | Job ID | Transition | Attempts | Queue wait | Audit duration | Scanner/status | Warnings | Score | Persisted / readable | Worker alive / unexpected errors |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | --- | --- |
| `https://example.com` | `https://example.com` | `312b7bb4-6cf4-4efa-b476-131a34b59542` | queued -> running -> completed | 1 | 51 ms | 92 ms | `html-real-checks` / `html-audit-completed` | 0 | 76 | yes / yes | yes / none |
| `https://www.wikipedia.org` | `https://www.wikipedia.org` | `4bd1acdb-2da3-483d-aa15-8df6e667cda8` | queued -> running -> completed | 1 | 125 ms | 104 ms | `html-real-checks` / `html-audit-completed` | 0 | 82 | yes / yes | yes / none |
| `https://react.dev` | `https://react.dev` | `671b54f2-8d43-42ff-9b69-1b60bfa57e64` | queued -> running -> completed | 1 | 188 ms | 126 ms | `html-real-checks` / `html-audit-completed` | 0 | 79 | yes / yes | yes / none |
| `https://github.com` | `https://github.com` | `d6ef5d95-84c8-42f8-8b5e-d0acf0848cc1` | queued -> running -> completed | 1 | 100 ms | 159 ms | `html-real-checks` / `html-audit-completed` | 0 | 88 | yes / yes | yes / none |
| `https://www.cloudflare.com` | `https://www.cloudflare.com` | `6877342e-6100-429a-ac51-ef48a6663dc4` | queued -> running -> completed | 1 | 51 ms | 681 ms | `html-real-checks` / `html-audit-completed` | 0 | 85 | yes / yes | yes / none |
| `https://www.mozilla.org` | `https://www.mozilla.org/en-US` | `c8d6b105-39fe-4ee6-a23f-1d385c94a673` | queued -> running -> completed | 1 | 113 ms | 775 ms | `html-real-checks` / `html-audit-completed` | 0 | 89 | yes / yes | yes / none |
| `https://nodejs.org` | `https://nodejs.org/en` | `e90175e7-20c3-44a0-bcd5-88cd7b89f740` | queued -> running -> completed | 1 | 68 ms | 229 ms | `html-real-checks` / `html-audit-completed` | 0 | 86 | yes / yes | yes / none |
| `https://w3.org` | `https://www.w3.org` | `090b3056-655c-400e-b7d2-f772ed3147e0` | queued -> running -> completed | 1 | 88 ms | 159 ms | `html-real-checks` / `html-audit-completed` | 0 | 81 | yes / yes | yes / none |

All eight jobs completed on attempt one. The worker remained alive after every job, every report returned HTTP 200, and no unexpected server or worker errors were observed.

## Five-job queue test

Five POST requests were sent back-to-back to one worker. POST latency was 2-29 ms and every response was HTTP 202.

| Enqueue order | Target | Job ID | Queue wait | Audit duration | Result |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | `example.com` | `c019f642-f22c-44c0-889e-191a30ca7a69` | 19 ms | 66 ms | completed |
| 2 | `wikipedia.org` | `ea91692f-01ce-4160-8c37-b8a37a609970` | 66 ms | 92 ms | completed |
| 3 | `react.dev` | `b4c099e7-174a-4c9d-b853-f7e657760126` | 157 ms | 106 ms | completed |
| 4 | `github.com` | `398e178a-0da6-49b3-bfba-83cbe24b5cab` | 251 ms | 151 ms | completed |
| 5 | `nodejs.org` | `f6c64b08-0bf4-45bb-ade0-7b1080409d02` | 402 ms | 222 ms | completed |

Claim/start order matched enqueue order. All job and audit IDs were unique, health/status polling stayed responsive, every report was readable, and the worker remained alive. No jobs or audit records were lost or duplicated.

## Rendered and Lighthouse results

| Site | Job ID | Total job duration | Lighthouse duration | LCP | CLS | FCP | Speed Index | TBT | Perf. | A11y | Best practices | SEO | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `example.com` | `1b1f4b4e-4e79-4744-9a66-a75886636bca` | 8.05 s | 7.97 s | 793 ms | 0 | 793 ms | 793 ms | 0 ms | 100 | 96 | 96 | 80 | full rendered |
| `react.dev` | `9b14aa47-f61d-4360-a608-56eb7342436b` | 9.33 s | 9.22 s | 2,845 ms | 0 | 1,195 ms | 1,955 ms | 20 ms | 95 | 95 | 100 | 92 | full rendered |
| `wikipedia.org` | `d26ed30c-cc4b-4ad3-8986-749801d04156` | 7.71 s | 7.61 s | 1,500 ms | 0.106 | 1,227 ms | 1,227 ms | 0 ms | 97 | 95 | 100 | 100 | full rendered |

All three jobs completed on attempt one with scanner status `full-rendered-completed`; no HTML fallback occurred. Each report included the expected warning that lab TBT is only a diagnostic proxy and does not measure field INP. React reported 28 failed subresource requests and Wikipedia reported two, but both audits completed without page/console errors or blocked unsafe requests. No Chromium crash was observed.

## Resource observations

- Worker RSS before the first rendered job: approximately 242 MiB.
- Worker RSS after job 1: approximately 405 MiB.
- Highest worker RSS observed after job 2: approximately 507 MiB.
- Worker RSS after job 3: approximately 397 MiB.
- CPU samples outside the short Chromium execution windows were approximately 1-2%.
- Chromium processes were absent after every completed job and after shutdown.
- Memory did not grow linearly across the three-job sequence, although the initial Lighthouse run materially increased the worker footprint. These are approximate process observations, not a controlled benchmark.

## Failure cases

| Input | HTTP result | Enqueued | Observation |
| --- | ---: | --- | --- |
| Nonexistent public hostname | 500 | no | Safe generic `INTERNAL_SERVER_ERROR`; no DNS details or stack exposed |
| `http://127.0.0.1` | 400 | no | `INVALID_PUBLIC_DOMAIN` before enqueue |
| `http://localhost` | 400 | no | `INVALID_PUBLIC_DOMAIN` before enqueue |
| `file:///etc/passwd` | 400 | no | `INVALID_PUBLIC_DOMAIN` before enqueue |
| Clearly invalid text | 400 | no | `INVALID_URL` before enqueue |

The nonexistent hostname behavior is safe and matches the current preflight-first policy, but its generic 500 message is less actionable than a dedicated public hostname resolution error. No raw exception, stack, internal address, or retry detail reached the client.

## Worker restart

Three HTML jobs were enqueued in the persistent temporary database. A worker claimed the first job; after the database showed `running`, it received SIGTERM. The worker finished the active job and exited with code 0. A new worker process reopened the same database and completed the remaining two queued jobs. All three finished on attempt one with distinct linked audits.

This validates graceful restart persistence. Forced crash and expired-lease recovery remain covered by the deterministic resilience suite and were intentionally not repeated with `kill -9`.

## Database integrity

- HTML environment: 19 jobs, 19 audits, `PRAGMA integrity_check = ok`.
- Rendered environment: 3 jobs, 3 audits, `PRAGMA integrity_check = ok`.
- Completed jobs without `audit_id`: 0.
- Failed jobs with `audit_id`: 0.
- Missing audit references: 0.
- Orphan audits: 0.
- Duplicate audit links: 0.
- Running jobs after the test: 0.
- Expired leases after the test: 0.

## Bugs found and fixed

No reproducible async runtime bug was found, so production code and scoring were not changed. The NXDOMAIN response noted above is a non-blocking UX limitation and improvement candidate, not a queue integrity or worker recovery defect.

## Remaining risks

- SQLite is still a single-writer beta persistence choice; the recommended deployment remains one worker process.
- Rendered audit memory has a significant one-time/runtime footprint and should be monitored during a longer beta soak.
- Three single-run Lighthouse observations cannot establish long-term browser memory behavior or metric stability.
- Application-level browser network filtering does not replace production egress isolation for Chromium.
- Some public sites may block automation or fail subresources; current full-result/fallback behavior should continue to be monitored through telemetry.
- A nonexistent public hostname currently receives a safe but generic HTTP 500 response.

## Recommendation

**READY WITH CONDITIONS** for a small closed beta from the async runtime perspective.

Use one worker, rendered concurrency one, Chromium egress and container isolation, bounded host resources, and resource/telemetry monitoring. Review worker RSS, fallback/timeout rates, queue age, and SQLite busy errors during the beta before increasing traffic or worker count.
