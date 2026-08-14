# SitePulse Authentication and Audit Ownership Architecture

Status: approved design specification for Day 5 implementation planning.

Sources of truth:

- `docs/ASYNC_AUDIT_ARCHITECTURE.md`
- `docs/DAY4_REAL_WORLD_SOAK.md`

## Scope

Closed-beta v1 adds:

- email and password accounts;
- register, login, logout, and current-user endpoints;
- persistent server-side sessions carried by an HttpOnly cookie;
- mandatory authentication for new audit creation;
- ownership on audit jobs and completed audits;
- owner-only job and report reads;
- storage and indexes for a later current-user audit dashboard.

This design does not add runtime code in Day 5 Block 1. It deliberately excludes OAuth, magic links, email verification, password reset, MFA, roles, organizations, subscriptions, payments, user profiles, and dashboard UI.

## Current authentication state

SitePulse currently has no users, credentials, sessions, cookies, CSRF policy, or request authentication context. The only privileged mechanism is `ADMIN_API_KEY` on the operator audit-history endpoint. It is not a user identity system.

Current behavior:

- `POST /api/audits` is public and creates an unowned queued job.
- `GET /api/audit-jobs/:id` is public to anyone who knows the UUID.
- `GET /api/audits/:id` is public to anyone who knows the UUID.
- `GET /api/audits` requires the operator admin key.
- A single in-process IP limiter applies to all API routes at 60 requests per minute.
- JSON mutation bodies already require `application/json`.
- The server emits no CORS allow-origin headers and the frontend uses same-origin relative requests.
- The frontend is a single `index.html` with inline JavaScript and assumes audit creation is immediately available.
- The CSP contains `script-src 'self' 'unsafe-inline'`; this is weaker than desired once authenticated actions exist.

The current migrations are:

1. `001_initial_audits`: `audits` and its created/domain indexes.
2. `002_audit_jobs`: the persistent queue, leases, retries, foreign key to `audits`, and queue indexes.

The current completion transaction correctly fences the worker and atomically inserts an audit plus links its job. It currently selects only the job ID, so Day 5 must deepen that seam to select persisted ownership and copy it into the new audit row.

## Target authentication model

```text
browser
  -> register or login over same-origin HTTPS
  -> server verifies password asynchronously
  -> server inserts an opaque session and sets HttpOnly cookie

authenticated request
  -> cookie parser extracts opaque token
  -> token is hashed
  -> server resolves active session joined to enabled user
  -> request receives a minimal auth context { user }

authenticated audit flow
  -> POST /api/audits
  -> enqueue(normalizedUrl, authenticated user ID)
  -> worker claims persisted job
  -> worker completes audit
  -> completion transaction copies job.user_id to audits.user_id
```

The external auth module should be deep. HTTP routes call a small interface such as:

```js
auth.register({ email, password })
auth.login({ email, password, previousSessionToken })
auth.authenticate(sessionToken)
auth.logout(sessionToken)
```

Password format parsing, dummy verification, token generation/hashing, session rotation, disabled-user handling, and safe error mapping remain inside that module. SQLite is a local-substitutable dependency; tests use temporary SQLite databases through the same interface.

## Password storage

### Algorithm and parameters

Use Node's built-in asynchronous `crypto.scrypt()` through a Promise wrapper. Never use `scryptSync()` in an HTTP request.

Version 1 parameters:

- `N = 131072` (`2^17`)
- `r = 8`
- `p = 1`
- derived key length: 64 bytes
- random salt: 16 bytes from `crypto.randomBytes()`
- explicit `maxmem = 268435456` bytes (256 MiB)

The approximate core memory requirement is `128 * N * r = 134217728` bytes before implementation overhead. A compatibility probe on the supported Node runtime confirms that 128 MiB is rejected as insufficient while 256 MiB succeeds. Therefore maxmem must be explicit; Node's much smaller default is incompatible with this profile.

Because each hash is memory-expensive, the web process must also use a small in-process scrypt concurrency limiter configured by `AUTH_SCRYPT_MAX_CONCURRENCY`. The closed-beta default is `1`, so a small host shared with the rendered worker has at most one active scrypt operation per web process. The limiter must not create an unbounded wait queue: when capacity is occupied, it returns a bounded overload outcome that the auth HTTP layer can map to a safe temporary-unavailable response. The exact HTTP status and retry policy will be defined in the auth implementation block. The configured concurrency may be increased later only after observing real memory and latency under load. Route rate limits remain the first defense.

