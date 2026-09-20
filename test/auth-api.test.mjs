import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { AuthCapacityError } from "../src/auth/auth-errors.mjs";
import { createPasswordService } from "../src/auth/password.mjs";
import { loadConfig } from "../src/config/env.mjs";
import { createApp } from "../src/http/app.mjs";
import { createAuthStore } from "../src/storage/auth-store.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";
import { withDatabase } from "../src/storage/sqlite-database.mjs";

const runningApis = [];
const publicOrigin = "http://sitepulse.test";

function fastPasswordService(onDerive = () => {}) {
  return createPasswordService({
    deriveKey(passwordBytes, salt, { keyLength }) {
      onDerive();
      return Promise.resolve(createHash("sha512").update(passwordBytes).update(salt).digest().subarray(0, keyLength));
    }
  });
}

async function startApi({ configOverrides = {}, dependencies = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sitepulse-auth-api-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: 0,
    PUBLIC_ORIGIN: publicOrigin,
    RATE_LIMIT_MAX: 500,
    AUTH_REGISTER_RATE_LIMIT_MAX: 100,
    AUTH_LOGIN_RATE_LIMIT_MAX: 100,
    AUTH_GENERAL_RATE_LIMIT_MAX: 500,
    AUTH_REGISTRATION_MODE: "public",
    DATABASE_FILE_PATH: join(directory, "sitepulse.sqlite"),
    ...configOverrides
  });
  runMigrations(config.databaseFilePath);
  const authStore = dependencies.authStore || createAuthStore(config.databaseFilePath);
  const passwordService = dependencies.passwordService || fastPasswordService();
  const server = createApp(config, { authStore, passwordService, ...dependencies });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const api = {
    authStore,
    baseUrl: `http://127.0.0.1:${address.port}`,
    config,
    directory,
    server
  };
  runningApis.push(api);
  return api;
}

async function stopApi(api) {
  if (!api) return;
  await new Promise((resolve) => api.server.close(resolve));
  rmSync(api.directory, { recursive: true, force: true });
  const index = runningApis.indexOf(api);
  if (index >= 0) runningApis.splice(index, 1);
}

function sessionTokenFrom(response) {
  const header = response.headers.get("set-cookie");
  return header?.split(";", 1)[0].split("=", 2)[1] || null;
}

