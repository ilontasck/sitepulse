import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAuthService } from "../src/auth/auth-service.mjs";
import { hashSessionToken } from "../src/auth/session-token.mjs";
import { createAuthStore } from "../src/storage/auth-store.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";

const temporaryDirectories = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sitepulse-auth-service-"));
  temporaryDirectories.push(directory);
  const databaseFilePath = join(directory, "sitepulse.sqlite");
  runMigrations(databaseFilePath);
  let id = 0;
  const authStore = createAuthStore(databaseFilePath, {
    clock: () => "2026-08-14T10:00:00.000Z",
    idGenerator: (kind) => `${kind}-${++id}`
  });
  const counters = { hash: 0, real: 0, dummy: 0 };
  const passwordService = {
    async hashPassword() {
      counters.hash += 1;
      return "encoded-valid-password-hash".padEnd(64, "x");
    },
    async verifyPassword(password, encodedHash) {
      counters.real += 1;
      return password === "correct horse battery staple" && encodedHash.startsWith("encoded-valid-password-hash");
    },
    async verifyDummyPassword() {
      counters.dummy += 1;
      return false;
    },
    needsRehash(encodedHash) {
      return !encodedHash.startsWith("encoded-valid-password-hash");
    }
  };
  const tokens = [1, 2, 3, 4].map((value) => Buffer.alloc(32, value).toString("base64url"));
  const authService = createAuthService({
    authStore,
    passwordService,
    clock: () => new Date("2026-08-14T10:00:00.000Z"),
    generateSessionToken: () => tokens.shift()
  });

  return { authService, authStore, counters };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("authentication service", () => {
  it("registers a normalized user and persists only the session-token hash", async () => {
    const { authService, authStore } = await fixture();
    const result = await authService.register({
      email: " Owner@Example.COM ",
      password: "correct horse battery staple"
    });

    assert.deepEqual(result.user, {
      id: "user-1",
      email: "Owner@Example.COM",
      createdAt: "2026-08-14T10:00:00.000Z"
    });
    assert.equal(result.sessionToken, Buffer.alloc(32, 1).toString("base64url"));
    assert.equal(result.sessionExpiresAt, "2026-08-28T10:00:00.000Z");
    assert.notEqual(await authStore.findActiveSessionByTokenHash(hashSessionToken(result.sessionToken)), null);
    assert.equal("passwordHash" in result.user, false);
  });

  it("uses the same generic failure with real or dummy verification", async () => {
    const { authService, counters } = await fixture();
    await authService.register({ email: "owner@example.com", password: "correct horse battery staple" });

    for (const credentials of [
      { email: "owner@example.com", password: "wrong password value" },
      { email: "missing@example.com", password: "wrong password value" }
    ]) {
      await assert.rejects(
        authService.login(credentials),
        (error) => error?.code === "INVALID_CREDENTIALS" && error.message === "Email or password is incorrect."
      );
    }

    assert.equal(counters.real, 1);
    assert.equal(counters.dummy, 1);
  });

  it("rotates only the presented session and authenticates the fresh token", async () => {
    const { authService } = await fixture();
    const registered = await authService.register({
      email: "owner@example.com",
      password: "correct horse battery staple"
    });
    const loggedIn = await authService.login({
      email: "owner@example.com",
      password: "correct horse battery staple",
      previousSessionToken: registered.sessionToken
    });

    assert.equal(await authService.authenticate(registered.sessionToken), null);
    assert.deepEqual(await authService.authenticate(loggedIn.sessionToken), loggedIn.user);
    assert.equal(await authService.logout(loggedIn.sessionToken), true);
    assert.equal(await authService.logout(loggedIn.sessionToken), false);
    assert.equal(await authService.authenticate(loggedIn.sessionToken), null);
  });
});
