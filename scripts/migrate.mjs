import { loadConfig } from "../src/config/env.mjs";
import { runMigrations } from "../src/storage/migrations.mjs";

const config = loadConfig();
const migrations = runMigrations(config.databaseFilePath);

console.log(JSON.stringify({
  type: "noqori.migration",
  outcome: "success",
  appliedVersion: migrations.at(-1)?.version ?? 0
}));