### Versioned format

Store one self-describing ASCII value in `users.password_hash`:

```text
sitepulse:scrypt:v1:131072:8:1:64:<salt-base64url>:<digest-base64url>
```

The parser must:

- accept only known algorithm/version identifiers;
- parse strict decimal parameters;
- validate parameters against safe upper and lower bounds before allocating memory;
- require exactly 16 salt bytes and 64 digest bytes for v1;
- reject malformed base64url and extra fields;
- never fall back to attacker-controlled parameters.

`maxmem` is a verifier resource guard, not part of the cryptographic result. V1 always uses the code-defined 256 MiB guard. A future version may use new parameters and a different guard. After a successful login, `needsRehash()` may derive the current preferred format and update the hash with a conditional `WHERE id = ? AND password_hash = ?` update.

### Password input policy

- Input must be a JavaScript string.
- Minimum: 12 Unicode code points.
- Maximum: 128 UTF-8 bytes.
- Reject unpaired UTF-16 surrogates so distinct inputs cannot collapse to replacement characters during UTF-8 encoding.
- Do not trim, case-fold, or Unicode-normalize passwords.
- Allow spaces, Unicode, and password-manager generated values.
- Do not require arbitrary uppercase, digit, or symbol composition rules.
- Encode exactly once with UTF-8 before scrypt.
- Never log, serialize, persist, or include the plaintext in telemetry/errors.

Verification derives a same-length candidate asynchronously and uses `crypto.timingSafeEqual()`. Login for nonexistent or disabled accounts performs the same scrypt operation against a fixed valid dummy hash before returning the generic failure. Raw exceptions and format details never reach the client.

## Email identity and migration 003

### Normalization

V1 account identity is `email_normalized`:

1. Require a string and trim only surrounding whitespace.
2. Reject control characters, internal whitespace, multiple `@` characters, empty local/domain parts, and an address longer than 254 characters.
3. Require an ASCII local part in v1.
4. Convert an internationalized domain with Node's IDNA `domainToASCII()`, reject an invalid result, and lowercase it.
5. Lowercase the ASCII local part as an explicit SitePulse account-identity decision.
6. Store the trimmed submitted form as `email_original` and the canonical form as `email_normalized`.

Intentionally do not:

- remove `+tag` suffixes;
- remove or reinterpret dots;
- apply Gmail/provider-specific aliases;
- query MX records or infer deliverability;
- Unicode-fold or visually de-confuse local parts;
- treat two provider addresses as the same unless the exact normalization above does so.

### Schema

Migration `003_users.mjs`:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email_original TEXT NOT NULL,
  email_normalized TEXT NOT NULL COLLATE BINARY,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  CHECK (length(email_original) BETWEEN 3 AND 254),
  CHECK (length(email_normalized) BETWEEN 3 AND 254),
  CHECK (email_normalized = lower(email_normalized)),
  CHECK (length(password_hash) BETWEEN 64 AND 512)
);

CREATE UNIQUE INDEX idx_users_email_normalized
  ON users (email_normalized);
```

Validation lives in the auth module; schema checks are defense in depth. IDs are UUIDs and timestamps are UTC ISO-8601 strings.

The only public user projection is:

```json
{
  "id": "uuid",
  "email": "submitted@example.com",
  "createdAt": "2026-08-14T10:00:00.000Z"
}
```

It never contains normalized email, password data, disabled state, session fields, or raw SQLite names.

## Persistent sessions and migration 004

### Token design

- Generate 32 random bytes with `crypto.randomBytes()`.
- Encode the raw cookie value as unpadded base64url (43 characters).
- The raw token exists only in process memory long enough to set the cookie and then in the browser cookie jar.
- Hash the token with SHA-256 and store the 32-byte digest as a SQLite BLOB.
- Never store or log the raw token.

Password hashing is unnecessary for session tokens because they have 256 bits of random entropy. Hashing prevents a stolen read-only database from directly becoming an active-session credential.

### Schema

Migration `004_sessions.mjs`:

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BLOB NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (length(token_hash) = 32),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE UNIQUE INDEX idx_sessions_token_hash
  ON sessions (token_hash);

CREATE INDEX idx_sessions_user_id
  ON sessions (user_id);

CREATE INDEX idx_sessions_active_expiry
  ON sessions (expires_at)
  WHERE revoked_at IS NULL;
```