function authRequest(api, path, { method = "POST", body = {}, cookie, origin = publicOrigin, contentType = "application/json" } = {}) {
  const headers = {};
  if (origin !== null) headers.Origin = origin;
  if (contentType !== null) headers["Content-Type"] = contentType;
  if (cookie) headers.Cookie = `sitepulse_session=${cookie}`;
  return fetch(`${api.baseUrl}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body)
  });
}

async function register(api, email = "Owner@example.com") {
  return authRequest(api, "/api/auth/register", {
    body: { email, password: "correct horse battery staple" }
  });
}

afterEach(async () => {
  await Promise.all([...runningApis].map(stopApi));
});

describe("authentication HTTP API", () => {
  it("exposes registration availability without secrets and fails closed", async () => {
    const closedApi = await startApi({ configOverrides: { AUTH_REGISTRATION_MODE: "closed" } });
    const configResponse = await authRequest(closedApi, "/api/auth/config", { method: "GET" });
    const configBody = await configResponse.json();
    const registrationResponse = await register(closedApi);
    const registrationBody = await registrationResponse.json();

    assert.equal(configResponse.status, 200);
    assert.equal(configResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(configBody, { registrationMode: "closed" });
    assert.equal(registrationResponse.status, 403);
    assert.deepEqual(registrationBody, {
      error: {
        code: "REGISTRATION_CLOSED",
        message: "Registration is currently closed."
      }
    });
    assert.equal(withDatabase(closedApi.config.databaseFilePath, (database) =>
      database.prepare("SELECT COUNT(*) AS count FROM users").get().count
    ), 0);

    const publicApi = await startApi();
    const publicConfigResponse = await authRequest(publicApi, "/api/auth/config", { method: "GET" });
    assert.deepEqual(await publicConfigResponse.json(), { registrationMode: "public" });
    assert.equal((await register(publicApi, "public@example.com")).status, 201);
  });

  it("registers safely, sets the development cookie, and persists no raw token", async () => {
    const telemetry = [];
    const api = await startApi({ dependencies: { telemetry: { record: (...entry) => telemetry.push(entry) } } });
    const response = await register(api);
    const body = await response.json();
    const cookieHeader = response.headers.get("set-cookie");
    const rawToken = sessionTokenFrom(response);
    const stored = withDatabase(api.config.databaseFilePath, (database) =>
      database.prepare("SELECT typeof(token_hash) AS type, length(token_hash) AS length, hex(token_hash) AS hash FROM sessions").get()
    );

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("location"), null);
    assert.match(cookieHeader, /^sitepulse_session=/);
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /SameSite=Lax/);
    assert.match(cookieHeader, /Path=\//);
    assert.doesNotMatch(cookieHeader, /Secure/);
    assert.deepEqual(Object.keys(body.user).sort(), ["createdAt", "email", "id"]);
    assert.equal(JSON.stringify(body).includes(rawToken), false);
    assert.equal(JSON.stringify(body).includes("password"), false);
    assert.deepEqual({ type: stored.type, length: stored.length }, { type: "blob", length: 32 });
    assert.notEqual(stored.hash.toLowerCase(), Buffer.from(rawToken).toString("hex"));
    assert.equal(JSON.stringify(telemetry).includes(rawToken), false);
    assert.equal(withDatabase(api.config.databaseFilePath, (database) =>
      database.prepare("SELECT plan_code FROM users WHERE id = ?").get(body.user.id).plan_code
    ), "free");
  });

  it("does not allow registration input or a public route to grant pro", async () => {
    const api = await startApi();
    const response = await authRequest(api, "/api/auth/register", {
      body: { email: "plan@example.com", password: "correct horse battery staple", plan: "pro", plan_code: "pro" }
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(withDatabase(api.config.databaseFilePath, (database) =>
      database.prepare("SELECT plan_code FROM users WHERE id = ?").get(body.user.id).plan_code
    ), "free");
    const mutation = await authRequest(api, "/api/auth/plan", { body: { plan: "pro" } });
    assert.equal(mutation.status, 404);
  });

  it("returns safe registration validation, duplicate, CSRF, media-type, capacity, and rate-limit errors", async () => {
    const api = await startApi();
    assert.equal((await register(api)).status, 201);
    const duplicate = await register(api, " owner@EXAMPLE.com ");
    const invalidEmail = await authRequest(api, "/api/auth/register", { body: { email: "bad", password: "correct horse battery staple" } });
    const invalidPassword = await authRequest(api, "/api/auth/register", { body: { email: "new@example.com", password: "short" } });
    const missingOrigin = await authRequest(api, "/api/auth/register", { origin: null, body: { email: "new@example.com", password: "correct horse battery staple" } });
    const wrongOrigin = await authRequest(api, "/api/auth/register", { origin: "https://evil.example", body: { email: "new@example.com", password: "correct horse battery staple" } });
    const wrongType = await authRequest(api, "/api/auth/register", { contentType: "text/plain", body: { email: "new@example.com", password: "correct horse battery staple" } });
    const multipart = await authRequest(api, "/api/auth/register", { contentType: "multipart/form-data; boundary=test", body: { email: "new@example.com", password: "correct horse battery staple" } });
    const charsetJson = await authRequest(api, "/api/auth/register", {
      contentType: "application/json; charset=utf-8",
      body: { email: "charset@example.com", password: "correct horse battery staple" }
    });

    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, "EMAIL_ALREADY_REGISTERED");
    assert.equal(invalidEmail.status, 400);
    assert.equal((await invalidEmail.json()).error.code, "INVALID_EMAIL");
    assert.equal(invalidPassword.status, 400);
    assert.equal((await invalidPassword.json()).error.code, "INVALID_PASSWORD");
    for (const response of [missingOrigin, wrongOrigin]) {
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, "CSRF_REJECTED");
    }
    assert.equal(wrongType.status, 415);
    assert.equal(multipart.status, 415);
    assert.equal(charsetJson.status, 201);

    const capacityApi = await startApi({
      dependencies: {
        passwordService: {
          hashPassword: async () => { throw new AuthCapacityError(); },
          verifyPassword: async () => false,
          verifyDummyPassword: async () => false,
          needsRehash: () => false
        }
      }
    });
    const capacity = await register(capacityApi, "capacity@example.com");
    assert.equal(capacity.status, 503);
    assert.equal((await capacity.json()).error.code, "AUTH_TEMPORARILY_UNAVAILABLE");
    assert.equal(capacity.headers.get("retry-after"), "2");

    const limitedApi = await startApi({ configOverrides: { AUTH_REGISTER_RATE_LIMIT_MAX: 1 } });
    assert.equal((await register(limitedApi, "first@example.com")).status, 201);
    const limited = await register(limitedApi, "second@example.com");
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, "RATE_LIMITED");
  });

  it("sets the __Host cookie with Secure in production", async () => {
    const api = await startApi({
      configOverrides: {
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "https://sitepulse.example",
        LEGAL_PUBLICATION_READY: "true",
        LEGAL_OPERATOR_NAME: "Example Operator",
        LEGAL_OPERATOR_ADDRESS_LINE1: "Example Street 1",
        LEGAL_OPERATOR_POSTAL_CODE: "12345",
        LEGAL_OPERATOR_CITY: "Example City",
        LEGAL_OPERATOR_COUNTRY: "Germany",
        LEGAL_CONTACT_EMAIL: "legal@example.test",
        LEGAL_PUBLICATION_DATE: "2026-09-20",
        LEGAL_HOSTING_PROVIDER: "Example Hosting",
        LEGAL_HOSTING_COUNTRY: "Germany",
        LEGAL_SERVER_LOCATION: "Example Region",
        LEGAL_PROCESS_LOG_RETENTION: "30 days",
        LEGAL_AUDIT_REPORT_RETENTION: "90 days"
      }
    });
    const response = await authRequest(api, "/api/auth/register", {
      origin: "https://sitepulse.example",
      body: { email: "prod@example.com", password: "correct horse battery staple" }
    });
    const header = response.headers.get("set-cookie");

    assert.equal(response.status, 201);
    assert.match(header, /^__Host-sitepulse_session=/);
    assert.match(header, /Secure/);
    assert.match(header, /HttpOnly/);
    assert.doesNotMatch(header, /Domain=/i);
  });

  it("uses indistinguishable login failures and one expensive path for wrong, missing, disabled, and malformed accounts", async () => {
    let derivations = 0;
    const api = await startApi({ dependencies: { passwordService: fastPasswordService(() => { derivations += 1; }) } });
    const registered = await register(api);
    assert.equal(registered.status, 201);

    const failures = [];
    const attempt = async (email, password = "wrong password value") => {
      const before = derivations;
      const response = await authRequest(api, "/api/auth/login", { body: { email, password } });
      failures.push({ response, body: await response.json(), derivations: derivations - before });
    };
    await attempt("owner@example.com");
    await attempt("missing@example.com");
    withDatabase(api.config.databaseFilePath, (database) =>
      database.prepare("UPDATE users SET disabled_at = ? WHERE email_normalized = ?").run(new Date().toISOString(), "owner@example.com")
    );
    await attempt("owner@example.com");
    withDatabase(api.config.databaseFilePath, (database) =>
      database.prepare("UPDATE users SET disabled_at = NULL, password_hash = ? WHERE email_normalized = ?").run("x".repeat(64), "owner@example.com")
    );
    await attempt("owner@example.com");

    for (const failure of failures) {
      assert.equal(failure.response.status, 401);
      assert.deepEqual(failure.body, { error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." } });
      assert.equal(failure.derivations, 1);
      assert.equal(failure.response.headers.get("cache-control"), "no-store");
    }
  });

  it("enforces the separate normalized-email login bucket", async () => {
    const api = await startApi({
      configOverrides: {
        AUTH_LOGIN_RATE_LIMIT_MAX: 100,
        AUTH_LOGIN_EMAIL_RATE_LIMIT_MAX: 2
      }
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await authRequest(api, "/api/auth/login", {
        body: { email: "Owner@Example.COM", password: "wrong password value" }
      });
      assert.equal(response.status, 401);
    }

    const limited = await authRequest(api, "/api/auth/login", {
      body: { email: " owner@example.com ", password: "wrong password value" }
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      error: { code: "RATE_LIMITED", message: "Too many requests. Please try again soon." }
    });
  });

  it("logs in with rotation while preserving unrelated sessions", async () => {
    const api = await startApi();
    const firstRegistration = await register(api);
    const firstToken = sessionTokenFrom(firstRegistration);
    const unrelatedLogin = await authRequest(api, "/api/auth/login", {
      body: { email: "owner@example.com", password: "correct horse battery staple" }
    });
    const unrelatedToken = sessionTokenFrom(unrelatedLogin);
    const rotatedLogin = await authRequest(api, "/api/auth/login", {
      cookie: firstToken,
      body: { email: "owner@example.com", password: "correct horse battery staple" }
    });
    const rotatedToken = sessionTokenFrom(rotatedLogin);
    const rotatedBody = await rotatedLogin.json();

    assert.equal(unrelatedLogin.status, 200);
    assert.equal(rotatedLogin.status, 200);
    assert.deepEqual(Object.keys(rotatedBody.user).sort(), ["createdAt", "email", "id"]);
    assert.equal(JSON.stringify(rotatedBody).includes(rotatedToken), false);
    assert.equal((await authRequest(api, "/api/auth/me", { method: "GET", cookie: firstToken, origin: null, contentType: null })).status, 401);
    assert.equal((await authRequest(api, "/api/auth/me", { method: "GET", cookie: unrelatedToken, origin: null, contentType: null })).status, 200);
    assert.equal((await authRequest(api, "/api/auth/me", { method: "GET", cookie: rotatedToken, origin: null, contentType: null })).status, 200);
  });

  it("enforces Origin, JSON content type, and the dedicated login rate limit", async () => {
    const api = await startApi({ configOverrides: { AUTH_LOGIN_RATE_LIMIT_MAX: 1 } });
    assert.equal((await register(api)).status, 201);
    const missingOrigin = await authRequest(api, "/api/auth/login", {
      origin: null,
      body: { email: "owner@example.com", password: "correct horse battery staple" }
    });
    assert.equal(missingOrigin.status, 403);

    const typeApi = await startApi();
    assert.equal((await register(typeApi)).status, 201);
    const wrongType = await authRequest(typeApi, "/api/auth/login", {
      contentType: "application/x-www-form-urlencoded",
      body: { email: "owner@example.com", password: "correct horse battery staple" }
    });
    assert.equal(wrongType.status, 415);

    const limitedApi = await startApi({ configOverrides: { AUTH_LOGIN_RATE_LIMIT_MAX: 1 } });
    assert.equal((await register(limitedApi)).status, 201);
    assert.equal((await authRequest(limitedApi, "/api/auth/login", {
      body: { email: "owner@example.com", password: "correct horse battery staple" }
    })).status, 200);
    const limited = await authRequest(limitedApi, "/api/auth/login", {
      body: { email: "owner@example.com", password: "correct horse battery staple" }
    });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, "RATE_LIMITED");
  });

  it("resolves only valid sessions through /me without exposing internals", async () => {
    const api = await startApi();
    const registered = await register(api);
    const token = sessionTokenFrom(registered);
    const valid = await authRequest(api, "/api/auth/me", { method: "GET", cookie: token, origin: null, contentType: null });
    const validBody = await valid.json();

    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get("cache-control"), "no-store");
    assert.deepEqual(Object.keys(validBody.user).sort(), ["createdAt", "email", "id"]);
    for (const cookie of [undefined, "malformed"]) {
      const response = await authRequest(api, "/api/auth/me", { method: "GET", cookie, origin: null, contentType: null });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, "AUTHENTICATION_REQUIRED");
    }

    withDatabase(api.config.databaseFilePath, (database) =>
      database.prepare("UPDATE sessions SET created_at = ?, expires_at = ?").run("2020-01-01T00:00:00.000Z", "2020-01-02T00:00:00.000Z")
    );
    assert.equal((await authRequest(api, "/api/auth/me", { method: "GET", cookie: token, origin: null, contentType: null })).status, 401);

    const disabledRegistration = await register(api, "disabled@example.com");
    const disabledToken = sessionTokenFrom(disabledRegistration);
    withDatabase(api.config.databaseFilePath, (database) =>
      database.prepare("UPDATE users SET disabled_at = ? WHERE email_normalized = ?").run(new Date().toISOString(), "disabled@example.com")
    );
    assert.equal((await authRequest(api, "/api/auth/me", { method: "GET", cookie: disabledToken, origin: null, contentType: null })).status, 401);
  });

  it("logs out idempotently, clears the cookie, and rejects missing Origin", async () => {
    const api = await startApi();
    const registered = await register(api);
    const token = sessionTokenFrom(registered);
    const logout = await authRequest(api, "/api/auth/logout", { cookie: token });

    assert.equal(logout.status, 204);
    assert.equal(logout.headers.get("cache-control"), "no-store");
    assert.match(logout.headers.get("set-cookie"), /^sitepulse_session=;/);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await authRequest(api, "/api/auth/me", { method: "GET", cookie: token, origin: null, contentType: null })).status, 401);
    assert.equal((await authRequest(api, "/api/auth/logout", { cookie: token })).status, 204);
    const expiredRegistration = await register(api, "expired@example.com");
    const expiredToken = sessionTokenFrom(expiredRegistration);
    withDatabase(api.config.databaseFilePath, (database) =>
      database.prepare("UPDATE sessions SET created_at = ?, expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email_normalized = ?)")
        .run("2020-01-01T00:00:00.000Z", "2020-01-02T00:00:00.000Z", "expired@example.com")
    );
    const expiredLogout = await authRequest(api, "/api/auth/logout", { cookie: expiredToken });
    assert.equal(expiredLogout.status, 204);
    assert.match(expiredLogout.headers.get("set-cookie"), /Max-Age=0/);
    const missingOrigin = await authRequest(api, "/api/auth/logout", { cookie: token, origin: null });
    assert.equal(missingOrigin.status, 403);
    assert.equal((await missingOrigin.json()).error.code, "CSRF_REJECTED");

    const failingApi = await startApi({
      dependencies: {
        authService: {
          authenticate: async () => null,
          logout: async () => { throw new Error("storage unavailable"); }
        }
      }
    });
    const failedLogout = await authRequest(failingApi, "/api/auth/logout", { cookie: token });
    const failedLogoutBody = await failedLogout.json();
    assert.equal(failedLogout.status, 500);
    assert.match(failedLogout.headers.get("set-cookie"), /Max-Age=0/);
    assert.deepEqual(failedLogoutBody, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Something went wrong." }
    });
  });

  it("accepts password reset requests uniformly and stores only a one-hour token hash", async () => {
    const deliveries = [];
    const api = await startApi({ dependencies: { deliverPasswordReset: async (delivery) => deliveries.push(delivery) } });
    assert.equal((await register(api)).status, 201);

    const existing = await authRequest(api, "/api/auth/password-reset/request", { body: { email: " Owner@Example.COM " } });
    const missing = await authRequest(api, "/api/auth/password-reset/request", { body: { email: "missing@example.com" } });
    const malformed = await authRequest(api, "/api/auth/password-reset/request", { body: { email: "not-an-email" } });

    for (const response of [existing, missing, malformed]) {
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { accepted: true });
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].email, "Owner@example.com");
    assert.equal(new Date(deliveries[0].expiresAt).getTime() - Date.now() > 3_500_000, true);
    const stored = withDatabase(api.config.databaseFilePath, (database) =>
      database.prepare(`
        SELECT typeof(token_hash) AS type, length(token_hash) AS length,
               hex(token_hash) AS hash, created_at, expires_at
        FROM password_reset_tokens
      `).get()
    );
    assert.deepEqual({ type: stored.type, length: stored.length }, { type: "blob", length: 32 });
    assert.equal(
      stored.hash.toLowerCase(),
      createHash("sha256").update(Buffer.from(deliveries[0].token, "base64url")).digest("hex")
    );
    assert.equal(new Date(stored.expires_at).getTime() - new Date(stored.created_at).getTime(), 60 * 60 * 1_000);

    const csrf = await authRequest(api, "/api/auth/password-reset/request", { origin: null, body: { email: "owner@example.com" } });
    assert.equal(csrf.status, 403);
    assert.equal((await csrf.json()).error.code, "CSRF_REJECTED");

    const failingDeliveryApi = await startApi({
      dependencies: { deliverPasswordReset: async () => { throw new Error("provider unavailable"); } }
    });
    assert.equal((await register(failingDeliveryApi, "delivery@example.com")).status, 201);
    const deliveryFailure = await authRequest(failingDeliveryApi, "/api/auth/password-reset/request", {
      body: { email: "delivery@example.com" }
    });
    assert.equal(deliveryFailure.status, 202);
    assert.deepEqual(await deliveryFailure.json(), { accepted: true });
  });

  it("resets the password once, revokes every session, and invalidates an earlier request", async () => {
    const deliveries = [];
    const api = await startApi({ dependencies: { deliverPasswordReset: async (delivery) => deliveries.push(delivery) } });
    const registration = await register(api);
    const registeredToken = sessionTokenFrom(registration);
    const secondLogin = await authRequest(api, "/api/auth/login", {
      body: { email: "owner@example.com", password: "correct horse battery staple" }
    });
    const secondSession = sessionTokenFrom(secondLogin);

    await authRequest(api, "/api/auth/password-reset/request", { body: { email: "owner@example.com" } });
    await authRequest(api, "/api/auth/password-reset/request", { body: { email: "owner@example.com" } });
    const [first, second] = deliveries;
    const invalidated = await authRequest(api, "/api/auth/password-reset/confirm", {
      body: { token: first.token, password: "new correct horse battery" }
    });
    assert.equal(invalidated.status, 400);
    assert.equal((await invalidated.json()).error.code, "INVALID_PASSWORD_RESET_TOKEN");

    const confirmed = await authRequest(api, "/api/auth/password-reset/confirm", {
      body: { token: second.token, password: "new correct horse battery" }
    });
    assert.equal(confirmed.status, 204);
    for (const token of [registeredToken, secondSession]) {
      assert.equal((await authRequest(api, "/api/auth/me", { method: "GET", cookie: token, origin: null, contentType: null })).status, 401);
    }
    const oldLogin = await authRequest(api, "/api/auth/login", {
      body: { email: "owner@example.com", password: "correct horse battery staple" }
    });
    const newLogin = await authRequest(api, "/api/auth/login", {
      body: { email: "owner@example.com", password: "new correct horse battery" }
    });
    assert.equal(oldLogin.status, 401);
    assert.equal(newLogin.status, 200);

    const reused = await authRequest(api, "/api/auth/password-reset/confirm", {
      body: { token: second.token, password: "another correct password" }
    });
    assert.equal(reused.status, 400);
    assert.equal((await reused.json()).error.code, "INVALID_PASSWORD_RESET_TOKEN");
  });

  it("rejects expired, invalid, malformed, and double-used tokens and rate-limits reset abuse", async () => {
    const deliveries = [];
    const api = await startApi({ dependencies: { deliverPasswordReset: async (delivery) => deliveries.push(delivery) } });
    assert.equal((await register(api)).status, 201);
    await authRequest(api, "/api/auth/password-reset/request", { body: { email: "owner@example.com" } });
    const expiredToken = deliveries[0].token;
    withDatabase(api.config.databaseFilePath, (database) => database.prepare(`
      UPDATE password_reset_tokens
      SET created_at = ?, expires_at = ?
    `).run("2020-01-01T00:00:00.000Z", "2020-01-01T01:00:00.000Z"));

    const validShapeInvalidToken = Buffer.alloc(32, 0x7f).toString("base64url");
    const csrf = await authRequest(api, "/api/auth/password-reset/confirm", {
      origin: null,
      body: { token: validShapeInvalidToken, password: "new correct horse battery" }
    });
    assert.equal(csrf.status, 403);
    assert.equal((await csrf.json()).error.code, "CSRF_REJECTED");
    for (const token of [expiredToken, validShapeInvalidToken, "malformed", "", null]) {
      const response = await authRequest(api, "/api/auth/password-reset/confirm", {
        body: { token, password: "new correct horse battery" }
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "INVALID_PASSWORD_RESET_TOKEN");
    }

    await authRequest(api, "/api/auth/password-reset/request", { body: { email: "owner@example.com" } });
    const freshToken = deliveries.at(-1).token;
    const attempts = await Promise.all([
      authRequest(api, "/api/auth/password-reset/confirm", { body: { token: freshToken, password: "first concurrent password" } }),
      authRequest(api, "/api/auth/password-reset/confirm", { body: { token: freshToken, password: "second concurrent password" } })
    ]);
    assert.deepEqual(attempts.map(({ status }) => status).sort(), [204, 400]);

    const limitedApi = await startApi({
      configOverrides: { AUTH_LOGIN_RATE_LIMIT_MAX: 1, AUTH_LOGIN_EMAIL_RATE_LIMIT_MAX: 1 }
    });
    assert.equal((await authRequest(limitedApi, "/api/auth/password-reset/request", { body: { email: "one@example.com" } })).status, 202);
    const limited = await authRequest(limitedApi, "/api/auth/password-reset/request", { body: { email: "two@example.com" } });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, "RATE_LIMITED");
  });

  it("deletes an authenticated account only after password confirmation and immediately revokes access", async () => {
    const deliveries = [];
    const api = await startApi({ dependencies: { deliverPasswordReset: async (delivery) => deliveries.push(delivery) } });
    const registration = await register(api, "delete-me@example.com");
    const registrationBody = await registration.json();
    const firstSession = sessionTokenFrom(registration);
    const secondLogin = await authRequest(api, "/api/auth/login", {
      body: { email: "delete-me@example.com", password: "correct horse battery staple" }
    });
    const secondSession = sessionTokenFrom(secondLogin);
    await authRequest(api, "/api/auth/password-reset/request", { body: { email: "delete-me@example.com" } });
    const resetToken = deliveries[0].token;
    const reportId = "11111111-1111-4111-8111-111111111111";
    const jobId = "22222222-2222-4222-8222-222222222222";
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
    withDatabase(api.config.databaseFilePath, (database) => {
      database.prepare(`
        INSERT INTO audits (id, created_at, updated_at, normalized_url, domain, overall_score, scanner_mode, report_json, user_id, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(reportId, now, now, "https://delete.example.com", "delete.example.com", 80, "html", JSON.stringify({ id: reportId }), registrationBody.user.id, expiresAt);
      database.prepare(`
        INSERT INTO audit_jobs (id, status, normalized_url, audit_id, attempt_count, max_attempts, available_at, created_at, updated_at, completed_at, user_id)
        VALUES (?, 'completed', ?, ?, 1, 2, ?, ?, ?, ?, ?)
      `).run(jobId, "https://delete.example.com", reportId, now, now, now, now, registrationBody.user.id);
    });

    const unauthenticated = await authRequest(api, "/api/auth/account", { method: "DELETE", body: { password: "correct horse battery staple" } });
    const missingOrigin = await authRequest(api, "/api/auth/account", { method: "DELETE", cookie: firstSession, origin: null, body: { password: "correct horse battery staple" } });
    const missingPassword = await authRequest(api, "/api/auth/account", { method: "DELETE", cookie: firstSession, body: {} });
    const wrongPassword = await authRequest(api, "/api/auth/account", { method: "DELETE", cookie: firstSession, body: { password: "wrong password" } });
    assert.equal(unauthenticated.status, 401);
    assert.equal(missingOrigin.status, 403);
    for (const response of [missingPassword, wrongPassword]) {
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, "INVALID_CREDENTIALS");
    }

    const deleted = await authRequest(api, "/api/auth/account", {
      method: "DELETE",
      cookie: firstSession,
      body: { password: "correct horse battery staple" }
    });
    assert.equal(deleted.status, 204);
    assert.match(deleted.headers.get("set-cookie"), /Max-Age=0/);
    for (const token of [firstSession, secondSession]) {
      assert.equal((await authRequest(api, "/api/auth/me", { method: "GET", cookie: token, origin: null, contentType: null })).status, 401);
    }
    assert.equal((await authRequest(api, "/api/auth/login", {
      body: { email: "delete-me@example.com", password: "correct horse battery staple" }
    })).status, 401);
    assert.equal((await authRequest(api, "/api/auth/password-reset/confirm", {
      body: { token: resetToken, password: "replacement password" }
    })).status, 400);
    assert.equal((await authRequest(api, `/api/audits/${reportId}`, { method: "GET", cookie: secondSession, origin: null, contentType: null })).status, 401);
    assert.equal((await authRequest(api, `/api/audit-jobs/${jobId}`, { method: "GET", cookie: secondSession, origin: null, contentType: null })).status, 401);

    const state = withDatabase(api.config.databaseFilePath, (database) => ({
      user: database.prepare("SELECT disabled_at, deletion_requested_at, purge_after FROM users WHERE id = ?").get(registrationBody.user.id),
      activeSessions: database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND revoked_at IS NULL").get(registrationBody.user.id).count,
      activeResets: database.prepare("SELECT COUNT(*) AS count FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL AND invalidated_at IS NULL").get(registrationBody.user.id).count
    }));
    assert.equal(state.user.disabled_at, state.user.deletion_requested_at);
    assert.equal(new Date(state.user.purge_after).getTime() - new Date(state.user.deletion_requested_at).getTime() <= 30 * 24 * 60 * 60 * 1_000, true);
    assert.equal(state.activeSessions, 0);
    assert.equal(state.activeResets, 0);
  });

  it("requires authentication and trusted Origin for audit creation after ownership migration", async () => {
    const api = await startApi({ dependencies: { initialUrlSafetyValidator: async () => true } });
    const unauthenticated = await fetch(`${api.baseUrl}/api/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ websiteUrl: "example.com" })
    });
    const registration = await register(api, "audit-owner@example.com");
    const token = sessionTokenFrom(registration);
    const authenticated = await fetch(`${api.baseUrl}/api/audits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: publicOrigin,
        Cookie: `sitepulse_session=${token}`
      },
      body: JSON.stringify({ websiteUrl: "example.com" })
    });

    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).error.code, "AUTHENTICATION_REQUIRED");
    assert.equal(authenticated.status, 202);
  });
});
