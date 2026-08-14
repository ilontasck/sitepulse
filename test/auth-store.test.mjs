import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { toPublicUser } from "../src/auth/public-user.mjs";
import { createAuthStore } from "../src/storage/auth-store.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";

const temporaryDirectories = [];

async function createFixture({ now = "2026-08-14T10:00:00.000Z" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sitepulse-auth-store-"));
  temporaryDirectories.push(directory);
  const databaseFilePath = join(directory, "sitepulse.sqlite");
  runMigrations(databaseFilePath);
  let id = 0;
  let currentTime = now;
  const store = createAuthStore(databaseFilePath, {
    clock: () => currentTime,
    idGenerator: (kind) => `${kind}-${++id}`
  });

  return {
    databaseFilePath,
    store,
    setTime(value) {
      currentTime = value;
    }
  };
}

function registration({
  emailOriginal = "Owner@example.com",
  emailNormalized = "owner@example.com",
  sessionTokenHash = Buffer.alloc(32, 1),
  sessionExpiresAt = "2026-08-28T10:00:00.000Z"
} = {}) {
  return {
    emailOriginal,
    emailNormalized,
    passwordHash: "p".repeat(64),
    sessionTokenHash,
    sessionExpiresAt
  };
}

function inspect(databaseFilePath, callback) {
  const database = new DatabaseSync(databaseFilePath);
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    return callback(database);
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("authentication storage", () => {
  it("atomically creates a user and active session without returning or storing a raw token", async () => {
    const { databaseFilePath, store } = await createFixture();
    const tokenHash = Buffer.alloc(32, 7);
    const created = await store.createUserWithSession(registration({ sessionTokenHash: tokenHash }));
    const user = await store.findUserByNormalizedEmail("owner@example.com");
    const active = await store.findActiveSessionByTokenHash(tokenHash);
    const stored = inspect(databaseFilePath, (database) => database.prepare("SELECT typeof(token_hash) AS type, length(token_hash) AS length FROM sessions").get());

    assert.equal(created.user.id, "user-1");
    assert.equal(created.session.id, "session-2");
    assert.equal(user.passwordHash, "p".repeat(64));
    assert.deepEqual(active.user, user);
    assert.equal("tokenHash" in active.session, false);
    assert.deepEqual({ ...stored }, { type: "blob", length: 32 });
    assert.deepEqual(toPublicUser(user), {
      id: "user-1",
      email: "Owner@example.com",
      createdAt: "2026-08-14T10:00:00.000Z"
    });
  });

  it("keeps user creation atomic when email or session uniqueness fails", async () => {
    const { store } = await createFixture();
    const sharedHash = Buffer.alloc(32, 4);
    await store.createUserWithSession(registration({ sessionTokenHash: sharedHash }));

    await assert.rejects(
      store.createUserWithSession(registration({
        emailOriginal: "OWNER@example.com",
        emailNormalized: "owner@example.com",
        sessionTokenHash: Buffer.alloc(32, 5)
      })),
      (error) => error?.code === "EMAIL_ALREADY_EXISTS" && !error.message.includes("owner@example.com")
    );
    await assert.rejects(
      store.createUserWithSession(registration({
        emailOriginal: "Second@example.com",
        emailNormalized: "second@example.com",
        sessionTokenHash: sharedHash
      })),
      (error) => error?.code === "AUTH_STORAGE_CONSTRAINT"
    );

    assert.equal(await store.findUserByNormalizedEmail("second@example.com"), null);
  });

  it("rejects expired, revoked, and disabled sessions", async () => {
    const fixture = await createFixture();
    const tokenHash = Buffer.alloc(32, 8);
    const created = await fixture.store.createUserWithSession(registration({
      sessionTokenHash: tokenHash,
      sessionExpiresAt: "2026-08-15T10:00:00.000Z"
    }));

    assert.notEqual(await fixture.store.findActiveSessionByTokenHash(tokenHash), null);
    assert.equal(await fixture.store.revokeSessionByTokenHash(tokenHash), true);
    assert.equal(await fixture.store.revokeSessionByTokenHash(tokenHash), false);
    assert.equal(await fixture.store.findActiveSessionByTokenHash(tokenHash), null);

    const freshHash = Buffer.alloc(32, 9);
    await fixture.store.rotateSession({
      userId: created.user.id,
      newTokenHash: freshHash,
      newExpiresAt: "2026-08-15T10:00:00.000Z"
    });
    inspect(fixture.databaseFilePath, (database) => {
      database.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run("2026-08-14T10:05:00.000Z", created.user.id);
    });
    assert.equal(await fixture.store.findActiveSessionByTokenHash(freshHash), null);

    inspect(fixture.databaseFilePath, (database) => {
      database.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(created.user.id);
    });
    fixture.setTime("2026-08-16T10:00:00.000Z");
    assert.equal(await fixture.store.findActiveSessionByTokenHash(freshHash), null);
  });

  it("rotates only the presented session and leaves other sessions active", async () => {
    const { store } = await createFixture();
    const firstHash = Buffer.alloc(32, 10);
    const secondHash = Buffer.alloc(32, 11);
    const thirdHash = Buffer.alloc(32, 12);
    const fourthHash = Buffer.alloc(32, 13);
    const created = await store.createUserWithSession(registration({ sessionTokenHash: firstHash }));
    await store.rotateSession({
      userId: created.user.id,
      newTokenHash: secondHash,
      newExpiresAt: "2026-08-28T10:00:00.000Z"
    });
    await store.rotateSession({
      userId: created.user.id,
      previousTokenHash: firstHash,
      newTokenHash: thirdHash,
      newExpiresAt: "2026-08-28T10:00:00.000Z"
    });
    await store.rotateSession({
      userId: created.user.id,
      previousTokenHash: Buffer.alloc(32, 99),
      newTokenHash: fourthHash,
      newExpiresAt: "2026-08-28T10:00:00.000Z"
    });

    assert.equal(await store.findActiveSessionByTokenHash(firstHash), null);
    assert.notEqual(await store.findActiveSessionByTokenHash(secondHash), null);
    assert.notEqual(await store.findActiveSessionByTokenHash(thirdHash), null);
    assert.notEqual(await store.findActiveSessionByTokenHash(fourthHash), null);
  });

  it("cleans sessions in bounded batches and preserves cascade deletion", async () => {
    const fixture = await createFixture();
    const firstHash = Buffer.alloc(32, 20);
    const created = await fixture.store.createUserWithSession(registration({
      sessionTokenHash: firstHash,
      sessionExpiresAt: "2026-08-15T10:00:00.000Z"
    }));
    for (const value of [21, 22]) {
      await fixture.store.rotateSession({
        userId: created.user.id,
        newTokenHash: Buffer.alloc(32, value),
        newExpiresAt: "2026-08-15T10:00:00.000Z"
      });
    }
    const revokedHash = Buffer.alloc(32, 23);
    await fixture.store.rotateSession({
      userId: created.user.id,
      newTokenHash: revokedHash,
      newExpiresAt: "2026-08-28T10:00:00.000Z"
    });
    await fixture.store.revokeSessionByTokenHash(revokedHash);

    const firstBatch = await fixture.store.cleanupSessions({
      expiredBefore: "2026-08-16T10:00:00.000Z",
      revokedBefore: "2026-08-16T10:00:00.000Z",
      limit: 2
    });
    assert.equal(firstBatch, 2);
    assert.equal(inspect(fixture.databaseFilePath, (database) => database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count), 2);

    const secondBatch = await fixture.store.cleanupSessions({
      expiredBefore: "2026-08-16T10:00:00.000Z",
      revokedBefore: "2026-08-16T10:00:00.000Z",
      limit: 2
    });
    assert.equal(secondBatch, 2);

    await fixture.store.rotateSession({
      userId: created.user.id,
      newTokenHash: Buffer.alloc(32, 24),
      newExpiresAt: "2026-08-28T10:00:00.000Z"
    });

    inspect(fixture.databaseFilePath, (database) => database.prepare("DELETE FROM users WHERE id = ?").run(created.user.id));
    assert.equal(inspect(fixture.databaseFilePath, (database) => database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count), 0);
  });
});
