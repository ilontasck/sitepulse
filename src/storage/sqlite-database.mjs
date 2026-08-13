import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(databaseFilePath) {
  mkdirSync(dirname(databaseFilePath), { recursive: true });
  const database = new DatabaseSync(databaseFilePath);

  try {
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA busy_timeout = 5000;");
  } catch (error) {
    database.close();
    throw error;
  }

  return database;
}

export function withDatabase(databaseFilePath, callback) {
  const database = openDatabase(databaseFilePath);

  try {
    const result = callback(database);

    if (result && typeof result.then === "function") {
      throw new TypeError("SQLite database callbacks must be synchronous.");
    }

    return result;
  } finally {
    database.close();
  }
}

export function withImmediateTransaction(database, callback) {
  database.exec("BEGIN IMMEDIATE;");

  try {
    const result = callback(database);

    if (result && typeof result.then === "function") {
      throw new TypeError("SQLite transaction callbacks must be synchronous.");
    }

    database.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the original transaction error if SQLite already rolled back.
    }

    throw error;
  }
}