No user-agent, IP address, location, device name, or request metadata is stored in v1. `last_seen_at` is omitted because an absolute TTL needs no sliding activity write and avoiding it removes write amplification from every authenticated request.

### Lifecycle

- Absolute TTL: 14 days; no sliding extension in v1.
- Registration creates the user and initial session in one short SQLite transaction after password hashing and token preparation complete.
- Every successful login generates a new token and session ID.
- If the request already has a SitePulse session, login atomically revokes that session and inserts the new one. Other sessions for the user remain valid.
- Multiple sessions per user are allowed.
- Logout is idempotent: revoke the presented active token if found and always clear the cookie.
- Expired or revoked sessions do not authenticate.
- A disabled user never authenticates; login returns `INVALID_CREDENTIALS`, current sessions are rejected, and the presented session may be revoked opportunistically.
- Session cleanup runs in bounded batches on web startup and at most once per hour in the web process. Delete expired sessions and revoked sessions older than a short retention window. No request waits on an unbounded cleanup.

The SQLite auth adapter owns atomic user-plus-session registration and session rotation. Separate shallow user/session pass-through stores are intentionally avoided until another caller needs an independent seam.

## Cookie contract

Production HTTPS cookie:

```text
__Host-sitepulse_session=<opaque-token>;
Path=/;
HttpOnly;
Secure;
SameSite=Lax;
Max-Age=1209600;
Expires=<same instant as sessions.expires_at>
```

Rules:

- Never set `Domain`; the `__Host-` prefix requires host-only scope.
- `Path=/` is required by the prefix.
- `Secure` is mandatory in production.
- `Max-Age` and `Expires` match the 14-day database expiry.
- Logout clears the same cookie name/path/security attributes with `Max-Age=0` and an expired date.
- Development over plain localhost uses unprefixed `sitepulse_session`, `Secure` off, `HttpOnly`, `Path=/`, and `SameSite=Lax`.
- Production startup must require a configured HTTPS `PUBLIC_ORIGIN`; cookie security is derived from the validated origin, not a loosely configurable boolean.
- Auth tokens never enter URL parameters, response JSON, localStorage, or sessionStorage.

`SameSite=Lax` allows users to follow normal links into SitePulse while blocking cookies on most cross-site subrequests and form POSTs. It is not the sole CSRF defense.

## CSRF and browser security

V1 remains strictly same-origin and sends no permissive CORS headers. Every state-changing endpoint (`register`, `login`, `logout`, and audit creation) must:

1. accept only its intended HTTP method;
2. require `Content-Type: application/json`;
3. parse only bounded JSON bodies;
4. require an `Origin` header exactly equal to validated `PUBLIC_ORIGIN`;
5. reject missing, `null`, malformed, or different origins with safe `403 CSRF_REJECTED`;
6. optionally reject contradictory `Sec-Fetch-Site` values as defense in depth, without using that header as the primary control.

Do not derive the trusted origin from `Host`, `X-Forwarded-Host`, or another caller-controlled forwarding header. Proxy handling must be explicitly configured at deployment.

A separate CSRF token is not required for the closed-beta v1 only while all of these conditions remain true:

- cookie `SameSite` is Lax or Strict;
- mutations are JSON-only;
- strict Origin validation runs before mutation;
- no cross-origin credentialed CORS is enabled;
- there are no form-encoded mutation routes;
- the app uses one trusted origin.

Add a synchronizer or double-submit CSRF token before allowing `SameSite=None`, credentialed cross-origin clients, multiple application origins, embedded cross-site use, or mutation routes that cannot enforce Origin plus JSON.

HttpOnly prevents script from reading the session cookie but does not stop CSRF or same-origin actions by injected JavaScript. Before enabling account UI for beta users, move inline JavaScript into a served `assets/` file and remove `'unsafe-inline'` from `script-src`. Keep output escaping and avoid inserting untrusted HTML.

## Auth API contract

