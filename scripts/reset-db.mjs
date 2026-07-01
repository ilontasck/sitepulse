import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../src/config/env.mjs";

const config = loadConfig();
const databasePath = resolve(config.databaseFilePath);
const files = [databasePath, `${databasePath}-shm`, `${databasePath}-wal`];

for (const file of files) {
  await rm(file, { force: true });
}

console.log(`Reset local SQLite database: ${databasePath}`);
