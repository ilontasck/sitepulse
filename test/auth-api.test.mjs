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
        PUBLIC_ORIGIN: "https://sitepulse.example"
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