All responses use the existing safe JSON error envelope. Authentication responses use `Cache-Control: no-store`.

### `POST /api/auth/register`

Request:

```json
{ "email": "owner@example.com", "password": "correct horse battery staple" }
```

Success: HTTP 201, set a fresh session cookie, return `{ "user": <public-user> }`.

Errors:

- `400 INVALID_EMAIL`
- `400 INVALID_PASSWORD`
- `409 EMAIL_ALREADY_REGISTERED`
- `429 RATE_LIMITED`
- `503 AUTH_TEMPORARILY_UNAVAILABLE` when the bounded hash limiter is saturated

The unique email constraint is authoritative for races. Registration necessarily reveals that an address cannot be registered; closed-beta rate limits reduce bulk enumeration. Avoid claiming stronger enumeration resistance until an email-verification or invitation flow exists.

### `POST /api/auth/login`

Request shape matches registration.

Success: HTTP 200, rotate to a fresh session cookie, return `{ "user": <public-user> }`.

Nonexistent email, wrong password, malformed stored hash, and disabled account all return:

```json
{
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Email or password is incorrect."
  }
}
```

Status is HTTP 401. The endpoint performs a real or dummy scrypt before this result and does not expose which condition occurred.

### `POST /api/auth/logout`

Requires same-origin JSON `{}`. Revoke the presented token if possible, clear the cookie, and return HTTP 204. Missing, invalid, expired, or already-revoked sessions also return 204.

### `GET /api/auth/me`

Active enabled session: HTTP 200 `{ "user": <public-user> }`.

Missing, expired, revoked, malformed, or disabled session: HTTP 401:

```json
{
  "error": {
    "code": "AUTHENTICATION_REQUIRED",
    "message": "Sign in to continue."
  }
}
```

Never return password hashes, salts, session IDs, session tokens/hashes, disabled timestamps, normalization internals, or database field names.

## Rate limiting

Keep a cheap coarse IP limiter before expensive body parsing and auth work, then add route-specific in-process buckets:

| Scope | Closed-beta default | Key |
| --- | --- | --- |
| Register | 5 per hour | remote IP |
| Login | 30 per 15 minutes and 10 per 15 minutes | remote IP and HMAC of normalized email |
| General authenticated API | 120 per minute | user ID, with IP fallback |
| Audit creation | 10 per hour | user ID plus a separate IP ceiling |
| Job polling | covered by general 120/min | user ID |

The per-process login limiter generates a random HMAC key at startup and stores only keyed email digests in memory. It never logs email addresses, passwords, cookies, credential bodies, or bucket keys. Login still returns generic `INVALID_CREDENTIALS` unless the request is rate-limited, in which case it returns safe `429 RATE_LIMITED` with `Retry-After`.

Extend the existing rate limiter with an injected key selector instead of duplicating four implementations. Continue ignoring caller-controlled forwarding headers until a trusted proxy is explicitly configured. In-process buckets are acceptable for one closed-beta web process; shared/distributed limiting is deferred.

## Audit ownership and migration 005

Migration `005_audit_ownership.mjs` adds nullable foreign keys so existing rows remain valid:

```sql
ALTER TABLE audit_jobs
  ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE audits
  ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;

CREATE INDEX idx_audit_jobs_user_created
  ON audit_jobs (user_id, created_at DESC, id DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX idx_audits_user_created
  ON audits (user_id, created_at DESC, id DESC)
  WHERE user_id IS NOT NULL;
```

`user_id` is relational metadata only; it is not added to `report_json` or public report objects.

New flow:

1. Auth middleware resolves the current user.
2. `POST /api/audits` ignores any client-supplied ownership field.
3. The route calls `jobStore.enqueue({ normalizedUrl, userId: auth.user.id })`.
4. Enqueue rejects a missing user ID for all new runtime jobs.
5. Claim returns the persisted job, including internal `userId`, to the worker core, but the audit generator does not need it.
6. `complete()` accepts the existing job/worker/lease/audit arguments and no user ID.
7. Inside its existing `BEGIN IMMEDIATE`, `complete()` selects `id, user_id` from the owned running job.
8. It inserts `audits.user_id` from that selected row.
9. It links the audit and completes the same owned job.
10. If ownership, insert, or update fails, the whole transaction rolls back.

The worker and generated audit cannot choose or override ownership. A malicious `audit.userId` property is ignored and never written to the relational owner column. Completion tests must prove `audit.user_id IS audit_job.user_id`, stale workers cannot create an audit, and a caller-supplied owner cannot alter the result.

The existing queue statuses, lease/retry algorithm, rendered concurrency, scanner behavior, report shape, and public safe job mapper otherwise remain unchanged.

## Authorization rules

- Static landing/auth pages and `GET /api/health` remain public.
- Register and login are public but rate-limited and CSRF-protected.
- Logout and `GET /api/auth/me` use the current session.
- `POST /api/audits` requires an enabled authenticated user.
- `GET /api/audit-jobs/:id` requires the owner. A valid session for another user receives the same `404 AUDIT_JOB_NOT_FOUND` as an unknown ID.
- `GET /api/audits/:id` requires the owner. A valid session for another user or a legacy NULL owner receives the same `404 AUDIT_NOT_FOUND` as an unknown ID.
- A missing/invalid session receives `401 AUTHENTICATION_REQUIRED` before resource lookup.
- `GET /api/audits` remains an operator endpoint protected only by `ADMIN_API_KEY`; a user session never grants operator history access.
- If operator report detail is needed, the existing admin key may explicitly authorize it. Legacy reports must never become visible merely because a user is logged in.
- Authenticated job, report, current-user, and future dashboard responses use `Cache-Control: private, no-store` so shared caches cannot retain private audit data.

Owner checks belong in storage queries such as `WHERE id = ? AND user_id = ?`, not in a route that first loads an arbitrary row and compares it later. This creates a narrow authorization seam and makes IDOR tests exercise the same interface as production.

## Legacy data and deployment

All existing `audits` and `audit_jobs` receive `user_id = NULL`. Do not delete them, assign them to the first registered user, infer owners from URLs, or backfill them from request history.

After auth launch:

- new HTTP-created jobs always have a non-NULL owner;
- recovered legacy queued/running jobs may finish with NULL owner;
- their completed audits also remain NULL through the same completion copy rule;
- ordinary authenticated users cannot read legacy NULL jobs or reports;
- operator access remains separate through the admin mechanism or direct maintenance tooling;
- old public report links intentionally stop resolving for ordinary visitors.

Closed-beta deployment should use a short maintenance window:

1. Stop accepting new jobs and preferably drain the queue.
2. Confirm no running jobs and take a database backup.
3. Stop the old web and worker processes.
4. Apply migrations 003-005.
5. Deploy ownership-aware worker and auth-required web code together.
6. Start the worker, then the web process.
7. Run auth, ownership, legacy privacy, async integration, and E2E smoke tests.

Do not allow an old worker to process newly owned jobs: it would not copy `user_id` into the audit. The maintenance-window deployment avoids mixed-version ownership loss.

A later cleanup migration may archive legacy NULL rows and rebuild ownership columns as `NOT NULL`; that is intentionally not part of v1.

## Guest mode decision

**Closed-beta v1 requires login for every new audit. Guest audit creation is disabled.**

This keeps ownership, per-user limits, future subscriptions, and dashboard history unambiguous. It also avoids creating a second guest-token ownership model that would later need account claiming or transfer rules.

Impact on the current product:

- the current audit form cannot submit until `/api/auth/me` succeeds;
- the frontend needs register/login/logout states and a safe signed-out prompt;
- the frontend continues using the existing async polling/report renderer after authentication;
- POST, polling, and report fetches remain relative same-origin requests, so the browser automatically sends the HttpOnly cookie;
- existing API and E2E fixtures must create users/sessions and assert cross-user denial;
- backend and frontend must ship together because unauthenticated POST changes from 202 to 401.

## Future current-user dashboard

The future endpoint is:

```text
GET /api/me/audits?limit=20&cursor=<opaque-cursor>
```

It returns only the current user's reports, newest first. Use keyset pagination over `(created_at DESC, id DESC)`, with a validated cursor containing the last timestamp and ID. Limit defaults to 20 and is constrained to 1-100. Cursor tampering cannot cross users because every query includes `user_id = ?`.

The partial `idx_audits_user_created` index in migration 005 supports this query without a later table scan or painful migration. Repeat-audit and delete behavior remain deferred; deletion must define retention and active-job semantics before implementation.

## Transaction boundaries

No password derivation, token generation, DNS, network, or browser work occurs inside SQLite transactions.

1. **Registration:** hash password and generate token outside SQLite; atomically insert user and initial session; set cookie only after commit.
2. **Login:** read user and run real/dummy scrypt outside a transaction; generate new token; atomically revoke the presented old session and insert the new session.
3. **Logout:** conditionally revoke the token in one short update; cookie clearing is always returned.
4. **Session authentication:** hash token, perform one indexed read joining enabled user; no write on every request.
5. **Enqueue:** insert job with authenticated `user_id`.
6. **Completion:** select persisted job owner, insert audit with the same owner, and complete/link the job in the existing fenced transaction.
7. **Cleanup:** delete a bounded batch of expired/old-revoked sessions in a short transaction.

If registration/session insertion or ownership completion fails, no cookie or completed report is emitted for an uncommitted transaction.

## Threat model

| Risk | V1 mitigation | Residual/deferred risk |
| --- | --- | --- |
| Credential stuffing / brute force | Memory-hard scrypt, per-IP and keyed-email limits, configurable scrypt concurrency cap (closed-beta default `1`), generic login failure | Shared limiter needed when web scales horizontally |
| Session fixation | Always issue a fresh random token on register/login; revoke the presented prior session | Revoke-all/devices UI deferred |
| Stolen database | Scrypt password hashes with random salts; only SHA-256 session-token hashes stored | Offline password guessing remains possible; backups need encryption/access control |
| Stolen cookie | HTTPS, Secure, HttpOnly, host-only cookie, 14-day absolute expiry, logout revocation | No device/session management or MFA in v1 |
| CSRF | SameSite=Lax, strict Origin match, JSON-only mutations, no credentialed CORS | Add CSRF token if deployment assumptions change |
| XSS | Output escaping, HttpOnly cookie, CSP; remove inline script allowance before auth beta | XSS can still perform actions even when cookie cannot be read |
| User enumeration | Generic login response and dummy hash; registration rate limit | Registration conflict still reveals unavailable email without verification/invites |
| Cross-user IDOR | Owner-scoped SQL queries; unauthorized resources look missing | Operator-key security remains a separate operational concern |
| Disabled users | Session lookup joins enabled user; login stays generic; sessions rejected/revoked | Admin disable interface deferred |
| Session expiry | Absolute DB expiry checked on every request; matching cookie expiry; cleanup | Clock synchronization is an operational requirement |
| SQL injection | Bound SQLite parameters; validated limits/cursors; no identifier interpolation from requests | Maintain this discipline in dashboard filters |
| Sensitive logging | Allowlisted telemetry; never log bodies, emails, passwords, cookies, hashes, or auth headers | External observability must preserve the allowlist |
| Timing attacks | Constant-time digest comparison and dummy scrypt for missing/disabled users | Network noise prevents perfect equality; keep code paths comparable |
| Auth resource exhaustion | Body/password caps, route limits, async scrypt, bounded hash concurrency | Memory footprint requires beta monitoring |

## File-by-file implementation plan

### New files

- `src/auth/password.mjs`: email-independent password policy, versioned scrypt encoding/parsing, async hash/verify, dummy verification, parameter caps, and rehash detection.
- `src/auth/email.mjs`: deterministic email validation and normalization.
- `src/auth/session.mjs`: token generation/hashing, cookie names/options, TTL rules, and strict cookie token parsing.
- `src/auth/auth-service.mjs`: deep register/login/authenticate/logout interface and safe auth-domain failures.
- `src/storage/auth-store.mjs`: one SQLite adapter for users and sessions, including atomic registration, session rotation, lookup joined to enabled user, revocation, conditional rehash update, and bounded cleanup.
- `src/http/auth-middleware.mjs`: resolve optional auth context and provide `requireAuthenticatedUser()` without exposing session internals.
- `src/http/auth-routes.mjs`: four auth endpoints and public-user mapping.
- `src/http/origin-policy.mjs`: strict configured-origin enforcement for JSON mutations.
- `src/storage/migrations/003_users.mjs`: users schema and unique email index.
- `src/storage/migrations/004_sessions.mjs`: sessions schema and lookup/cleanup indexes.
- `src/storage/migrations/005_audit_ownership.mjs`: nullable ownership columns and dashboard indexes.
- `test/password.test.mjs`, `test/auth-store.test.mjs`, `test/auth-api.test.mjs`, and `test/audit-ownership.test.mjs`: focused temporary-DB coverage.

### Existing files to change later

- `src/storage/migrations.mjs`: register migrations 003-005 in strict order.
- `src/config/env.mjs`: validate `PUBLIC_ORIGIN`, session TTL, auth rate limits, and `AUTH_SCRYPT_MAX_CONCURRENCY` (closed-beta default `1`); production requires HTTPS.
- `.env.example`: document non-secret auth settings and the production origin.
- `src/http/rate-limit.mjs`: accept safe injected key selectors and support route-specific buckets without trusting forwarding headers.
- `src/http/app.mjs`: compose auth storage/service, optional auth context, route-specific limiters, Origin policy, auth routes, and existing audit routes through injected dependencies.
- `src/http/audit-routes.mjs`: require auth for create/job/detail, enqueue the authenticated owner, use owner-scoped reads, and preserve operator history separately.
- `src/storage/audit-job-store.mjs`: persist `user_id`, normalize it in the internal job model, owner-scope HTTP reads, and copy persisted ownership during fenced completion without accepting a completion user ID.
- `src/storage/audit-record.mjs`: insert the relational owner supplied by the job-store transaction without adding it to report JSON.
- `src/storage/audit-store.mjs`: add owner-scoped detail and keyset list queries while retaining explicitly operator/internal methods where required.
- `src/http/security.mjs`: remove inline-script permission after frontend extraction and add any final auth response hardening.
- `assets/app.js` and `index.html`: extract current inline JavaScript, add register/login/logout/me UI state, gate the audit form, and retain the proven polling/report renderer.
- `worker.mjs` and `src/audit/audit-job-worker.mjs`: no auth logic; only consume the ownership-aware job-store interface. Tests confirm the worker cannot choose an owner.
- `README.md`, `MACHINE_SETUP.md`, and `PROJECT_HEALTH_REPORT.md`: document auth/session configuration, deployment ordering, and updated health status after implementation.
- Existing API, worker, store, migration, privacy, resilience, and E2E tests: add authenticated fixtures and preserve async/runtime regression coverage.

`package.json` needs no new authentication framework or password dependency; Node crypto is sufficient.

## Day 5 implementation order

1. Add migration tests, then migrations 003 users and 004 sessions plus migration-runner registration.
2. Implement/test email normalization and the versioned async password module, including 256 MiB maxmem and bounded hash concurrency.
3. Implement/test session token/cookie rules and the deep SQLite auth adapter, including atomic register/session creation and rotation.
4. Add config validation, strict Origin policy, route-specific rate limiting, auth middleware, and the four auth endpoints with API tests.
5. Add migration 005 and ownership tests; update enqueue, owner-scoped reads, and atomic job-to-audit owner copy.
6. Enforce owner authorization on job/report routes and add two-user IDOR plus legacy-NULL privacy tests.
7. Extract inline frontend JavaScript, tighten CSP, add auth UI/gating, and update E2E without changing the report renderer.
8. Update environment/docs, run the full unit/API/resilience/E2E suite, and perform a controlled authenticated web-plus-worker smoke on a temporary database.
9. Deploy through the documented maintenance window; do not run mixed old/new ownership-aware processes.

## Explicitly deferred

- OAuth/social login, magic links, email verification, invitations, password reset, and MFA.
- Roles, admin UI, organizations, teams, delegated audit access, and report sharing.
- Subscription, billing, quotas tied to plans, and payments.
- Guest audits, guest-to-account claiming, and public report links.
- Display names, avatars, profiles, preferences, and stored user-agent/IP metadata.
- Sliding sessions, remember-me choices, session/device management, and revoke-all UI.
- Password breach-list integration and automatic parameter upgrades beyond the versioned rehash seam.
- Dashboard UI, repeat audit, delete/retention workflows, and history analytics.
- Distributed sessions/rate limits, Redis, PostgreSQL, multiple web processes, and multiple workers.
